import { useMemo, useRef, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { useRouter } from "next/navigation";
import type {
  createFormBlockRuntime,
  DisplayTablePayload,
  useUnsavedWorkGuard,
  useUnsavedWorkRegistry,
} from "@vortex/ui";
import {
  equalFormValue,
  type ControlSemanticEvent,
  type ChoiceInputPayload,
  type DisplaySemanticEvent,
  type ServerDrivenResult,
  type FlowIntentHost,
  type FlowRuntimeState,
} from "@vortex/ui";
import {
  isRecord,
  guidedFormConfirmationKey,
  projectedLinkTilesSchema,
  mountedRecordPinFrameSchema,
  recordsSelectionMaximumIds,
  type RecordsTablePivotView,
  type RecordsTableQueryChange,
  type ReferenceChoiceSelectionEvidenceMap,
  type ComponentRequestGeneration,
  type GridLayoutCommitResult,
  type GridViewCommand,
  type GridViewCommandResult,
} from "@vortex/platform/schema";
import type {
  ApplicationPageModel,
  PlacementFlowBinding,
} from "../../../../../../_lib/application-page";
import type {
  placementEventNamesByPage,
  applicationLauncherPlacementIds,
} from "./placement-helpers";
import { boardPayloadFor, tablePayloadFor } from "./placement-helpers";
import type {
  DispatchOutcome,
  PageSelection,
  TableContinuationTarget,
  PageMessageDraft,
  SubmittedForm,
  EventHandlers,
  ControlReport,
} from "./types";
import { bindingFor, suppliedValues, bindingOfEvent, asComponentBinding } from "./event-values";
import { unavailableNotice } from "./notices";
import {
  publishedControlData,
  rememberPublishedChoices,
  type PublishedRecordTitles,
} from "./published-control-data";
import { usePageParameters } from "./use-page-parameters";
import type { PageAddress } from "./page-address";
import { useBulkSelection } from "./use-bulk-selection";
import { useBatchUndo } from "./use-batch-undo";
import { useRangeSummary } from "./use-range-summary";
import { useRecordsExport } from "./use-records-export";
import type { draftControls } from "./control-drafts";
import type { ControlDrafts } from "../../../_components/application-frame-state";
import type { useFieldFlowEvents } from "./use-field-flow-events";

export function useRuntimeInputs({
  currentData,
  model,
  runtimeState,
  guidedActiveFormIds,
  guidedActivePlacementIds,
  guidedFormCompleted,
  placementEventNames,
  formOwners,
  recordDetailOwners,
  launcherPlacements,
  unsavedWork,
  onOpenApplication,
  runBinding,
  fieldFlowEvents,
  readBoardColumns,
  continueTablePage,
  refreshPlacements,
  setSelection,
  changeTableQuery,
  commitLayout,
  runViewCommand,
  readRowDetail,
  readPivotPage,
  commitPivotView,
  groupEventsFor,
  requestChoicePageRef,
  subject,
  requestedStepId,
  guidedSummaryStepId,
  showPageMessage,
  prepareGuidedSummary,
  advanceGuidedStep,
  currentEditFormBaselines,
  choiceEvidenceFor,
  submittedFormsRef,
  formCancelledRef,
  applyDispatch,
  formBlock,
  selection,
  application,
  activeChoicePages,
  pinActivationInFlightRef,
  placementRequestsRef,
  navigationKey,
  currentTileDataRef,
  currentPageKey,
  currentSearch,
  address,
  rereadTables,
  router,
  requestChoicePage,
  runtimeInputsRef,
  controlDraftsRef,
  controls,
  unsavedWorkRegistry,
  setPanelRef,
}: Readonly<{
  currentData: ApplicationPageModel["data"];
  model: ApplicationPageModel;
  runtimeState: FlowRuntimeState;
  guidedActiveFormIds: string[];
  guidedActivePlacementIds: ReadonlySet<string> | undefined;
  guidedFormCompleted: boolean;
  placementEventNames: ReturnType<typeof placementEventNamesByPage>;
  formOwners: Readonly<Record<string, string>>;
  /** The Record detail each placement sits in, whose record an action in its header acts on. */
  recordDetailOwners: Readonly<Record<string, string>>;
  launcherPlacements: ReturnType<typeof applicationLauncherPlacementIds>;
  unsavedWork: ReturnType<typeof useUnsavedWorkGuard>["guard"];
  onOpenApplication: (event: DisplaySemanticEvent) => Promise<void>;
  runBinding: (
    placementId: string,
    binding: PlacementFlowBinding,
    supplied: Record<string, unknown> | (() => Record<string, unknown>),
    selectedRecordId?: string,
    gestureSubject?: Readonly<{ recordId: string; revision: number }>,
    afterAccepted?: () => Promise<PageMessageDraft | undefined>,
    clickId?: string,
    reportOnControl?: ControlReport,
    sourceTablePlacementId?: string,
  ) => Promise<DispatchOutcome>;
  fieldFlowEvents: ReturnType<typeof useFieldFlowEvents>;
  readBoardColumns: (
    placementId: string,
    event: DisplaySemanticEvent,
  ) => Promise<boolean | "deferred">;
  continueTablePage: (
    placementId: string,
    event: DisplaySemanticEvent,
    table: DisplayTablePayload,
  ) => Promise<void>;
  refreshPlacements: (
    placementIds: readonly string[],
    tableContinuation?: TableContinuationTarget,
    options?: Readonly<{ content?: true }>,
  ) => Promise<void>;
  setSelection: Dispatch<SetStateAction<PageSelection>>;
  changeTableQuery: (
    placementId: string,
    change: Exclude<RecordsTableQueryChange, { kind: "page" }>,
  ) => void;
  commitLayout: (
    placementId: string,
    event: DisplaySemanticEvent,
  ) => Promise<GridLayoutCommitResult>;
  runViewCommand: (placementId: string, command: GridViewCommand) => Promise<GridViewCommandResult>;
  readRowDetail: (placementId: string, event: DisplaySemanticEvent) => Promise<unknown>;
  readPivotPage: (placementId: string, event: DisplaySemanticEvent) => Promise<unknown>;
  commitPivotView: (placementId: string, view: RecordsTablePivotView | undefined) => void;
  /** The events a grouped table reports, for the table's own grouping field. */
  groupEventsFor: (
    placementId: string,
    fieldId: string,
    opensGrouped: boolean,
  ) => Readonly<Record<string, (event: DisplaySemanticEvent) => unknown>>;
  requestChoicePageRef: RefObject<
    (
      placementId: string,
      event: Extract<ControlSemanticEvent, { event: "choices_requested" }>,
      formId?: string,
    ) => Promise<void>
  >;
  subject: ApplicationPageModel["subject"];
  requestedStepId: RefObject<string | undefined>;
  guidedSummaryStepId: string | undefined;
  showPageMessage: (message: PageMessageDraft | undefined) => void;
  prepareGuidedSummary: (
    placementId: string,
    binding: PlacementFlowBinding,
    submittedValues: Readonly<Record<string, unknown>>,
  ) => Promise<
    | {
        proof: string;
        afterAccepted: () => Promise<PageMessageDraft | undefined>;
        finish: () => void;
      }
    | undefined
  >;
  advanceGuidedStep: (
    stepId: string,
    values: Readonly<Record<string, unknown>>,
    requested?: string,
  ) => Promise<void>;
  currentEditFormBaselines: ApplicationPageModel["editFormBaselines"];
  choiceEvidenceFor: (
    formId: string,
    values: Readonly<Record<string, unknown>>,
    surface?: "page" | "dialog",
  ) => ReferenceChoiceSelectionEvidenceMap | undefined;
  submittedFormsRef: RefObject<Map<string, SubmittedForm>>;
  formCancelledRef: RefObject<boolean>;
  applyDispatch: (
    dispatch: Promise<ServerDrivenResult | undefined>,
    formPlacementId?: string,
    afterAccepted?: () => Promise<PageMessageDraft | undefined>,
    sourceBindingId?: string,
  ) => Promise<unknown>;
  formBlock: ReturnType<typeof createFormBlockRuntime>;
  selection: PageSelection;
  application: ApplicationPageModel["invocation"];
  activeChoicePages: Readonly<Record<string, ChoiceInputPayload>>;
  pinActivationInFlightRef: RefObject<boolean>;
  placementRequestsRef: RefObject<{
    base: string;
    key: string;
    generations: Map<string, ComponentRequestGeneration>;
  }>;
  navigationKey: string;
  currentTileDataRef: RefObject<ApplicationPageModel["data"]>;
  currentPageKey: string | undefined;
  currentSearch: string;
  address: PageAddress;
  rereadTables: (placementIds: readonly string[]) => void;
  router: ReturnType<typeof useRouter>;
  requestChoicePage: (
    placementId: string,
    event: Extract<ControlSemanticEvent, { event: "choices_requested" }>,
    formId?: string,
  ) => Promise<void>;
  runtimeInputsRef: RefObject<Readonly<Record<string, unknown>>>;
  controlDraftsRef: RefObject<ControlDrafts> | undefined;
  controls: ReturnType<typeof draftControls>;
  unsavedWorkRegistry: ReturnType<typeof useUnsavedWorkRegistry>;
  setPanelRef: RefObject<FlowIntentHost["setPanel"]>;
}>) {
  const pageParameters = usePageParameters({
    model,
    address,
    currentSearch,
    navigationKey,
    refreshPlacements,
    rereadTables,
    setSelection,
    setPanelRef,
  });
  // Bulk actions: every matching record of a table, and the runs over a selection.
  const bulk = useBulkSelection({
    model,
    navigationKey,
    currentData,
    selection,
    setSelection,
    refreshPlacements,
  });
  // Export: the file of the records a person selected, streamed by the server.
  const exported = useRecordsExport({ model, navigationKey, matchingOf: bulk.matchingOf });
  // The spreadsheet status bar's totals of a selected range, read from the server per settled range.
  const rangeSummary = useRangeSummary({ model, address });
  // Paste, Fill and Undo: one validated batch per gesture, and the session's stack of batches.
  const batchEdit = useBatchUndo({ model, navigationKey, address });
  const titles = useRef<{ scope: string; values: PublishedRecordTitles }>({
    scope: navigationKey,
    values: new Map(),
  });
  if (titles.current.scope !== navigationKey)
    titles.current = { scope: navigationKey, values: new Map() };
  // Selection and unrelated form state must not restart an expanded row's read. Handlers keep
  // their identity until the page's binding scope changes, when readRowDetail changes with it.
  const rowDetailHandlers = useMemo(() => {
    const handlers = new Map<string, (event: DisplaySemanticEvent) => Promise<unknown>>();
    return (placementId: string) => {
      let handler = handlers.get(placementId);
      if (handler === undefined) {
        handler = (event) => readRowDetail(placementId, event);
        handlers.set(placementId, handler);
      }
      return handler;
    };
  }, [readRowDetail]);

  // A pivot's reads keep one handler per table while the page stays the same.
  const pivotHandlers = useMemo(() => {
    const handlers = new Map<string, (event: DisplaySemanticEvent) => Promise<unknown>>();
    return (placementId: string) => {
      let handler = handlers.get(placementId);
      if (handler === undefined) {
        handler = (event) => readPivotPage(placementId, event);
        handlers.set(placementId, handler);
      }
      return handler;
    };
  }, [readPivotPage]);

  const runtimeInputs = useMemo(() => {
    const search = new URLSearchParams(currentSearch);
    const inputs: Record<string, unknown> = {};
    // A placement may hold bindings (a form submits) without holding projected data, so both key
    // sets are wired: every placement with data or with a flow binding receives its callbacks.
    const placementIds = new Set([
      ...Object.keys(currentData),
      ...Object.keys(controls),
      ...Object.keys(model.bindings),
      ...guidedActiveFormIds,
      ...model.linkInputPlacementIds,
      ...Object.keys(model.pageParameters.controls),
      ...Object.keys(model.pageParameters.drawers),
    ]);
    if (guidedActivePlacementIds !== undefined)
      for (const placementId of placementIds)
        if (!guidedActivePlacementIds.has(placementId)) placementIds.delete(placementId);
    for (const placementId of placementIds) {
      let data =
        guidedFormCompleted && guidedActiveFormIds.includes(placementId)
          ? ({ status: "disabled", reason: "Refresh to start another form." } as const)
          : publishedControlData(
              model,
              placementId,
              currentData[placementId],
              search,
              titles.current.values,
            );
      if (
        controlDraftsRef !== undefined &&
        Object.hasOwn(controlDraftsRef.current.restored, placementId)
      )
        data = controlDraftsRef.current.restored[placementId] as typeof data;
      const bindings = (model.bindings[placementId] ?? []).filter(
        (binding) => binding.messageAction === undefined,
      );
      const events: EventHandlers = {};
      const boardData = boardPayloadFor(data);
      const tableData = tablePayloadFor(data);
      const declaredEvents = placementEventNames[placementId];
      const supportsEvent = (eventName: string): boolean => declaredEvents?.has(eventName) === true;
      // Runtime data alone does not identify a display: forms can have projected owner-group data.
      // Give each placement only the display callbacks its own registered release declares.
      if (data !== undefined && model.guidedForm === undefined) {
        if (
          launcherPlacements.has(placementId) &&
          supportsEvent("row_action") &&
          !bindings.some((binding) => binding.event === "row_action")
        )
          events.row_action = async (event: DisplaySemanticEvent) => {
            if (event.event !== "row_action") return;
            if (unsavedWork.hasUnsavedWork() && !(await unsavedWork.confirmDiscardUnsavedWork()))
              return;
            await onOpenApplication(event);
          };
        for (const kind of ["row_clicked", "row_action"] as const)
          if (supportsEvent(kind) && bindings.some((binding) => binding.event === kind))
            events[kind] = (event: DisplaySemanticEvent) => {
              const binding = bindingFor(bindings, event);
              if (binding === undefined) {
                console.error(
                  `[page] ${kind} names no binding of its placement: ROW_EVENT_BINDING_MISSING`,
                );
                return;
              }
              if (event.event === "row_clicked")
                pageParameters.rowClicked(placementId, event.recordId);
              return runBinding(
                placementId,
                binding,
                suppliedValues(event),
                event.event === "row_clicked" || event.event === "row_action"
                  ? event.recordId
                  : undefined,
                (tableData !== undefined || boardData !== undefined) &&
                  event.event === "row_action" &&
                  event.revision !== undefined
                  ? { recordId: event.recordId, revision: event.revision }
                  : undefined,
                undefined,
                undefined,
                tableData !== undefined && event.event === "row_action" ? "transient" : undefined,
                tableData !== undefined && event.event === "row_action" ? placementId : undefined,
              );
            };
        // Display writes load their handlers on the first interaction.
        for (const editEvent of ["inline_edit", "row_edit"] as const)
          if (
            tableData !== undefined &&
            supportsEvent(editEvent) &&
            bindings.some((binding) => binding.event === editEvent)
          )
            events[editEvent] = (event: DisplaySemanticEvent) =>
              import("./display-write-events").then(({ inlineEdit }) =>
                inlineEdit(
                  { placementId, bindings, runBinding, refreshPlacements },
                  editEvent,
                  event,
                ),
              );
        if (
          boardData !== undefined &&
          supportsEvent("card_moved") &&
          bindings.some((binding) => binding.event === "card_moved")
        )
          events.card_moved = (event: DisplaySemanticEvent) =>
            import("./display-write-events").then(({ cardMoved }) =>
              cardMoved(
                { placementId, bindings, runBinding, showPageMessage, formCancelledRef },
                event,
              ),
            );
        if (
          boardData !== undefined &&
          supportsEvent("card_added") &&
          bindings.some((binding) => binding.event === "card_added")
        )
          events.card_added = (event: DisplaySemanticEvent) =>
            import("./display-write-events").then(({ cardAdded }) =>
              cardAdded({ placementId, bindings, runBinding, showPageMessage }, event),
            );
        if (boardData !== undefined && supportsEvent("page_changed"))
          events.page_changed = (event: DisplaySemanticEvent) =>
            readBoardColumns(placementId, event);
        if (tableData !== undefined && supportsEvent("page_changed"))
          events.page_changed = (event: DisplaySemanticEvent) =>
            continueTablePage(placementId, event, tableData);
        if (supportsEvent("refresh"))
          events.refresh = () => {
            void refreshPlacements([placementId]);
          };
        // A table's bulk actions run named actions on the server over its selection, never a flow.
        if (
          tableData?.features?.bulkActions !== undefined &&
          supportsEvent("bulk_action") &&
          supportsEvent("selection_changed")
        )
          Object.assign(events, bulk.eventsFor(placementId, tableData, selection[placementId]));
        // A table's Export streams a file from the server over the same selection, never a flow.
        if (tableData?.features?.export !== undefined)
          Object.assign(events, exported.eventsFor(placementId, tableData, selection[placementId]));
        if (tableData?.features?.spreadsheet?.statusBar !== undefined)
          Object.assign(events, rangeSummary.eventsFor(placementId, tableData));
        if (
          tableData?.features?.spreadsheet?.paste === true ||
          tableData?.features?.spreadsheet?.fill === true ||
          tableData?.features?.spreadsheet?.undo === true
        )
          Object.assign(events, batchEdit.eventsFor(placementId));
        if (supportsEvent("selection_changed"))
          events.selection_changed = (event: DisplaySemanticEvent) => {
            if (event.event !== "selection_changed") return;
            if (
              tableData !== undefined &&
              bulk.toggleMatching(placementId, tableData, event.recordId, event.selected)
            )
              return;
            const selected = selection[placementId] ?? [];
            if (
              event.selected &&
              selected.length >= recordsSelectionMaximumIds &&
              !selected.some((item) => item.recordId === event.recordId)
            ) {
              showPageMessage({
                target: "banner",
                severity: "error",
                text: `Select at most ${recordsSelectionMaximumIds} records. Clear some selections before adding another.`,
              });
              return;
            }
            setSelection((current) => {
              const held = current[placementId] ?? [];
              if (!event.selected)
                return {
                  ...current,
                  [placementId]: held.filter((item) => item.recordId !== event.recordId),
                };
              // Repeated select-all gestures must not replace a previously captured revision.
              if (held.some((item) => item.recordId === event.recordId)) return current;
              // Selecting a whole page fires one event per row against the same stale selection,
              // so the cap is also decided here, where the rows already added are known.
              if (held.length >= recordsSelectionMaximumIds) {
                queueMicrotask(() =>
                  showPageMessage({
                    target: "banner",
                    severity: "error",
                    text: `Select at most ${recordsSelectionMaximumIds} records. Clear some selections before adding another.`,
                  }),
                );
                return current;
              }
              return {
                ...current,
                [placementId]: [...held, { recordId: event.recordId, revision: event.revision }],
              };
            });
          };
        // Sort, filter and search change the table's query state in the address; that table alone
        // is read again from page one, on the server, and nothing is applied to the shown rows.
        if (supportsEvent("sort_changed"))
          events.sort_changed = (event: DisplaySemanticEvent) => {
            if (event.event !== "sort_changed") return;
            changeTableQuery(placementId, { kind: "sort", keys: event.sort });
          };
        if (supportsEvent("filter_changed"))
          events.filter_changed = (event: DisplaySemanticEvent) => {
            if (event.event !== "filter_changed") return;
            changeTableQuery(placementId, {
              kind: "filter",
              fieldId: event.field,
              filter: event.value,
            });
          };
        // A link picker (a column filter, or an edited cell) reads one bounded page of the field's
        // target records under the person's access, only when it opens, is searched or continues;
        // nothing is preloaded. The server decides per purpose whether the field may be offered.
        if (
          supportsEvent("filter_changed") ||
          supportsEvent("inline_edit") ||
          supportsEvent("row_edit")
        )
          events.table_records_requested = (event: DisplaySemanticEvent) => {
            if (event.event !== "table_records_requested") return;
            return import("./record-choices").then(({ requestRecordChoices }) =>
              requestRecordChoices(
                model,
                placementId,
                {
                  fieldId: event.field,
                  purpose: event.purpose,
                  ...(event.parentRecordId === undefined
                    ? {}
                    : { parentRecordId: event.parentRecordId }),
                  ...(event.search === undefined ? {} : { search: event.search }),
                  ...(event.continuationToken === undefined
                    ? {}
                    : { continuationToken: event.continuationToken }),
                },
                () => router.refresh(),
              ),
            );
          };
        if (supportsEvent("search_changed"))
          events.search_changed = (event: DisplaySemanticEvent) => {
            if (event.event !== "search_changed") return;
            changeTableQuery(placementId, { kind: "search", text: event.query });
          };
        // A layout change (order, shown columns, widths, density) is stored for the person; it
        // reads no records unless it shows a column the page was read without.
        if (supportsEvent("columns_changed") && tableData !== undefined)
          events.columns_changed = (event: DisplaySemanticEvent) =>
            commitLayout(placementId, event);
        // A pivot reads its rows on the server, keeps its view in the address without reading the
        // table again, and a cell opens the ordinary grid on the records it counts in one address
        // change. Only a table whose projection carries a pivot offers them.
        if (tableData?.features?.pivot !== undefined && supportsEvent("page_changed")) {
          events.pivot_requested = pivotHandlers(placementId);
          events.pivot_view_changed = (event: DisplaySemanticEvent) => {
            if (event.event !== "pivot_view_changed") return;
            commitPivotView(placementId, event.view);
          };
          events.pivot_drilled = (event: DisplaySemanticEvent) => {
            if (event.event !== "pivot_drilled") return;
            changeTableQuery(placementId, { kind: "drill", filters: event.filters });
          };
        }
        // A grouped table counts its groups in the page read, reads an open group's members on
        // demand and keeps the open group in the address; only a table whose projection carries
        // grouping offers them.
        if (tableData?.features?.grouping !== undefined && supportsEvent("page_changed"))
          Object.assign(
            events,
            groupEventsFor(
              placementId,
              tableData.features.grouping.fieldId,
              tableData.features.grouping.opensGrouped,
            ),
          );
        // Saved views change the address and store a view; like the layout they are the person's
        // own and need no flow, so the same declared event gates them.
        if (supportsEvent("columns_changed") && tableData !== undefined)
          events.grid_view_requested = (event: DisplaySemanticEvent) => {
            if (event.event !== "grid_view_requested") return;
            return runViewCommand(placementId, event.command);
          };
        // An expanded row reads its related records or the records beneath it; only a table whose rows expand offers it.
        if (
          supportsEvent("row_expanded") &&
          (tableData?.features?.masterDetail !== undefined ||
            tableData?.features?.tree !== undefined)
        )
          events.row_expanded = rowDetailHandlers(placementId);
      }
      if (model.referenceChoiceInputs.some((field) => field.placementId === placementId))
        events.choices_requested = (event: ControlSemanticEvent) => {
          if (event.event !== "choices_requested") return;
          return requestChoicePageRef.current(placementId, event);
        };
      // A link field's picker asks for its records; the page reads them under the person's access.
      if (model.linkInputPlacementIds.includes(placementId))
        events.records_requested = (event: ControlSemanticEvent) => {
          if (event.event !== "records_requested") return;
          return import("./record-choices")
            .then(({ requestRecordChoices }) =>
              requestRecordChoices(model, placementId, event, () => router.refresh()),
            )
            .then((page) => {
              if (titles.current.scope === navigationKey)
                rememberPublishedChoices(titles.current.values, placementId, page);
              return page;
            });
        };
      const publishedParameter = model.pageParameters.controls[placementId];
      const fieldFlows = fieldFlowEvents(placementId, bindings);
      if (fieldFlows.changed !== undefined && supportsEvent("field_changed"))
        events.field_changed = fieldFlows.changed;
      if (fieldFlows.focusLost !== undefined && supportsEvent("field_focus_lost"))
        events.field_focus_lost = fieldFlows.focusLost;
      if (supportsEvent("field_changed")) {
        const fieldChanged = events.field_changed as
          ((event: ControlSemanticEvent) => void) | undefined;
        events.field_changed = (event: ControlSemanticEvent) => {
          fieldChanged?.(event);
          if (event.event === "field_changed") {
            const control = controls[placementId];
            if (control !== undefined && controlDraftsRef !== undefined) {
              const store = controlDraftsRef.current;
              const owner = formOwners[placementId];
              if (owner !== undefined && store.baselines[owner] === undefined) {
                const baseline = unsavedWorkRegistry?.baselineOf(owner);
                if (baseline !== undefined) {
                  store.baselines[owner] = baseline;
                  store.baselineFields[owner] = Object.fromEntries(
                    Object.entries(controls)
                      .filter(([id]) => formOwners[id] === owner)
                      .map(([id, field]) => [id, { kind: field.kind, fieldKey: field.fieldKey }]),
                  );
                }
              }
              store.drafts[placementId] = {
                kind: control.kind,
                value: event.value,
                fieldKey: event.fieldKey,
                ...(owner === undefined ? {} : { owner }),
                ...(event.draftDisplay === undefined ? {} : { display: event.draftDisplay }),
              };
            }
          }
          if (publishedParameter !== undefined) pageParameters.change(placementId, event);
        };
      }
      // A table whose click is bound to a flow keeps that flow; the flow publishes the record when
      // it opens a panel.
      if (
        publishedParameter !== undefined &&
        supportsEvent("row_clicked") &&
        !bindings.some((binding) => binding.event === "row_clicked")
      )
        events.row_clicked = (event: DisplaySemanticEvent) => {
          if (event.event === "row_clicked")
            pageParameters.publish(placementId, event.recordId, false);
        };
      // An action button runs its bound flow through the same path as a display event. Inside a
      // form it reports the form's current values. A record page also supplies its verified page
      // subject for declared navigation bindings; the binding receives only the inputs it declares.
      // An action inside a Record detail (its header actions) acts on the record that detail shows,
      // which is the page subject on a record page and the selected record in a panel.
      const actionBinding = bindingOfEvent(bindings, "action");
      if (actionBinding !== undefined && model.guidedForm === undefined)
        events.action = (event: ControlSemanticEvent) => {
          if (event.event !== "action" || event.intent !== "activate") return;
          const detailOwner = recordDetailOwners[placementId];
          const detail = detailOwner === undefined ? undefined : currentData[detailOwner];
          const recordId =
            detail?.status === "ready" &&
            isRecord(detail.values) &&
            detail.values.kind === "record_detail" &&
            typeof detail.values.recordId === "string"
              ? detail.values.recordId
              : subject?.recordId;
          return runBinding(
            placementId,
            actionBinding,
            () => ({
              ...(event.readValues?.() ?? {}),
              ...(recordId === undefined ? {} : { record_id: recordId }),
            }),
            recordId,
          );
        };
      // A drawer opened by a control's selection closes by clearing that selection.
      if (model.pageParameters.drawers[placementId] !== undefined && supportsEvent("action")) {
        const action = events.action as ((event: ControlSemanticEvent) => void) | undefined;
        events.action = (event: ControlSemanticEvent) => {
          if (event.event === "action" && event.intent === "dismiss")
            pageParameters.dismiss(placementId);
          else return action?.(event);
        };
      }
      // A form container emits its one submission for a gesture; it runs the bound flow once
      // through the runtime, which resumes every pause with the server-issued continuation. The
      // handler returns that run, so the form shows busy from the press until the run settles.
      const submitBinding = bindings.find((binding) => binding.event === "form_submit");
      if (
        submitBinding !== undefined ||
        (model.guidedForm !== undefined && formOwners[placementId] === placementId)
      )
        events.form_submit = (event: ControlSemanticEvent) => {
          if (event.event !== "form_submit" || guidedFormCompleted) return;
          if (model.guidedForm !== undefined) {
            const requested = requestedStepId.current;
            requestedStepId.current = undefined;
            if (model.guidedForm.activeStepId === guidedSummaryStepId) {
              if (submitBinding === undefined) {
                showPageMessage(unavailableNotice);
                return;
              }
              let prepared: Awaited<ReturnType<typeof prepareGuidedSummary>>;
              const dispatch = formBlock.submit(
                asComponentBinding(placementId, submitBinding),
                async (signal) => {
                  const result = await prepareGuidedSummary(
                    placementId,
                    submitBinding,
                    event.readValues(),
                  );
                  if (signal.aborted) {
                    result?.finish();
                    return undefined;
                  }
                  prepared = result;
                  if (result === undefined) return undefined;
                  return {
                    values: { [guidedFormConfirmationKey]: result.proof },
                    ...(event.selectedOwnerGroupId === undefined
                      ? {}
                      : { selectedOwnerGroupId: event.selectedOwnerGroupId }),
                  };
                },
                event.gestureId,
              );
              return applyDispatch(
                dispatch,
                placementId,
                async () => prepared?.afterAccepted(),
                submitBinding.bindingId,
              ).finally(() => prepared?.finish());
            }
            return advanceGuidedStep(model.guidedForm.activeStepId, event.readValues(), requested);
          }
          if (submitBinding === undefined) return;
          const prepare = () => {
            const values = event.readValues();
            const baseline = currentEditFormBaselines[placementId];
            // Keep every answer for individual caller inputs. Only the whole-record values input
            // receives the changed fields; read-only prefilled answers are not record writes.
            const recordValues =
              baseline === undefined
                ? values
                : Object.fromEntries(
                    Object.entries(values).filter(
                      ([name, value]) =>
                        !Object.hasOwn(baseline, name) || !equalFormValue(value, baseline[name]),
                    ),
                  );
            const choiceEvidence = choiceEvidenceFor(placementId, values);
            submittedFormsRef.current.set(submitBinding.bindingId, {
              formId: placementId,
              values,
              ...(choiceEvidence === undefined ? {} : { choiceEvidence }),
            });
            return {
              values,
              ...(event.selectedOwnerGroupId === undefined
                ? {}
                : { selectedOwnerGroupId: event.selectedOwnerGroupId }),
              ...(baseline === undefined || !submitBinding.savesFormValues
                ? {}
                : { recordChanges: Object.keys(recordValues) }),
            };
          };
          return applyDispatch(
            formBlock.submit(
              asComponentBinding(placementId, submitBinding),
              prepare,
              event.gestureId,
            ),
            placementId,
            undefined,
            submitBinding.bindingId,
          );
        };
      const readyBinding = bindings.find((binding) => binding.event === "form_ready");
      if (readyBinding !== undefined && model.guidedForm === undefined)
        events.form_ready = (event: ControlSemanticEvent) => {
          if (event.event !== "form_ready") return;
          void applyDispatch(
            formBlock.ready(asComponentBinding(placementId, readyBinding), event.gestureId),
            undefined,
            undefined,
            readyBinding.bindingId,
          );
        };
      const resetBinding = bindings.find((binding) => binding.event === "form_reset");
      if (supportsEvent("form_reset") && model.guidedForm === undefined)
        events.form_reset = (event: ControlSemanticEvent) => {
          if (event.event !== "form_reset") return;
          const store = controlDraftsRef?.current;
          if (store !== undefined) {
            for (const [id, draft] of Object.entries(store.drafts))
              if (draft.owner === placementId) {
                delete store.drafts[id];
                delete store.restored[id];
              }
            delete store.baselines[placementId];
            delete store.baselineFields[placementId];
          }
          runtimeState.messages.clear("inline", placementId);
          if (resetBinding !== undefined)
            void applyDispatch(
              formBlock.reset(asComponentBinding(placementId, resetBinding), event.gestureId),
              undefined,
              undefined,
              resetBinding.bindingId,
            );
        };
      if (data === undefined) {
        if (Object.keys(events).length > 0)
          inputs[placementId] = {
            ...(Object.keys(events).length === 0 ? {} : { events }),
          };
        continue;
      }
      const held = selection[placementId];
      const ready = (data ?? {}) as { status?: string; values?: Record<string, unknown> };
      const shownTable = ready.status === "ready" ? tablePayloadFor(data) : undefined;
      const tableValues =
        shownTable === undefined || ready.values === undefined
          ? undefined
          : ((values: Record<string, unknown>) =>
              exported.decorate(
                placementId,
                bulk.decorate(placementId, shownTable, values) ?? values,
              ))(
              held === undefined
                ? ready.values
                : { ...ready.values, selectedRecordIds: held.map((item) => item.recordId) },
            );
      const pins =
        ready.status === "ready" && ready.values?.kind === "link_tiles"
          ? projectedLinkTilesSchema.safeParse(ready.values)
          : undefined;
      const pinFrame = mountedRecordPinFrameSchema.safeParse({
        pageId: model.pageId,
        installationRevision: application.installationRevision,
        releaseKey: application.releaseKey,
      });
      inputs[placementId] = {
        data:
          activeChoicePages[placementId] !== undefined
            ? { status: "ready", values: activeChoicePages[placementId] }
            : tableValues !== undefined
              ? { ...ready, values: tableValues }
              : data,
        events,
        ...(pins?.success !== true || !pinFrame.success
          ? {}
          : {
              pin_frame: pinFrame.data,
              open_tile: async (
                sourceRecordId: string,
                sourceRevision: number,
                isVisible?: () => boolean,
              ): Promise<void> => {
                const { openTile } = await import("./open-tile");
                await openTile({
                  sourceRecordId,
                  sourceRevision,
                  ...(isVisible === undefined ? {} : { isVisible }),
                  pinActivationInFlightRef,
                  placementRequestsRef,
                  navigationKey,
                  currentTileDataRef,
                  placementId,
                  data,
                  pins: pins.data,
                  currentPageKey,
                  unsavedWork,
                  application,
                  currentSearch,
                  router,
                });
              },
            }),
      };
    }
    return inputs;
  }, [
    applyDispatch,
    controls,
    controlDraftsRef,
    unsavedWorkRegistry,
    fieldFlowEvents,
    formBlock,
    formCancelledRef,
    runtimeState,
    formOwners,
    recordDetailOwners,
    launcherPlacements,
    choiceEvidenceFor,
    activeChoicePages,
    model,
    model.referenceChoiceInputs,
    currentData,
    application,
    currentPageKey,
    currentSearch,
    pageParameters,
    navigationKey,
    model.pageId,
    currentEditFormBaselines,
    guidedActivePlacementIds,
    guidedActiveFormIds,
    guidedFormCompleted,
    guidedSummaryStepId,
    advanceGuidedStep,
    prepareGuidedSummary,
    model.bindings,
    model.guidedForm,
    placementEventNames,
    router,
    refreshPlacements,
    runBinding,
    requestChoicePage,
    selection,
    changeTableQuery,
    commitLayout,
    runViewCommand,
    rowDetailHandlers,
    pivotHandlers,
    commitPivotView,
    groupEventsFor,
    subject,
    onOpenApplication,
    unsavedWork,
    readBoardColumns,
    continueTablePage,
    bulk,
    exported,
    rangeSummary,
    batchEdit,
  ]);

  runtimeInputsRef.current = runtimeInputs;

  return { runtimeInputs };
}
