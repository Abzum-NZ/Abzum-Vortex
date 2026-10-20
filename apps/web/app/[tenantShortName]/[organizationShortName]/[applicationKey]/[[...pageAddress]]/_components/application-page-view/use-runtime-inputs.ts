import { useMemo, useRef, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { useRouter } from "next/navigation";
import type { createFormBlockRuntime, parseTablePayload, useUnsavedWorkGuard } from "@vortex/ui";
import {
  equalFormValue,
  type ControlSemanticEvent,
  type ChoiceInputPayload,
  type DisplaySemanticEvent,
  type FlowDispatchResult,
  type FormFlowFeedback,
} from "@vortex/ui";
import {
  projectedRecordPinTilesSchema,
  projectedApplicationPageLinkTilesSchema,
  mountedRecordPinFrameSchema,
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
import { rereadApplicationPlacements } from "../../placement-refresh-action";
import type {
  placementEventNamesByPage,
  applicationLauncherPlacementIds,
} from "./placement-helpers";
import { boardPayloadFor, tablePayloadFor, compatibleBoardRowAction } from "./placement-helpers";
import type { TableContinuationTarget, Notice, SubmittedForm, EventHandlers } from "./types";
import { bindingFor, suppliedValues, bindingOfEvent, asComponentBinding } from "./event-values";
import { cancelledMoveNotice, unavailableNotice } from "./notices";
import {
  publishedControlData,
  rememberPublishedChoices,
  type PublishedRecordTitles,
} from "./published-control-data";
import { usePageParameters } from "./use-page-parameters";
import { useBulkSelection } from "./use-bulk-selection";
import { requestRecordChoices } from "./record-choices";

export function useRuntimeInputs({
  currentData,
  model,
  formFeedback,
  guidedActiveFormIds,
  guidedActivePlacementIds,
  guidedFormCompleted,
  placementEventNames,
  formOwners,
  launcherPlacements,
  busy,
  unsavedWork,
  onOpenApplication,
  runBinding,
  readBoardColumns,
  continueTablePage,
  refreshPlacements,
  setSelection,
  changeTableQuery,
  commitLayout,
  runViewCommand,
  readRowDetail,
  requestChoicePageRef,
  changeChoiceField,
  subject,
  requestedStepId,
  guidedSummaryStepId,
  setNotice,
  submitGuidedSummary,
  advanceGuidedStep,
  currentEditFormBaselines,
  setFormFeedback,
  choiceEvidenceFor,
  submittedFormsRef,
  formCancelledRef,
  applyDispatch,
  formBlock,
  initializeChoiceForm,
  selection,
  application,
  activeChoicePages,
  pinActivationInFlightRef,
  placementRequestsRef,
  navigationKey,
  currentTileDataRef,
  currentPageKey,
  currentBusyRef,
  currentSearch,
  router,
  requestChoicePage,
  runtimeInputsRef,
}: Readonly<{
  currentData: ApplicationPageModel["data"];
  model: ApplicationPageModel;
  formFeedback: Readonly<Record<string, FormFlowFeedback>>;
  guidedActiveFormIds: string[];
  guidedActivePlacementIds: ReadonlySet<string> | undefined;
  guidedFormCompleted: boolean;
  placementEventNames: ReturnType<typeof placementEventNamesByPage>;
  formOwners: Readonly<Record<string, string>>;
  launcherPlacements: ReturnType<typeof applicationLauncherPlacementIds>;
  busy: boolean;
  unsavedWork: ReturnType<typeof useUnsavedWorkGuard>["guard"];
  onOpenApplication: (event: DisplaySemanticEvent) => Promise<void>;
  runBinding: (
    placementId: string,
    binding: PlacementFlowBinding,
    supplied: Record<string, unknown>,
    selectedRecordId?: string,
    gestureSubject?: Readonly<{ recordId: string; revision: number }>,
    afterAccepted?: () => Promise<Notice | undefined>,
  ) => Promise<void>;
  readBoardColumns: (placementId: string, event: DisplaySemanticEvent) => Promise<boolean>;
  continueTablePage: (
    placementId: string,
    event: DisplaySemanticEvent,
    table: ReturnType<typeof parseTablePayload>,
  ) => Promise<void>;
  refreshPlacements: (
    placementIds: readonly string[],
    tableContinuation?: TableContinuationTarget,
  ) => Promise<void>;
  setSelection: Dispatch<SetStateAction<Readonly<Record<string, readonly string[]>>>>;
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
  requestChoicePageRef: RefObject<
    (
      placementId: string,
      event: Extract<ControlSemanticEvent, { event: "choices_requested" }>,
      formId?: string,
    ) => Promise<void>
  >;
  changeChoiceField: (
    placementId: string,
    event: ControlSemanticEvent,
    dialogFormId?: string,
  ) => void;
  subject: ApplicationPageModel["subject"];
  requestedStepId: RefObject<string | undefined>;
  guidedSummaryStepId: string | undefined;
  setNotice: Dispatch<SetStateAction<Notice | undefined>>;
  submitGuidedSummary: (
    placementId: string,
    binding: PlacementFlowBinding,
    submittedValues: Readonly<Record<string, unknown>>,
    selectedOwnerGroupId?: string,
  ) => Promise<void>;
  advanceGuidedStep: (
    stepId: string,
    values: Readonly<Record<string, unknown>>,
    requested?: string,
  ) => Promise<void>;
  currentEditFormBaselines: ApplicationPageModel["editFormBaselines"];
  setFormFeedback: Dispatch<SetStateAction<Readonly<Record<string, FormFlowFeedback>>>>;
  choiceEvidenceFor: (
    formId: string,
    values: Readonly<Record<string, unknown>>,
    surface?: "page" | "dialog",
  ) => ReferenceChoiceSelectionEvidenceMap | undefined;
  submittedFormsRef: RefObject<Map<string, SubmittedForm>>;
  formCancelledRef: RefObject<boolean>;
  applyDispatch: (
    dispatch: Promise<FlowDispatchResult | undefined>,
    formPlacementId?: string,
    afterAccepted?: () => Promise<Notice | undefined>,
    sourceBindingId?: string,
  ) => Promise<void>;
  formBlock: ReturnType<typeof createFormBlockRuntime>;
  initializeChoiceForm: (
    formId: string,
    dialogFormId?: string,
    defaults?: Readonly<Record<string, unknown>>,
  ) => void;
  selection: Readonly<Record<string, readonly string[]>>;
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
  currentBusyRef: RefObject<boolean>;
  currentSearch: string;
  router: ReturnType<typeof useRouter>;
  requestChoicePage: (
    placementId: string,
    event: Extract<ControlSemanticEvent, { event: "choices_requested" }>,
    formId?: string,
  ) => Promise<void>;
  runtimeInputsRef: RefObject<Readonly<Record<string, unknown>>>;
}>) {
  const pageParameters = usePageParameters({
    model,
    currentSearch,
    navigationKey,
    refreshPlacements,
    setSelection,
  });
  // Bulk actions: every matching record of a table, and the runs over a selection.
  const bulk = useBulkSelection({ model, navigationKey, setSelection, refreshPlacements });
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

  const runtimeInputs = useMemo(() => {
    const search = new URLSearchParams(currentSearch);
    const inputs: Record<string, unknown> = {};
    // A placement may hold bindings (a form submits) without holding projected data, so both key
    // sets are wired: every placement with data or with a flow binding receives its callbacks.
    const placementIds = new Set([
      ...Object.keys(currentData),
      ...Object.keys(model.bindings),
      ...Object.keys(formFeedback),
      ...guidedActiveFormIds,
      ...model.referenceChoiceInputs
        .filter((field) => field.dependency !== undefined)
        .map((field) => field.formId),
      ...model.linkInputPlacementIds,
      ...Object.keys(model.pageParameters.controls),
    ]);
    if (guidedActivePlacementIds !== undefined)
      for (const placementId of placementIds)
        if (!guidedActivePlacementIds.has(placementId)) placementIds.delete(placementId);
    for (const placementId of placementIds) {
      const data =
        guidedFormCompleted && guidedActiveFormIds.includes(placementId)
          ? ({ status: "disabled", reason: "Refresh to start another form." } as const)
          : publishedControlData(
              model,
              placementId,
              currentData[placementId],
              search,
              titles.current.values,
            );
      const bindings = model.bindings[placementId] ?? [];
      const events: EventHandlers = {};
      const boardData = boardPayloadFor(data);
      const tableData = tablePayloadFor(data);
      const boardRowActionBinding =
        boardData === undefined ? undefined : compatibleBoardRowAction(bindings);
      const declaredEvents = placementEventNames[placementId];
      const supportsEvent = (eventName: string): boolean => declaredEvents?.has(eventName) === true;
      const flowFeedback =
        formOwners[placementId] === placementId ? formFeedback[placementId] : undefined;
      // Runtime data alone does not identify a display: forms can have projected owner-group data.
      // Give each placement only the display callbacks its own registered release declares.
      if (data !== undefined && model.guidedForm === undefined) {
        if (launcherPlacements.has(placementId) && supportsEvent("row_action"))
          events.row_action = async (event: DisplaySemanticEvent) => {
            if (event.event !== "row_action" || busy) return;
            if (unsavedWork.hasUnsavedWork() && !(await unsavedWork.confirmDiscardUnsavedWork()))
              return;
            await onOpenApplication(event);
          };
        for (const kind of ["row_clicked", "row_action", "inline_edit"] as const)
          if (
            supportsEvent(kind) &&
            (kind !== "row_action" ||
              (!launcherPlacements.has(placementId) && boardData === undefined)) &&
            bindings.some((binding) => binding.event === kind)
          )
            events[kind] = (event: DisplaySemanticEvent) => {
              if (
                tableData !== undefined &&
                event.event === "row_action" &&
                event.eventId === undefined
              )
                return;
              const binding = bindingFor(bindings, event);
              if (binding !== undefined && !busy)
                return runBinding(
                  placementId,
                  binding,
                  suppliedValues(event),
                  event.event === "row_clicked" ||
                    event.event === "row_action" ||
                    event.event === "inline_edit"
                    ? event.recordId
                    : undefined,
                );
            };
        if (
          boardData !== undefined &&
          boardRowActionBinding !== undefined &&
          supportsEvent("row_action")
        )
          events.row_action = async (event: DisplaySemanticEvent) => {
            if (event.event !== "row_action" || event.eventId !== undefined || busy) return;
            await runBinding(
              placementId,
              boardRowActionBinding,
              suppliedValues(event),
              event.recordId,
            );
          };
        // A moved card saves the record's choice field through the bound flow. The handler reports
        // whether the server accepted the move, so the board keeps the card pending until the
        // refreshed columns arrive and releases it at once when the move was refused.
        if (
          boardData !== undefined &&
          supportsEvent("card_moved") &&
          bindings.some((binding) => binding.event === "card_moved")
        )
          events.card_moved = async (event: DisplaySemanticEvent): Promise<boolean> => {
            if (event.event !== "card_moved" || busy) return false;
            const binding = bindingFor(bindings, event);
            if (binding === undefined || event.revision === undefined) {
              console.error(
                `[page] card move has no binding or revision: ${binding === undefined ? "BOARD_CARD_MOVE_BINDING_MISSING" : "BOARD_CARD_MOVE_REVISION_MISSING"}`,
              );
              setNotice(unavailableNotice);
              return false;
            }
            let accepted = false;
            formCancelledRef.current = false;
            await runBinding(
              placementId,
              binding,
              suppliedValues(event),
              event.recordId,
              { recordId: event.recordId, revision: event.revision },
              async () => {
                // A flow whose form the person cancelled finishes as completed without saving, so
                // the move is not accepted and the card goes back to its column.
                if (formCancelledRef.current) return cancelledMoveNotice;
                accepted = true;
                return undefined;
              },
            );
            return accepted;
          };
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
        if (supportsEvent("selection_changed"))
          events.selection_changed = (event: DisplaySemanticEvent) => {
            if (event.event !== "selection_changed") return;
            if (
              tableData !== undefined &&
              bulk.toggleMatching(placementId, tableData, event.recordId, event.selected)
            )
              return;
            setSelection((current) => {
              const held = new Set(current[placementId] ?? []);
              if (event.selected) held.add(event.recordId);
              else held.delete(event.recordId);
              return { ...current, [placementId]: [...held] };
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
        // A link filter's picker reads one bounded page of the field's target records under the
        // person's access, only when it opens or is searched; nothing is preloaded.
        if (supportsEvent("filter_changed"))
          events.filter_records_requested = (event: DisplaySemanticEvent) => {
            if (event.event !== "filter_records_requested") return;
            return requestRecordChoices(
              model,
              placementId,
              {
                fieldId: event.field,
                ...(event.search === undefined ? {} : { search: event.search }),
                ...(event.continuationToken === undefined
                  ? {}
                  : { continuationToken: event.continuationToken }),
              },
              () => router.refresh(),
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
        // Saved views change the address and store a view; like the layout they are the person's
        // own and need no flow, so the same declared event gates them.
        if (supportsEvent("columns_changed") && tableData !== undefined)
          events.grid_view_requested = (event: DisplaySemanticEvent) => {
            if (event.event !== "grid_view_requested") return;
            return runViewCommand(placementId, event.command);
          };
        // An expanded row reads its related records; only a table whose rows expand offers it.
        if (supportsEvent("row_expanded") && tableData?.features?.masterDetail !== undefined)
          events.row_expanded = rowDetailHandlers(placementId);
      }
      if (model.referenceChoiceInputs.some((field) => field.placementId === placementId))
        events.choices_requested = (event: ControlSemanticEvent) => {
          if (event.event !== "choices_requested") return;
          return requestChoicePageRef.current(placementId, event);
        };
      if (model.referenceChoiceInputs.some((field) => field.placementId === placementId))
        events.field_changed = (event: ControlSemanticEvent) =>
          changeChoiceField(placementId, event);
      // A link field's picker asks for its records; the page reads them under the person's access.
      if (model.linkInputPlacementIds.includes(placementId))
        events.records_requested = (event: ControlSemanticEvent) => {
          if (event.event !== "records_requested") return;
          return requestRecordChoices(model, placementId, event, () => router.refresh()).then(
            (page) => {
              if (titles.current.scope === navigationKey)
                rememberPublishedChoices(titles.current.values, placementId, page);
              return page;
            },
          );
        };
      const publishedParameter = model.pageParameters.controls[placementId];
      if (publishedParameter !== undefined && supportsEvent("field_changed")) {
        const fieldChanged = events.field_changed as
          ((event: ControlSemanticEvent) => void) | undefined;
        events.field_changed = (event: ControlSemanticEvent) => {
          fieldChanged?.(event);
          pageParameters.change(placementId, event);
        };
      }
      if (publishedParameter !== undefined && supportsEvent("row_clicked"))
        events.row_clicked = (event: DisplaySemanticEvent) => {
          if (event.event === "row_clicked")
            pageParameters.publish(placementId, event.recordId, false);
        };
      // An action button runs its bound flow through the same path as a display event. Inside a
      // form it reports the form's current values. A record page also supplies its verified page
      // subject for declared navigation bindings; the binding receives only the inputs it declares.
      const actionBinding = bindingOfEvent(bindings, "action");
      if (actionBinding !== undefined && model.guidedForm === undefined)
        events.action = (event: ControlSemanticEvent) => {
          if (event.event !== "action" || event.intent !== "activate" || busy) return;
          return runBinding(
            placementId,
            actionBinding,
            {
              ...(event.values ?? {}),
              ...(subject === undefined ? {} : { record_id: subject.recordId }),
            },
            subject?.recordId,
          );
        };
      // A form container emits its one submission for a gesture; it runs the bound flow once
      // through the runtime, which resumes every pause with the server-issued continuation. The
      // handler returns that run, so the form shows busy from the press until the run settles.
      const submitBinding = bindings.find((binding) => binding.event === "form_submit");
      if (
        submitBinding !== undefined ||
        (model.guidedForm !== undefined && formOwners[placementId] === placementId)
      )
        events.form_submit = (event: ControlSemanticEvent) => {
          if (event.event !== "form_submit" || busy || guidedFormCompleted) return;
          if (model.guidedForm !== undefined) {
            const requested = requestedStepId.current;
            requestedStepId.current = undefined;
            if (model.guidedForm.activeStepId === guidedSummaryStepId) {
              if (submitBinding === undefined) {
                setNotice(unavailableNotice);
                return;
              }
              return submitGuidedSummary(
                placementId,
                submitBinding,
                event.values,
                event.selectedOwnerGroupId,
              );
            }
            return advanceGuidedStep(model.guidedForm.activeStepId, event.values, requested);
          }
          if (submitBinding === undefined) return;
          const baseline = currentEditFormBaselines[placementId];
          // Keep every answer for individual caller inputs. Only the whole-record values input
          // receives the changed fields; read-only prefilled answers are not record writes.
          const recordValues =
            baseline === undefined
              ? event.values
              : Object.fromEntries(
                  Object.entries(event.values).filter(
                    ([name, value]) =>
                      !Object.hasOwn(baseline, name) || !equalFormValue(value, baseline[name]),
                  ),
                );
          const recordSubmission =
            submitBinding.savesFormValues &&
            submitBinding.callerInputs.every((name) => name === "values" || name === "record");
          if (
            baseline !== undefined &&
            recordSubmission &&
            Object.keys(recordValues).length === 0
          ) {
            setNotice(undefined);
            setFormFeedback((current) => ({
              ...current,
              [placementId]: { kind: "message", tone: "success", text: "No changes to save." },
            }));
            return;
          }
          const choiceEvidence = choiceEvidenceFor(placementId, event.values);
          submittedFormsRef.current.set(submitBinding.bindingId, {
            formId: placementId,
            values: event.values,
            ...(choiceEvidence === undefined ? {} : { choiceEvidence }),
          });
          return applyDispatch(
            formBlock.submit(
              asComponentBinding(placementId, submitBinding),
              event.values,
              event.selectedOwnerGroupId,
              baseline === undefined || !submitBinding.savesFormValues
                ? undefined
                : Object.keys(recordValues),
            ),
            placementId,
            undefined,
            submitBinding.bindingId,
          );
        };
      const readyBinding = bindings.find((binding) => binding.event === "form_ready");
      if (readyBinding !== undefined && model.guidedForm === undefined)
        events.form_ready = (event: ControlSemanticEvent) => {
          if (event.event !== "form_ready" || busy) return;
          void applyDispatch(
            formBlock.ready(asComponentBinding(placementId, readyBinding)),
            undefined,
            undefined,
            readyBinding.bindingId,
          );
        };
      const resetBinding = bindings.find((binding) => binding.event === "form_reset");
      if (resetBinding !== undefined && model.guidedForm === undefined)
        events.form_reset = (event: ControlSemanticEvent) => {
          if (event.event !== "form_reset" || busy) return;
          setFormFeedback((current) => {
            if (!Object.hasOwn(current, placementId)) return current;
            const next = { ...current };
            delete next[placementId];
            return next;
          });
          void applyDispatch(
            formBlock.reset(asComponentBinding(placementId, resetBinding)),
            undefined,
            undefined,
            resetBinding.bindingId,
          );
        };
      if (
        model.referenceChoiceInputs.some(
          (field) => field.formId === placementId && field.dependency !== undefined,
        )
      ) {
        const boundReset = events.form_reset;
        events.form_reset = (event: ControlSemanticEvent) => {
          if (event.event !== "form_reset") return;
          initializeChoiceForm(placementId);
          return boundReset?.(event);
        };
      }
      if (data === undefined) {
        if (Object.keys(events).length > 0 || flowFeedback !== undefined)
          inputs[placementId] = {
            ...(Object.keys(events).length === 0 ? {} : { events }),
            ...(flowFeedback === undefined ? {} : { flowFeedback }),
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
              bulk.decorate(placementId, shownTable, values) ?? values)(
              held === undefined ? ready.values : { ...ready.values, selectedRecordIds: held },
            );
      const pins =
        ready.status === "ready"
          ? ready.values?.kind === "application_page_link_tiles"
            ? projectedApplicationPageLinkTilesSchema.safeParse(ready.values)
            : projectedRecordPinTilesSchema.safeParse(ready.values)
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
                if (
                  busy ||
                  pinActivationInFlightRef.current ||
                  placementRequestsRef.current.key !== navigationKey ||
                  currentTileDataRef.current[placementId] !== data
                )
                  return;
                const rows = pins.data.rows.filter(
                  (row) =>
                    row.sourceRecordId.toLowerCase() === sourceRecordId.toLowerCase() &&
                    row.sourceRevision === sourceRevision,
                );
                const row = rows[0];
                if (rows.length !== 1 || row === undefined || row.target.kind === "unavailable")
                  return;
                if (pins.data.kind === "application_page_link_tiles") {
                  if (currentPageKey === undefined || typeof isVisible !== "function") return;
                  const generation = placementRequestsRef.current.generations.get(
                    placementId.toLowerCase(),
                  );
                  const visible = isVisible;
                  const currentSource = () => {
                    try {
                      return (
                        !currentBusyRef.current &&
                        placementRequestsRef.current.key === navigationKey &&
                        placementRequestsRef.current.generations.get(placementId.toLowerCase()) ===
                          generation &&
                        currentTileDataRef.current[placementId] === data &&
                        visible()
                      );
                    } catch {
                      return false;
                    }
                  };
                  if (!currentSource()) return;
                  pinActivationInFlightRef.current = true;
                  try {
                    // The unsaved-work wait precedes both source selection and target authority rereads.
                    if (
                      row.target.openBehaviour === "replace" &&
                      unsavedWork.hasUnsavedWork() &&
                      !(await unsavedWork.confirmDiscardUnsavedWork())
                    )
                      return;
                    if (!currentSource()) return;
                    const refreshed = await rereadApplicationPlacements(
                      {
                        tenantShortName: application.tenantShortName,
                        organizationShortName: application.organizationShortName,
                        applicationKey: application.applicationKey,
                        pageKey: currentPageKey,
                        installationRevision: application.installationRevision,
                        search: currentSearch,
                      },
                      [placementId],
                    );
                    if (!currentSource()) return;
                    if (refreshed.kind === "reload") {
                      router.refresh();
                      return;
                    }
                    if (refreshed.kind !== "available") return;
                    const state = Object.entries(refreshed.data).find(
                      ([id]) => id.toLowerCase() === placementId.toLowerCase(),
                    )?.[1];
                    if (state?.status !== "ready") return;
                    const fresh = projectedApplicationPageLinkTilesSchema.safeParse(state.values);
                    if (!fresh.success) return;
                    const selected = fresh.data.rows.filter(
                      (entry) =>
                        entry.sourceRecordId.toLowerCase() === sourceRecordId.toLowerCase() &&
                        entry.sourceRevision === sourceRevision,
                    );
                    const current = selected[0];
                    if (
                      selected.length !== 1 ||
                      current === undefined ||
                      current.target.kind === "unavailable" ||
                      current.target.kind !== row.target.kind ||
                      current.target.openBehaviour !== row.target.openBehaviour
                    )
                      return;
                    const target = current.target;
                    // Only the fresh protected tuple supplies an internal address; browser-held metadata is ignored.
                    const internal = target.kind !== "external";
                    if (
                      (target.kind === "application" || target.kind === "page") &&
                      (target.tenantShortName !== application.tenantShortName ||
                        target.organizationShortName !== application.organizationShortName)
                    )
                      return;
                    const href =
                      target.kind === "record"
                        ? `/${encodeURIComponent(application.tenantShortName)}/${encodeURIComponent(application.organizationShortName)}/${encodeURIComponent(target.detailAddress.applicationKey)}/${encodeURIComponent(target.detailAddress.pageKey)}?${new URLSearchParams({ record_id: target.detailAddress.recordId })}`
                        : target.kind === "external"
                          ? target.address
                          : `/${encodeURIComponent(target.tenantShortName)}/${encodeURIComponent(target.organizationShortName)}/${encodeURIComponent(target.applicationKey)}/${encodeURIComponent(target.pageKey)}`;
                    const address = new URL(href, window.location.origin);
                    if (
                      (internal && address.origin !== window.location.origin) ||
                      (!internal && address.protocol !== "https:") ||
                      !currentSource()
                    )
                      return;
                    if (target.openBehaviour === "new_page")
                      window.open(address.href, "_blank", "noopener,noreferrer");
                    else if (internal) router.push(`${address.pathname}${address.search}`);
                    else window.location.assign(address.href);
                  } catch {
                    // No navigation or target metadata on a failed current protected reread.
                  } finally {
                    pinActivationInFlightRef.current = false;
                  }
                  return;
                }
                const target = row.target;
                // The old1.1 payload is independently closed to Record/external targets.
                if (target.kind !== "record" && target.kind !== "external") return;
                const href =
                  target.kind === "record"
                    ? `/${encodeURIComponent(application.tenantShortName)}/${encodeURIComponent(application.organizationShortName)}/${encodeURIComponent(target.detailAddress.applicationKey)}/${encodeURIComponent(target.detailAddress.pageKey)}?${new URLSearchParams({ record_id: target.detailAddress.recordId })}`
                    : target.address;
                const address = new URL(href, window.location.origin);
                if (
                  (target.kind === "record" && address.origin !== window.location.origin) ||
                  (target.kind === "external" && address.protocol !== "https:")
                )
                  return;
                pinActivationInFlightRef.current = true;
                try {
                  if (
                    target.openBehaviour === "replace" &&
                    unsavedWork.hasUnsavedWork() &&
                    !(await unsavedWork.confirmDiscardUnsavedWork())
                  )
                    return;
                  // Navigation and a partial reread can each invalidate the shown row while confirmation waits.
                  if (
                    placementRequestsRef.current.key !== navigationKey ||
                    currentTileDataRef.current[placementId] !== data
                  )
                    return;
                  if (target.openBehaviour === "new_page")
                    window.open(address.href, "_blank", "noopener,noreferrer");
                  else if (target.kind === "record")
                    router.push(`${address.pathname}${address.search}`);
                  else window.location.assign(address.href);
                } finally {
                  pinActivationInFlightRef.current = false;
                }
              },
            }),
        ...(flowFeedback === undefined ? {} : { flowFeedback }),
      };
    }
    return inputs;
  }, [
    applyDispatch,
    busy,
    formBlock,
    formCancelledRef,
    formFeedback,
    formOwners,
    launcherPlacements,
    choiceEvidenceFor,
    changeChoiceField,
    initializeChoiceForm,
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
    submitGuidedSummary,
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
    subject,
    onOpenApplication,
    unsavedWork,
    readBoardColumns,
    continueTablePage,
    bulk,
  ]);

  runtimeInputsRef.current = runtimeInputs;

  return { runtimeInputs };
}
