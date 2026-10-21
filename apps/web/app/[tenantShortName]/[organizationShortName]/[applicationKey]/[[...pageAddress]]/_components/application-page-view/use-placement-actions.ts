import { useCallback, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { useRouter } from "next/navigation";
import type { createFlowRuntime, parseTablePayload } from "@vortex/ui";
import type { DisplaySemanticEvent, FlowDispatchResult } from "@vortex/ui";
import {
  type ComponentRequestGeneration,
  containedComponentIdSchema,
  recordIdSchema,
  searchWithoutRecordsTableState,
  type RecordsTablePageRequest,
} from "@vortex/platform/schema";
import type {
  ApplicationPageModel,
  PlacementFlowBinding,
} from "../../../../../../_lib/application-page";
import type {
  DispatchOutcome,
  Notice,
  RefreshedPlacementData,
  TableContinuationTarget,
} from "./types";
import { asComponentBinding } from "./event-values";

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
  tableContinuationScopeRef,
  commitTablePage,
  tableQueryPending,
}: Readonly<{
  applyDispatch: (
    dispatch: Promise<FlowDispatchResult | undefined>,
    formPlacementId?: string,
    afterAccepted?: () => Promise<Notice | undefined>,
    sourceBindingId?: string,
    reportOnControl?: true,
  ) => Promise<DispatchOutcome>;
  flowRuntime: ReturnType<typeof createFlowRuntime>;
  formOwners: Readonly<Record<string, string>>;
  busy: boolean;
  placementRequestsRef: RefObject<{
    base: string;
    key: string;
    generations: Map<string, ComponentRequestGeneration>;
  }>;
  navigationKey: string;
  currentPageKey: string | undefined;
  currentData: ApplicationPageModel["data"];
  boardContinuationInFlightRef: RefObject<Set<string>>;
  setRefreshedPlacementData: Dispatch<SetStateAction<RefreshedPlacementData | undefined>>;
  refreshPlacements: (
    placementIds: readonly string[],
    tableContinuation?: TableContinuationTarget,
  ) => Promise<void>;
  application: ApplicationPageModel["invocation"];
  currentSearch: string;
  router: ReturnType<typeof useRouter>;
  tableContinuationScopeRef: RefObject<{ scopeKey: string; inFlight: Set<string> }>;
  commitTablePage: (placementId: string, request: RecordsTablePageRequest) => void;
  tableQueryPending: (placementId: string) => boolean;
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
      /** One identity for this user gesture, so a repeated request is the same run. */
      clickId?: string,
      /** The gesture is shown on its own control, which tells the person its outcome. */
      reportOnControl?: true,
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
          clickId,
          gestureSubject,
        ),
        formOwners[placementId],
        afterAccepted,
        binding.bindingId,
        reportOnControl,
      );
    },
    [applyDispatch, formOwners, flowRuntime],
  );

  const readBoardColumns = useCallback(
    async (placementId: string, event: DisplaySemanticEvent): Promise<boolean | "deferred"> => {
      if (event.event !== "page_changed" || !("columns" in event)) return false;
      if (busy) return "deferred";
      const board = await import("./board-column-read");
      return board.readBoardColumns(
        {
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
        },
        placementId,
        event,
      );
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
        "columns" in event ||
        !Number.isSafeInteger(event.page) ||
        event.page < 1 ||
        event.page > 100_000 ||
        table.page === undefined
      )
        return;
      const parsedId = containedComponentIdSchema.safeParse(placementId);
      // The shown page was read for an earlier sort, filter, search or column state: its tokens
      // belong to that state, so a page move waits for the new state's page.
      if (!parsedId.success || tableQueryPending(parsedId.data)) return;

      const scopeKey = `${navigationKey}\u0000${searchWithoutRecordsTableState(currentSearch)}`;
      let scope = tableContinuationScopeRef.current;
      if (scope.scopeKey !== scopeKey) {
        scope = { scopeKey, inFlight: new Set() };
        tableContinuationScopeRef.current = scope;
      }
      const placementKey = parsedId.data.toLowerCase();
      const direction = event.direction;
      const continuationToken =
        direction === "next"
          ? table.nextContinuationToken
          : direction === "previous"
            ? table.previousContinuationToken
            : undefined;
      if (
        // First needs only a later page: an empty continuation page has no previous anchor.
        (direction === "first" && (event.page !== 1 || table.page <= 1)) ||
        (direction === "last" && (table.hasNextPage !== true || event.page !== 2)) ||
        (direction === "next" &&
          (table.hasNextPage !== true ||
            event.page !== 2 ||
            continuationToken === undefined ||
            event.continuationToken !== continuationToken)) ||
        (direction === "previous" &&
          (table.hasPreviousPage !== true ||
            event.page !== 2 ||
            continuationToken === undefined ||
            event.continuationToken !== continuationToken))
      )
        return;
      const requestKey = `${placementKey}\u0000${direction}`;
      if (scope.inFlight.has(requestKey)) return;
      scope.inFlight.add(requestKey);
      try {
        const request: RecordsTablePageRequest = {
          page: event.page,
          pageDirection: direction === "previous" || direction === "last" ? "backward" : "forward",
          ...(continuationToken === undefined ? {} : { continuationToken }),
        };
        // One read of the requested page under the viewer's current access; no page is replayed.
        commitTablePage(parsedId.data, request);
        await refreshPlacements([parsedId.data], { placementId: parsedId.data, request });
      } finally {
        scope.inFlight.delete(requestKey);
      }
    },
    [busy, commitTablePage, currentSearch, navigationKey, refreshPlacements, tableQueryPending],
  );

  return { runBinding, readBoardColumns, continueTablePage };
}
