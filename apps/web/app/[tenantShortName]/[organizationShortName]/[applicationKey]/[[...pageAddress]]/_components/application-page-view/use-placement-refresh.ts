import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
  type RefObject,
} from "react";
import type { useRouter } from "next/navigation";
import { observeSettled, settledValue, type ChoiceInputPayload } from "@vortex/ui";
import {
  mountedRecordPinFrameSchema,
  isCurrentComponentRequestGeneration,
  nextComponentRequestGeneration,
  type ComponentRequestGeneration,
  containedComponentIdSchema,
  jsonValueSchema,
  recordIdSchema,
  revisionSchema,
} from "@vortex/platform/schema";
import { z } from "zod";
import type { ApplicationPageModel, PageDataState } from "../../../../../../_lib/application-page";
import { rereadApplicationPlacements } from "../../placement-refresh-action";
import {
  createMountedRecordPinWatchClient,
  readMountedRecordPinMemberships,
} from "../../../../../../_lib/mounted-record-pin-watch-client";
import type { RefreshedPlacementData, TableContinuationTarget, EditFormBaseline } from "./types";
import { useProjectionRefresh } from "./use-projection-refresh";
import type { PageAddress } from "./page-address";
import { boardPayloadFor, loadedBoardColumns } from "./placement-helpers";

const flowRefreshResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("available"),
    data: z.record(z.string(), z.record(z.string(), z.unknown())),
    editFormBaselines: z.record(z.string(), z.record(z.string(), jsonValueSchema).nullable()),
    subject: z.object({ recordId: recordIdSchema, revision: revisionSchema }).nullable(),
    content: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ kind: z.literal("reload") }),
  z.object({ kind: z.literal("unavailable") }),
  z.object({ kind: z.literal("temporarily_unavailable") }),
]);

type AcceptedPlacement = Readonly<{
  key: string;
  request: ComponentRequestGeneration;
  placementId: string;
  data: PageDataState;
  editFormBaseline: EditFormBaseline | null;
  subject?: ApplicationPageModel["subject"] | null;
}>;

const subscribeToNothing = (): (() => void) => () => undefined;
const afterHydration = (): boolean => true;
const duringServerRenderAndHydration = (): boolean => false;

export function usePlacementRefresh({
  currentPageKey,
  placementRequestsRef,
  navigationKey,
  application,
  address,
  router,
  model,
  choiceRequestIdsRef,
  setChoicePages,
  setDialogChoicePages,
  setRefreshedPlacementData,
  refreshedPlacementData,
}: Readonly<{
  currentPageKey: string | undefined;
  placementRequestsRef: RefObject<{
    base: string;
    key: string;
    generations: Map<string, ComponentRequestGeneration>;
  }>;
  navigationKey: string;
  application: ApplicationPageModel["invocation"];
  /** Every read names the page address as it is when the read starts. */
  address: PageAddress;
  router: ReturnType<typeof useRouter>;
  model: ApplicationPageModel;
  choiceRequestIdsRef: RefObject<Record<string, number>>;
  setChoicePages: Dispatch<SetStateAction<Readonly<Record<string, ChoiceInputPayload>>>>;
  setDialogChoicePages: Dispatch<SetStateAction<Readonly<Record<string, ChoiceInputPayload>>>>;
  setRefreshedPlacementData: Dispatch<SetStateAction<RefreshedPlacementData | undefined>>;
  refreshedPlacementData: RefreshedPlacementData | undefined;
}>) {
  /** Apply all placement reads through the same generation and choice invalidation path. */
  const applyAcceptedPlacements = useCallback(
    (
      scopeKey: string,
      accepted: readonly AcceptedPlacement[],
      loadedContent?: Readonly<Record<string, unknown>>,
      contentOnly = false,
    ) => {
      const scope = placementRequestsRef.current;
      if (scope.key !== scopeKey) return;
      const refreshedChoices = new Set(
        accepted
          .filter((entry) =>
            isCurrentComponentRequestGeneration(scope.generations.get(entry.key), entry.request),
          )
          .map((entry) => entry.placementId),
      );
      if (refreshedChoices.size > 0) {
        for (const stateKey of Object.keys(choiceRequestIdsRef.current))
          if (
            [...refreshedChoices].some((id) => stateKey === id || stateKey.endsWith(`\u0000${id}`))
          )
            choiceRequestIdsRef.current[stateKey] =
              (choiceRequestIdsRef.current[stateKey] ?? 0) + 1;
        setChoicePages((current) =>
          Object.fromEntries(Object.entries(current).filter(([id]) => !refreshedChoices.has(id))),
        );
        setDialogChoicePages((current) =>
          Object.fromEntries(
            Object.entries(current).filter(
              ([key]) => ![...refreshedChoices].some((id) => key.endsWith(`\u0000${id}`)),
            ),
          ),
        );
      }
      setRefreshedPlacementData((current) => {
        const live = placementRequestsRef.current;
        if (live.key !== scopeKey) return current;
        const same = current?.navigationKey === scopeKey;
        const data = { ...(same ? current.data : {}) };
        const editFormBaselines = { ...(same ? current.editFormBaselines : {}) };
        let subject = same ? current.subject : undefined;
        let changed = false;
        for (const entry of accepted) {
          if (!isCurrentComponentRequestGeneration(live.generations.get(entry.key), entry.request))
            continue;
          data[entry.placementId] = entry.data;
          editFormBaselines[entry.placementId] = entry.editFormBaseline;
          if (entry.subject !== undefined) subject = entry.subject;
          changed = true;
        }
        if (!changed && !(contentOnly && loadedContent !== undefined)) return current;
        const content = loadedContent ?? (same ? current.content : undefined);
        return {
          navigationKey: scopeKey,
          data,
          editFormBaselines,
          subject,
          ...(content === undefined ? {} : { content }),
        };
      });
    },
    [
      choiceRequestIdsRef,
      placementRequestsRef,
      setChoicePages,
      setDialogChoicePages,
      setRefreshedPlacementData,
    ],
  );
  const refreshPlacements = useCallback(
    async (
      placementIds: readonly string[],
      tableContinuation?: TableContinuationTarget,
      options?: Readonly<{ content?: true }>,
    ): Promise<void> => {
      const pageKey = currentPageKey;
      const requestScope = placementRequestsRef.current;
      // A callback retained by an earlier page must not start a read in the new page's scope.
      if (pageKey === undefined || requestScope.key !== navigationKey) return;
      if (
        tableContinuation !== undefined &&
        (placementIds.length !== 1 ||
          placementIds[0]?.toLowerCase() !== tableContinuation.placementId.toLowerCase())
      )
        return;
      const requests = new Map<string, ComponentRequestGeneration>();
      for (const placementId of new Set(placementIds)) {
        const parsedId = containedComponentIdSchema.safeParse(placementId);
        if (!parsedId.success) continue;
        const key = parsedId.data.toLowerCase();
        const request = nextComponentRequestGeneration(
          requestScope.generations.get(key),
          parsedId.data,
          requestScope.key,
        );
        requestScope.generations.set(key, request);
        requests.set(key, request);
      }
      if (requests.size === 0) {
        // A bound action may have no data placement to reread: the content projection is still
        // fetched, so its action-bound placements follow the action's availability.
        if (options?.content !== true) return;
        let contentResult: Awaited<ReturnType<typeof rereadApplicationPlacements>>;
        try {
          contentResult = await rereadApplicationPlacements(
            {
              tenantShortName: application.tenantShortName,
              organizationShortName: application.organizationShortName,
              applicationKey: application.applicationKey,
              pageKey,
              installationRevision: application.installationRevision,
              search: address.search(),
            },
            [],
            undefined,
            undefined,
            true,
          );
        } catch (error) {
          console.error("[page] placement content refresh failed", error);
          return;
        }
        if (placementRequestsRef.current.key !== requestScope.key) return;
        if (contentResult.kind === "reload") {
          router.refresh();
          return;
        }
        if (contentResult.kind !== "available" || contentResult.content === undefined) return;
        applyAcceptedPlacements(requestScope.key, [], contentResult.content, true);
        return;
      }
      // A refreshed board shows the same columns it showed: only those columns' cards are read.
      const shownData =
        refreshedPlacementData?.navigationKey === requestScope.key
          ? refreshedPlacementData.data
          : undefined;
      const boardReads = [...requests.values()].flatMap((request) => {
        const key = request.componentId.toLowerCase();
        const findIn = (data: Readonly<Record<string, PageDataState>> | undefined) =>
          Object.entries(data ?? {}).find(([candidate]) => candidate.toLowerCase() === key)?.[1];
        const board = boardPayloadFor(findIn(shownData) ?? findIn(model.data));
        const columns = board === undefined ? [] : loadedBoardColumns(board);
        return columns.length === 0
          ? []
          : [{ placementId: request.componentId, request: { columns } }];
      });
      const loadedData = new Map<string, PageDataState>();
      const loadedBaselines = new Map<string, EditFormBaseline | null>();
      const loadedSubjects = new Map<string, ApplicationPageModel["subject"] | null>();
      let loadedContent: Readonly<Record<string, unknown>> | undefined;
      const requestEntries = [...requests.entries()];
      for (let offset = 0; offset < requestEntries.length; offset += 500) {
        if (placementRequestsRef.current.key !== requestScope.key) return;
        const batch = requestEntries
          .slice(offset, offset + 500)
          .filter(([key, request]) =>
            isCurrentComponentRequestGeneration(requestScope.generations.get(key), request),
          );
        if (batch.length === 0) continue;

        let result: Awaited<ReturnType<typeof rereadApplicationPlacements>>;
        try {
          // Read only the requested placements under the viewer's current access.
          result = await rereadApplicationPlacements(
            {
              tenantShortName: application.tenantShortName,
              organizationShortName: application.organizationShortName,
              applicationKey: application.applicationKey,
              pageKey,
              installationRevision: application.installationRevision,
              search: address.search(),
            },
            batch.map(([, request]) => request.componentId),
            tableContinuation === undefined
              ? boardReads.filter((read) =>
                  batch.some(([, request]) => request.componentId === read.placementId),
                )
              : undefined,
            tableContinuation,
            options?.content,
          );
        } catch (error) {
          console.error("[page] placement refresh failed", error);
          result = { kind: "temporarily_unavailable" };
        }
        if (placementRequestsRef.current.key !== requestScope.key) return;
        if (result.kind === "reload") {
          if (
            batch.some(([key, request]) =>
              isCurrentComponentRequestGeneration(requestScope.generations.get(key), request),
            )
          ) {
            router.refresh();
            return;
          }
          continue;
        }

        if (result.kind === "available" && result.content !== undefined)
          loadedContent ??= result.content;
        for (const [key, request] of batch) {
          if (!isCurrentComponentRequestGeneration(requestScope.generations.get(key), request))
            continue;
          const data =
            result.kind === "available"
              ? Object.entries(result.data).find(
                  ([candidate]) => candidate.toLowerCase() === key,
                )?.[1]
              : undefined;
          const baseline =
            result.kind === "available"
              ? (Object.entries(result.editFormBaselines).find(
                  ([candidate]) => candidate.toLowerCase() === key,
                )?.[1] ?? null)
              : null;
          loadedData.set(key, data ?? { status: "error" });
          loadedBaselines.set(key, baseline);
          const displayKey =
            Object.keys(model.data).find((candidate) => candidate.toLowerCase() === key) ??
            request.componentId;
          if (Object.hasOwn(model.editFormBaselines, displayKey) || baseline !== null)
            loadedSubjects.set(key, result.kind === "available" ? result.subject : null);
        }
      }

      const accepted: AcceptedPlacement[] = [];
      for (const [key, request] of requests) {
        if (
          !loadedData.has(key) ||
          !isCurrentComponentRequestGeneration(requestScope.generations.get(key), request)
        )
          continue;
        const displayKey =
          Object.keys(model.data).find((candidate) => candidate.toLowerCase() === key) ??
          request.componentId;
        accepted.push({
          key,
          request,
          placementId: displayKey,
          data: loadedData.get(key) ?? { status: "error" },
          editFormBaseline: loadedBaselines.get(key) ?? null,
          ...(loadedSubjects.has(key) ? { subject: loadedSubjects.get(key) } : {}),
        });
      }
      if (accepted.length > 0) applyAcceptedPlacements(requestScope.key, accepted, loadedContent);
    },
    [
      address,
      application,
      applyAcceptedPlacements,
      currentPageKey,
      model.data,
      model.editFormBaselines,
      navigationKey,
      refreshedPlacementData,
      router,
    ],
  );
  const flowRefreshOrder = useRef<{
    key: string;
    next: number;
    contentApplied: number;
    applied: Map<string, { sequence: number; generation: ComponentRequestGeneration }>;
  }>({ key: navigationKey, next: 0, contentApplied: 0, applied: new Map() });
  if (flowRefreshOrder.current.key !== navigationKey)
    flowRefreshOrder.current = {
      key: navigationKey,
      next: 0,
      contentApplied: 0,
      applied: new Map(),
    };

  /** Capture generations when a flow request starts; only its still-current reply may paint. */
  const prepareFlowRefresh = useCallback(
    (placementIds: readonly string[]) => {
      const pageKey = currentPageKey;
      const scope = placementRequestsRef.current;
      if (pageKey === undefined || scope.key !== navigationKey) return undefined;
      const order = flowRefreshOrder.current;
      const sequence = ++order.next;
      const requests = new Map<
        string,
        {
          componentId: z.infer<typeof containedComponentIdSchema>;
          observed: ComponentRequestGeneration | undefined;
        }
      >();
      for (const placementId of new Set(placementIds)) {
        const parsed = containedComponentIdSchema.safeParse(placementId);
        if (!parsed.success) continue;
        const key = parsed.data.toLowerCase();
        requests.set(key, { componentId: parsed.data, observed: scope.generations.get(key) });
      }
      const shown =
        refreshedPlacementData?.navigationKey === scope.key
          ? refreshedPlacementData.data
          : undefined;
      const boardReads = [...requests.values()].flatMap((request) => {
        const key = request.componentId.toLowerCase();
        const find = (data: Readonly<Record<string, PageDataState>> | undefined) =>
          Object.entries(data ?? {}).find(([id]) => id.toLowerCase() === key)?.[1];
        const board = boardPayloadFor(find(shown) ?? find(model.data));
        const columns = board === undefined ? [] : loadedBoardColumns(board);
        return columns.length === 0
          ? []
          : [{ placementId: request.componentId, request: { columns } }];
      });
      return {
        request: {
          address: {
            tenantShortName: application.tenantShortName,
            organizationShortName: application.organizationShortName,
            applicationKey: application.applicationKey,
            pageKey,
            installationRevision: application.installationRevision,
            search: address.search(),
          },
          placementIds: [...requests.values()].map((entry) => entry.componentId),
          boardReads,
        },
        apply: (candidate: unknown) => {
          const result = flowRefreshResultSchema.parse(candidate);
          if (placementRequestsRef.current.key !== scope.key) return;
          if (result.kind === "reload") {
            router.refresh();
            return;
          }
          if (result.kind !== "available") throw new Error("FLOW_PLACEMENT_REFRESH_UNAVAILABLE");
          const accepted = [...requests.entries()].flatMap(([key, request]) => {
            const current = scope.generations.get(key);
            const previous = order.applied.get(key);
            if (
              (previous !== undefined && previous.sequence >= sequence) ||
              (current !== request.observed && current !== previous?.generation)
            )
              return [];
            const generation = nextComponentRequestGeneration(
              current,
              request.componentId,
              scope.key,
            );
            scope.generations.set(key, generation);
            order.applied.set(key, { sequence, generation });
            return [[key, generation] as const];
          });
          const content =
            result.content !== undefined && sequence > order.contentApplied
              ? result.content
              : undefined;
          if (content !== undefined) order.contentApplied = sequence;
          const entries: AcceptedPlacement[] = accepted.map(([key, request]) => {
            const placementId =
              Object.keys(model.data).find((candidate) => candidate.toLowerCase() === key) ??
              request.componentId;
            const data = Object.entries(result.data).find(
              ([candidate]) => candidate.toLowerCase() === key,
            )?.[1] ?? { status: "error" };
            const baseline =
              Object.entries(result.editFormBaselines).find(
                ([candidate]) => candidate.toLowerCase() === key,
              )?.[1] ?? null;
            return {
              key,
              request,
              placementId,
              data,
              editFormBaseline: baseline,
              ...(Object.hasOwn(model.editFormBaselines, placementId) || baseline !== null
                ? { subject: result.subject }
                : {}),
            };
          });
          applyAcceptedPlacements(scope.key, entries, content, requests.size === 0);
        },
      };
    },
    [
      address,
      application,
      applyAcceptedPlacements,
      currentPageKey,
      model.data,
      model.editFormBaselines,
      navigationKey,
      refreshedPlacementData,
      router,
    ],
  );
  const refreshTargetsForBinding = useCallback(
    (bindingId: string): readonly string[] => {
      const match = Object.entries(model.refreshPlacementsByBinding).find(
        ([candidate]) => candidate.toLowerCase() === bindingId.toLowerCase(),
      );
      return match?.[1] ?? [];
    },
    [model.refreshPlacementsByBinding],
  );
  // Placements the server sent before they had read: each settles on the response that carried
  // the page, so it never costs a second request. A newer page drops the earlier page's results.
  const [streamed, setStreamed] = useState<
    Readonly<{ owner: ApplicationPageModel["data"]; data: Readonly<Record<string, PageDataState>> }>
  >({ owner: model.data, data: {} });
  // The reads that had settled before the page's first render (the page was held for its primary
  // data), so that render already shows them instead of a loading state for one frame. Later
  // settlements arrive through `streamed`, so this runs once per model. While the server HTML is
  // hydrated no read counts as settled: the server rendered every streamed placement as loading,
  // and a read the stream delivered before hydration must not change that first client render
  // (React #418). The render right after hydration shows it.
  const hydrated = useSyncExternalStore(
    subscribeToNothing,
    afterHydration,
    duringServerRenderAndHydration,
  );
  const settledStreams = useMemo(() => {
    const settled: Record<string, PageDataState> = {};
    if (!hydrated) return settled;
    for (const [placementId, read] of Object.entries(model.streamedData ?? {})) {
      observeSettled(read);
      const state = settledValue(read);
      if (state !== undefined) settled[placementId] = state;
    }
    return settled;
  }, [hydrated, model.streamedData]);
  useEffect(() => {
    if (model.streamedData === undefined) return;
    let current = true;
    for (const [placementId, settled] of Object.entries(model.streamedData)) {
      // A read that had already settled when the page was shown is in the first render's data.
      if (Object.hasOwn(settledStreams, placementId)) continue;
      void settled.then((state) => {
        if (!current) return;
        setStreamed((prior) => ({
          owner: model.data,
          data: { ...(prior.owner === model.data ? prior.data : {}), [placementId]: state },
        }));
      });
    }
    return () => {
      current = false;
    };
  }, [model.data, model.streamedData, settledStreams]);
  const currentData = useMemo(() => {
    const served = {
      ...model.data,
      ...settledStreams,
      ...(streamed.owner === model.data ? streamed.data : {}),
    };
    return refreshedPlacementData?.navigationKey === navigationKey
      ? { ...served, ...refreshedPlacementData.data }
      : served;
  }, [model.data, navigationKey, refreshedPlacementData, settledStreams, streamed]);
  const currentTileDataRef = useRef(currentData);
  currentTileDataRef.current = currentData;
  const compositionRootRef = useRef<HTMLDivElement>(null);
  useProjectionRefresh(
    model.refreshWhileByPlacement,
    currentData,
    compositionRootRef,
    refreshPlacements,
  );
  const pinWatchClientRef = useRef<
    ReturnType<typeof createMountedRecordPinWatchClient> | undefined
  >(undefined);
  const pinRefreshRef = useRef(refreshPlacements);
  pinRefreshRef.current = refreshPlacements;
  useEffect(() => {
    const root = compositionRootRef.current;
    const frame = mountedRecordPinFrameSchema.safeParse({
      pageId: model.pageId,
      installationRevision: model.invocation.installationRevision,
      releaseKey: model.invocation.releaseKey,
    });
    if (root === null || !frame.success) return;
    let active = true;
    const isCurrent = (): boolean => active && placementRequestsRef.current.key === navigationKey;
    const client = createMountedRecordPinWatchClient({
      root,
      selectors: {
        tenantShortName: model.invocation.tenantShortName,
        organizationShortName: model.invocation.organizationShortName,
        applicationKey: model.invocation.applicationKey,
        pageKey: model.invocation.pageKey,
      },
      isCurrent,
      readMemberships: () =>
        !isCurrent() || model.bodyContentAvailable === false
          ? []
          : readMountedRecordPinMemberships(root, frame.data, currentTileDataRef.current),
      refreshPlacements: async (ids) => {
        if (isCurrent()) await pinRefreshRef.current(ids);
      },
    });
    pinWatchClientRef.current = client;
    return () => {
      active = false;
      if (pinWatchClientRef.current === client) pinWatchClientRef.current = undefined;
      client.dispose();
    };
  }, [model, navigationKey]);
  useEffect(() => {
    pinWatchClientRef.current?.reconcile();
  }, [currentData]);
  const pinActivationInFlightRef = useRef(false);
  const currentEditFormBaselines = useMemo(() => {
    const baselines = { ...model.editFormBaselines };
    if (refreshedPlacementData?.navigationKey === navigationKey)
      for (const [placementId, baseline] of Object.entries(
        refreshedPlacementData.editFormBaselines,
      )) {
        if (baseline === null) delete baselines[placementId];
        else baselines[placementId] = baseline;
      }
    return baselines;
  }, [model.editFormBaselines, navigationKey, refreshedPlacementData]);

  return {
    currentData,
    refreshPlacements,
    prepareFlowRefresh,
    refreshTargetsForBinding,
    currentEditFormBaselines,
    pinActivationInFlightRef,
    currentTileDataRef,
    compositionRootRef,
  };
}
