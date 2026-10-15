import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
} from "@vortex/platform/schema";
import type { ApplicationPageModel, PageDataState } from "../../../../../../_lib/application-page";
import { rereadApplicationPlacements } from "../../placement-refresh-action";
import {
  createMountedRecordPinWatchClient,
  readMountedRecordPinMemberships,
} from "../../../../../../_lib/mounted-record-pin-watch-client";
import type { RefreshedPlacementData, TableContinuationTarget, EditFormBaseline } from "./types";

export function usePlacementRefresh({
  currentPageKey,
  placementRequestsRef,
  navigationKey,
  application,
  currentSearch,
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
  currentSearch: string;
  router: ReturnType<typeof useRouter>;
  model: ApplicationPageModel;
  choiceRequestIdsRef: RefObject<Record<string, number>>;
  setChoicePages: Dispatch<SetStateAction<Readonly<Record<string, ChoiceInputPayload>>>>;
  setDialogChoicePages: Dispatch<SetStateAction<Readonly<Record<string, ChoiceInputPayload>>>>;
  setRefreshedPlacementData: Dispatch<SetStateAction<RefreshedPlacementData | undefined>>;
  refreshedPlacementData: RefreshedPlacementData | undefined;
}>) {
  const refreshPlacements = useCallback(
    async (
      placementIds: readonly string[],
      tableContinuation?: TableContinuationTarget,
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
      if (requests.size === 0) return;

      const loadedData = new Map<string, PageDataState>();
      const loadedBaselines = new Map<string, EditFormBaseline | null>();
      const loadedSubjects = new Map<string, ApplicationPageModel["subject"] | null>();
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
          result = await rereadApplicationPlacements(
            {
              tenantShortName: application.tenantShortName,
              organizationShortName: application.organizationShortName,
              applicationKey: application.applicationKey,
              pageKey,
              installationRevision: application.installationRevision,
              search: currentSearch,
            },
            batch.map(([, request]) => request.componentId),
            undefined,
            tableContinuation,
          );
        } catch {
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

      const accepted: {
        key: string;
        request: ComponentRequestGeneration;
        placementId: string;
        data: PageDataState;
        editFormBaseline: EditFormBaseline | null;
        subject?: ApplicationPageModel["subject"] | null;
      }[] = [];
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
      if (accepted.length === 0) return;
      const refreshedChoices = new Set(
        accepted
          .filter((entry) =>
            isCurrentComponentRequestGeneration(
              requestScope.generations.get(entry.key),
              entry.request,
            ),
          )
          .map((entry) => entry.placementId),
      );
      if (refreshedChoices.size > 0) {
        for (const stateKey of Object.keys(choiceRequestIdsRef.current))
          if (
            [...refreshedChoices].some(
              (placementId) =>
                stateKey === placementId || stateKey.endsWith(`\u0000${placementId}`),
            )
          )
            choiceRequestIdsRef.current[stateKey] =
              (choiceRequestIdsRef.current[stateKey] ?? 0) + 1;
        setChoicePages((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([placementId]) => !refreshedChoices.has(placementId)),
          ),
        );
        setDialogChoicePages((current) =>
          Object.fromEntries(
            Object.entries(current).filter(
              ([stateKey]) =>
                ![...refreshedChoices].some((placementId) =>
                  stateKey.endsWith(`\u0000${placementId}`),
                ),
            ),
          ),
        );
      }
      setRefreshedPlacementData((current) => {
        const liveScope = placementRequestsRef.current;
        if (liveScope?.key !== requestScope.key) return current;
        const data = { ...(current?.navigationKey === requestScope.key ? current.data : {}) };
        const editFormBaselines = {
          ...(current?.navigationKey === requestScope.key ? current.editFormBaselines : {}),
        };
        let subject = current?.navigationKey === requestScope.key ? current.subject : undefined;
        let changed = false;
        for (const entry of accepted) {
          if (
            !isCurrentComponentRequestGeneration(
              liveScope.generations.get(entry.key),
              entry.request,
            )
          )
            continue;
          data[entry.placementId] = entry.data;
          editFormBaselines[entry.placementId] = entry.editFormBaseline;
          if (entry.subject !== undefined) subject = entry.subject;
          changed = true;
        }
        return changed
          ? { navigationKey: requestScope.key, data, editFormBaselines, subject }
          : current;
      });
    },
    [
      application,
      currentPageKey,
      currentSearch,
      model.data,
      model.editFormBaselines,
      navigationKey,
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
  // settlements arrive through `streamed`, so this runs once per model.
  const settledStreams = useMemo(() => {
    const settled: Record<string, PageDataState> = {};
    for (const [placementId, read] of Object.entries(model.streamedData ?? {})) {
      observeSettled(read);
      const state = settledValue(read);
      if (state !== undefined) settled[placementId] = state;
    }
    return settled;
  }, [model.streamedData]);
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
    refreshTargetsForBinding,
    currentEditFormBaselines,
    pinActivationInFlightRef,
    currentTileDataRef,
    compositionRootRef,
  };
}
