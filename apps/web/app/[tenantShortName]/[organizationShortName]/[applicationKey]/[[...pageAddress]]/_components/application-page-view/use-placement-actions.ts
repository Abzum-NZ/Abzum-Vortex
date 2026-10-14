import { useCallback, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { useRouter } from "next/navigation";
import type {
  createFlowRuntime,
  parseTablePayload} from "@vortex/ui";
import type {
  DisplaySemanticEvent,
  FlowDispatchResult,
} from "@vortex/ui";
import {
  boardColumnContinuationRequestSchema,
  isCurrentComponentRequestGeneration,
  nextComponentRequestGeneration,
  type ComponentRequestGeneration,
  containedComponentIdSchema,
  recordIdSchema,
} from "@vortex/platform/schema";
import type {
  ApplicationPageModel,
  PlacementFlowBinding,
} from "../../../../../../_lib/application-page";
import { rereadApplicationPlacements } from "../../placement-refresh-action";
import type { Notice, RefreshedPlacementData, TableContinuationTarget } from "./types";
import { asComponentBinding } from "./event-values";
import {
  boardPayloadFor,
  boardBucketForSelector,
  mergeBoardContinuation,
} from "./placement-helpers";

export function usePlacementActions({
  applyDispatch,
  flowRuntime,
  formOwners,
  busy,
  placementRequestsRef,
  navigationKey,
  currentPageKey,
  currentData,
  boardContinuationInFlightRef,
  setRefreshedPlacementData,
  refreshPlacements,
  application,
  currentSearch,
  router,
  tableContinuationHistoryRef,
}: Readonly<{
  applyDispatch: (dispatch: Promise<FlowDispatchResult | undefined>, formPlacementId?: string, afterAccepted?: () => Promise<Notice | undefined>, sourceBindingId?: string) => Promise<void>;
  flowRuntime: ReturnType<typeof createFlowRuntime>;
  formOwners: Readonly<Record<string, string>>;
  busy: boolean;
  placementRequestsRef: RefObject<{ base: string; key: string; generations: Map<string, ComponentRequestGeneration> }>;
  navigationKey: string;
  currentPageKey: string | undefined;
  currentData: ApplicationPageModel["data"];
  boardContinuationInFlightRef: RefObject<Set<string>>;
  setRefreshedPlacementData: Dispatch<SetStateAction<RefreshedPlacementData | undefined>>;
  refreshPlacements: (placementIds: readonly string[], tableContinuation?: TableContinuationTarget) => Promise<void>;
  application: ApplicationPageModel["invocation"];
  currentSearch: string;
  router: ReturnType<typeof useRouter>;
  tableContinuationHistoryRef: RefObject<{ scopeKey: string; cursors: Map<string, Map<number, string>>; inFlight: Set<string> }>;
}>) {
  /**
   * Runs the flow bound to a display or action event through the same runtime as a form gesture.
   * The binding receives only the caller inputs it declares; the server fills the rest from the
   * installed binding and refuses anything else.
   */
  const runBinding = useCallback(
    (
      placementId: string,
      binding: PlacementFlowBinding,
      supplied: Record<string, unknown>,
      selectedRecordId?: string,
      /** The one record this gesture is about, when it is not the record the page shows. */
      gestureSubject?: Readonly<{ recordId: string; revision: number }>,
      afterAccepted?: () => Promise<Notice | undefined>,
    ) => {
      const callerInputs = { ...supplied };
      for (const selectedReadInput of binding.selectedReadInputs ?? []) {
        delete callerInputs[selectedReadInput.callerInputName];
        if (
          binding.recordTypeId === undefined ||
          binding.recordTypeId.toLowerCase() !== selectedReadInput.recordTypeId.toLowerCase()
        )
          continue;
        const parsedRecordId = recordIdSchema.safeParse(selectedRecordId);
        if (!parsedRecordId.success) continue;
        callerInputs[selectedReadInput.callerInputName] = {
          recordTypeId: binding.recordTypeId,
          recordId: parsedRecordId.data,
        };
      }
      return applyDispatch(
        flowRuntime.dispatch(
          asComponentBinding(placementId, binding),
          Object.fromEntries(
            Object.entries(callerInputs).filter(([name]) => binding.callerInputs.includes(name)),
          ),
          undefined,
          gestureSubject,
        ),
        formOwners[placementId],
        afterAccepted,
        binding.bindingId,
      );
    },
    [applyDispatch, formOwners, flowRuntime],
  );

  const continueBoardColumn = useCallback(
    async (placementId: string, event: DisplaySemanticEvent): Promise<boolean> => {
      if (
        busy ||
        event.event !== "page_changed" ||
        !("column" in event) ||
        typeof event.continuationToken !== "string"
      )
        return false;
      const parsedId = containedComponentIdSchema.safeParse(placementId);
      const continuation = boardColumnContinuationRequestSchema.safeParse({
        column: event.column,
        continuationToken: event.continuationToken,
      });
      const requestScope = placementRequestsRef.current;
      if (
        !parsedId.success ||
        !continuation.success ||
        requestScope.key !== navigationKey ||
        currentPageKey === undefined
      )
        return false;

      const displayId =
        Object.keys(currentData).find((candidate) =>
          candidate.toLowerCase() === parsedId.data.toLowerCase(),
        ) ?? parsedId.data;
      const currentBoard = boardPayloadFor(currentData[displayId]);
      const currentBucket =
        currentBoard === undefined
          ? undefined
          : boardBucketForSelector(currentBoard, continuation.data.column);
      if (
        currentBoard === undefined ||
        currentBucket?.page?.nextContinuationToken !== continuation.data.continuationToken
      )
        return false;

      const serialKey = `${requestScope.key}\u0000${parsedId.data.toLowerCase()}`;
      if (boardContinuationInFlightRef.current.has(serialKey)) return false;
      boardContinuationInFlightRef.current.add(serialKey);
      const request = nextComponentRequestGeneration(
        requestScope.generations.get(parsedId.data.toLowerCase()),
        parsedId.data,
        requestScope.key,
      );
      requestScope.generations.set(parsedId.data.toLowerCase(), request);

      const clearAndReload = (): false => {
        if (
          placementRequestsRef.current.key === requestScope.key &&
          isCurrentComponentRequestGeneration(
            requestScope.generations.get(parsedId.data.toLowerCase()),
            request,
          )
        ) {
          setRefreshedPlacementData((current) => {
            const liveScope = placementRequestsRef.current;
            if (liveScope.key !== requestScope.key) return current;
            const prior = current?.navigationKey === requestScope.key ? current : undefined;
            return {
              navigationKey: requestScope.key,
              data: { ...(prior?.data ?? {}), [displayId]: { status: "error" } },
              editFormBaselines: { ...(prior?.editFormBaselines ?? {}) },
              ...(prior?.subject === undefined ? {} : { subject: prior.subject }),
            };
          });
          void refreshPlacements([parsedId.data]);
        }
        return false;
      };

      try {
        let result: Awaited<ReturnType<typeof rereadApplicationPlacements>>;
        try {
          result = await rereadApplicationPlacements(
            {
              tenantShortName: application.tenantShortName,
              organizationShortName: application.organizationShortName,
              applicationKey: application.applicationKey,
              pageKey: currentPageKey,
              installationRevision: application.installationRevision,
              search: currentSearch,
            },
            [parsedId.data],
            { placementId: parsedId.data, request: continuation.data },
          );
        } catch {
          result = { kind: "temporarily_unavailable" };
        }
        if (
          placementRequestsRef.current.key !== requestScope.key ||
          !isCurrentComponentRequestGeneration(
            requestScope.generations.get(parsedId.data.toLowerCase()),
            request,
          )
        )
          return false;
        if (result.kind === "reload") {
          router.refresh();
          return false;
        }
        if (result.kind !== "available") return clearAndReload();

        const returnedData = Object.entries(result.data).find(
          ([candidate]) => candidate.toLowerCase() === parsedId.data.toLowerCase(),
        )?.[1];
        const freshBoard = boardPayloadFor(returnedData);
        const mergedBoard =
          freshBoard === undefined
            ? undefined
            : mergeBoardContinuation(currentBoard, freshBoard, continuation.data.column);
        if (mergedBoard === undefined) return clearAndReload();

        setRefreshedPlacementData((current) => {
          const liveScope = placementRequestsRef.current;
          if (
            liveScope.key !== requestScope.key ||
            !isCurrentComponentRequestGeneration(
              liveScope.generations.get(parsedId.data.toLowerCase()),
              request,
            )
          )
            return current;
          const prior = current?.navigationKey === requestScope.key ? current : undefined;
          return {
            navigationKey: requestScope.key,
            data: {
              ...(prior?.data ?? {}),
              [displayId]: { status: "ready", values: mergedBoard },
            },
            editFormBaselines: { ...(prior?.editFormBaselines ?? {}) },
            ...(prior?.subject === undefined ? {} : { subject: prior.subject }),
          };
        });
        return true;
      } finally {
        boardContinuationInFlightRef.current.delete(serialKey);
      }
    },
    [
      application,
      busy,
      currentData,
      currentPageKey,
      currentSearch,
      navigationKey,
      refreshPlacements,
      router,
    ],
  );

  const continueTablePage = useCallback(
    async (
      placementId: string,
      event: DisplaySemanticEvent,
      table: ReturnType<typeof parseTablePayload>,
    ): Promise<void> => {
      if (
        busy ||
        event.event !== "page_changed" ||
        "column" in event ||
        !Number.isSafeInteger(event.page) ||
        event.page < 1 ||
        event.page > 100_000 ||
        table.page === undefined ||
        Math.abs(event.page - table.page) !== 1
      )
        return;
      const parsedId = containedComponentIdSchema.safeParse(placementId);
      if (!parsedId.success) return;

      const scopeKey = `${navigationKey}\u0000${currentSearch}`;
      let history = tableContinuationHistoryRef.current;
      if (history.scopeKey !== scopeKey) {
        history = { scopeKey, cursors: new Map(), inFlight: new Set() };
        tableContinuationHistoryRef.current = history;
      }
      const placementKey = parsedId.data.toLowerCase();
      let cursors = history.cursors.get(placementKey);
      if (cursors === undefined) {
        cursors = new Map();
        history.cursors.set(placementKey, cursors);
      }

      let continuationToken: string | undefined;
      if (event.page === table.page + 1) {
        continuationToken = table.nextContinuationToken;
        if (
          table.hasNextPage !== true ||
          continuationToken === undefined ||
          (event.continuationToken !== undefined &&
            event.continuationToken !== continuationToken)
        )
          return;
        cursors.set(event.page, continuationToken);
      } else if (event.page > 1) {
        continuationToken = cursors.get(event.page);
        if (continuationToken === undefined) return;
      }

      const requestKey = `${placementKey}\u0000${event.page}`;
      if (history.inFlight.has(requestKey)) return;
      history.inFlight.add(requestKey);
      try {
        await refreshPlacements([parsedId.data], {
          placementId: parsedId.data,
          request: {
            page: event.page,
            ...(continuationToken === undefined ? {} : { continuationToken }),
          },
        });
      } finally {
        history.inFlight.delete(requestKey);
      }
    },
    [busy, currentSearch, navigationKey, refreshPlacements],
  );

  return { runBinding, continueBoardColumn, continueTablePage };
}
