import { useCallback, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { useRouter } from "next/navigation";
import type { createFlowRuntime, DisplayTablePayload, FlowEventCycle } from "@vortex/ui";
import type { DisplaySemanticEvent, ServerDrivenResult } from "@vortex/ui";
import {
  type ComponentRequestGeneration,
  recordIdSchema,
  type RecordsTablePageRequest,
} from "@vortex/platform/schema";
import type {
  ApplicationPageModel,
  PlacementFlowBinding,
} from "../../../../../../_lib/application-page";
import type {
  DispatchOutcome,
  PageMessageDraft,
  RefreshedPlacementData,
  TableContinuationTarget,
  ControlReport,
} from "./types";
import { asComponentBinding } from "./event-values";

export function usePlacementActions({
  applyDispatch,
  flowRuntime,
  formOwners,
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
    dispatch: Promise<ServerDrivenResult | undefined>,
    formPlacementId?: string,
    afterAccepted?: () => Promise<PageMessageDraft | undefined>,
    sourceBindingId?: string,
    reportOnControl?: ControlReport,
  ) => Promise<DispatchOutcome>;
  flowRuntime: ReturnType<typeof createFlowRuntime>;
  formOwners: Readonly<Record<string, string>>;
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
  commitTablePage: (placementId: string, request: RecordsTablePageRequest) => Promise<void>;
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
      afterAccepted?: () => Promise<PageMessageDraft | undefined>,
      /** One identity for this user gesture, so a repeated request is the same run. */
      clickId?: string,
      /** The gesture is shown on its own control, which tells the person its outcome. */
      reportOnControl?: ControlReport,
      sourceTablePlacementId?: string,
      /** A field change initiated by another flow continues that same cycle. */
      cycle?: FlowEventCycle,
    ) => {
      const callerInputs = { ...supplied };
      for (const selectedReadInput of binding.selectedReadInputs ?? []) {
        // A link field already supplies its selected record reference. The server checks its
        // exact type against the installed read projection before accepting it.
        if (binding.event === "field_changed") continue;
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
          clickId ?? crypto.randomUUID(),
          gestureSubject,
          sourceTablePlacementId,
          cycle,
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
      const board = await import("./board-column-read");
      return board.readBoardColumns(
        {
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
      table: DisplayTablePayload,
    ): Promise<void> => {
      const pagination = await import("./continue-table-page");
      await pagination.continueTablePage(
        {
          commitTablePage,
          currentSearch,
          navigationKey,
          tableQueryPending,
          tableContinuationScopeRef,
        },
        placementId,
        event,
        table,
      );
    },
    [commitTablePage, currentSearch, navigationKey, tableQueryPending, tableContinuationScopeRef],
  );

  return { runBinding, readBoardColumns, continueTablePage };
}
