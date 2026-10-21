import {
  applicationSourceDocumentSchema,
  authoredRecordsTableEventAvailable,
  builderKeySchema,
  flowContractVersion,
  sourcePageItems,
  validateFlow,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
  type SourceFlow,
} from "@vortex/platform/schema";
import {
  studioQueryChoices,
  type StudioBorrowedChoices,
  type StudioQueryChoice,
} from "./contextual-palette";
import { studioOperationCallProperties } from "./application-flow-commands";
import { studioFlowCallerNames } from "./application-flow-start";
import { projectStudioFlowDraftChoices } from "./application-flow-step-form";
import { describeStudioFlowLocation, studioWords } from "./application-flow-model";
import {
  traverseStudioSemanticSelectionDraft,
  type StudioSemanticSelection,
} from "./semantic-selection";

/**
 * Creating a flow and binding it, the one way flows are created and bound:
 * - for an action control: an interactive flow started by the person, with the one step the builder
 *   chose (call an operation or show a message), and one flow binding of the control's action event to it (the existing `flow_bindings` model);
 *   on a record page the flow runs for the record the page shows, its `record_id` record input;
 * - for a board: an interactive flow bound to its card moves, with one Save record step that saves
 *   the moved card's new stage, so its pipeline and the action that owns the stage apply; it runs
 *   for the moved card, its `record` record input;
 * - for a control event with its steps given (a generated page's Open, New, Edit and Save): an
 *   interactive flow with exactly those inputs, steps and outputs, bound to that control event;
 * - for another control of an existing flow (each form of a guided form): one more binding;
 * - for a record event: a transaction flow an owned Module runs before one of its record types is
 *   saved, with one Warn step (the trigger is the flow's own `triggers`): a before-save rule, added
 *   on its record type in the Data tab.
 * Every binding declares its event. It names the board's or page's record type when there is one;
 * an ordinary page's component event has no record subject or carried fields.
 */

type SourceBinding = ApplicationSourceDocument["body"]["flow_bindings"][number];
/** A control event a flow can be bound to. */
export type StudioFlowControlEvent = SourceBinding["event"];
export type StudioFlowAuthoringEvent = Extract<
  StudioFlowControlEvent,
  | "action"
  | "card_moved"
  | "card_added"
  | "form_submit"
  | "row_clicked"
  | "row_action"
  | "inline_edit"
  | "row_edit"
>;

export const studioFlowEventLabels: Readonly<Record<StudioFlowAuthoringEvent, string>> = {
  action: "When used",
  card_moved: "When a card is moved",
  card_added: "When a card is added to a column",
  form_submit: "When submitted",
  row_clicked: "When a row is clicked",
  row_action: "Row action",
  inline_edit: "When a value is edited",
  row_edit: "When a row is saved",
};

/** Tables expose row actions through declared menu entries; other row surfaces use their own activation. */
const hasRowActionMenu = (item: ReturnType<typeof sourcePageItems>[number] | undefined): boolean =>
  item?.type === "platform.renderer.table";

/** Undefined means the control's record source cannot currently be resolved. */
const controlEventRecordType = (
  event: StudioFlowControlEvent,
  item: ReturnType<typeof sourcePageItems>[number] | undefined,
  pageRecord: string | null,
  queries: readonly StudioQueryChoice[],
): string | null | undefined => {
  const board = (item?.props as { features?: { board?: { column_field?: unknown } } } | undefined)
    ?.features?.board;
  const choiceField = board?.column_field;
  const boardRecord =
    typeof choiceField === "string" && choiceField.includes(".")
      ? choiceField.slice(0, choiceField.lastIndexOf("."))
      : undefined;
  if (event === "card_moved" || event === "card_added") return boardRecord;
  if (
    event === "row_clicked" ||
    event === "row_action" ||
    event === "inline_edit" ||
    event === "row_edit"
  ) {
    const queryRef = item?.props.vortex.query;
    // A query-bound row belongs to that query, even on a page of another record type.
    if (queryRef !== undefined)
      return queries.find((query) => query.reference === queryRef)?.recordType;
    return boardRecord ?? pageRecord;
  }
  return pageRecord;
};

/**
 * A board's card move and a table's inline edit on a record type save the change themselves: the
 * new flow gets its Save record step and takes no step chosen by the builder.
 */
export const studioFlowCreateSavesChange = (
  event: StudioFlowAuthoringEvent,
  recordType: string | null,
): boolean =>
  (event === "card_moved" || event === "inline_edit" || event === "row_edit") && recordType !== null;

export type StudioFlowCreateStep =
  | Readonly<{ kind: "operation"; operation: string }>
  | Readonly<{ kind: "message"; message: string }>;

export type StudioFlowCreateCommand =
  /** On a record page, the flow gets the record the page shows as its record_id input. */
  | Readonly<{
      kind: "action";
      controlAlias: string;
      name: string;
      recordType: string | null;
      event: StudioFlowAuthoringEvent;
      /**
       * The one step the flow starts with, chosen by the builder: an operation to call or a message
       * to show. A board's card move and a table's inline edit save the change and take none.
       */
      step?: StudioFlowCreateStep;
      rowActionLabel?: string;
    }>
  | Readonly<{
      kind: "control";
      controlAlias: string;
      event: StudioFlowControlEvent;
      name: string;
      description: string;
      inputs: SourceFlow["inputs"];
      tasks: SourceFlow["tasks"];
      outputs: SourceFlow["outputs"];
      bindingInputs: SourceBinding["inputs"];
      rowActionLabel?: string;
    }>
  | Readonly<{
      kind: "bind";
      controlAlias: string;
      event: StudioFlowControlEvent;
      flowKey: string;
      bindingInputs: SourceBinding["inputs"];
      rowActionLabel?: string;
    }>
  | Readonly<{
      kind: "before_save";
      moduleKey: string;
      recordTypeKey: string;
      name: string;
      message: string;
      operations: readonly ("create" | "update")[];
    }>;

export type StudioFlowCreateResult =
  | Readonly<{
      kind: "applied";
      source: ApplicationSourceDocument;
      selection: Extract<StudioSemanticSelection, { kind: "flow" }>;
      /** The binding made, for a command that binds a control: its alias and the event it declares. */
      binding?: Readonly<{ id: string; eventId: string }>;
    }>
  | Readonly<{ kind: "refused"; reason: string }>;

export type StudioFlowCreateChoices = Readonly<{
  /**
   * Action controls (buttons that are not a form's Save or Continue, which submit their form to
   * its own flow) with no flow bound yet; on a record page, the record type the page shows.
   */
  actions: readonly Readonly<{
    controlAlias: string;
    label: string;
    recordType: string | null;
    event: StudioFlowAuthoringEvent;
    rowActionMenu: boolean;
    callerNames: readonly Readonly<{ name: string; label: string }>[];
  }>[];
  /** The operations a new flow can call, by the key a Call protected operation step names. */
  operations: readonly Readonly<{ key: string; label: string }>[];
}>;

export const projectStudioFlowCreateChoices = (
  draft: Readonly<{
    rootId: Parameters<typeof traverseStudioSemanticSelectionDraft>[0]["rootId"];
    source: ApplicationSourceDocument;
    catalogue: ImmutablePlatformBlockCatalogue;
    borrowed: StudioBorrowedChoices | null;
  }>,
  controlLabel: (alias: string) => string,
): StudioFlowCreateChoices => {
  const bound = new Set(
    draft.source.body.flow_bindings.map((binding) => `${binding.control} ${binding.event}`),
  );
  const actions: StudioFlowCreateChoices["actions"][number][] = [];
  const queries = studioQueryChoices(draft.source, draft.borrowed);
  const forms = projectStudioFlowDraftChoices(draft).forms;
  const placements = new Map(
    draft.source.body.pages
      .flatMap((page) => sourcePageItems(page.composition))
      .map((item) => [item.props.id, item]),
  );
  traverseStudioSemanticSelectionDraft(draft, ({ phase, node }) => {
    if (phase !== "enter" || node.kind !== "placement") return;
    const alias = node.selection.placementAlias;
    const release = draft.catalogue.releases.find(
      (candidate) =>
        String(candidate.blockId) === node.block.block_id &&
        String(candidate.releaseVersion) === node.block.release_version,
    );
    const owner = node.owner;
    const page =
      owner.kind === "page"
        ? draft.source.body.pages.find((candidate) => candidate.id === owner.pageAlias)
        : undefined;
    const pageRecord =
      page?.type === "detail" && "record_type" in page && typeof page.record_type === "string"
        ? page.record_type
        : null;
    for (const event of Object.keys(studioFlowEventLabels) as StudioFlowAuthoringEvent[]) {
      const placed = placements.get(alias);
      if (
        release?.supportedEvents.includes(event) !== true ||
        (bound.has(`${alias} ${event}`) && !(event === "row_action" && hasRowActionMenu(placed))) ||
        (event === "action" && node.settings.action_kind === "submit") ||
        // The action that saves an inline edit belongs to the feature, so it is offered while on;
        // a card added from a column is offered while the board's quick add is on.
        ((event === "inline_edit" || event === "row_edit" || event === "card_added") &&
          (placed === undefined || !authoredRecordsTableEventAvailable(placed.props, event)))
      )
        continue;
      const recordType = controlEventRecordType(event, placements.get(alias), pageRecord, queries);
      if (recordType === undefined) continue;
      actions.push({
        controlAlias: alias,
        label: controlLabel(alias),
        recordType,
        event,
        rowActionMenu: event === "row_action" && hasRowActionMenu(placements.get(alias)),
        callerNames: studioFlowCallerNames(
          event,
          forms.find((form) => form.alias === alias)?.fields,
        ),
      });
    }
  });
  const operations = draft.source.body.modules.flatMap((module) =>
    module.actions.map((action) => ({ key: action.key, label: action.label })),
  );
  return { actions, operations };
};

/** A builder key from a name, unique among the taken ones. */
const keyFrom = (name: string, taken: ReadonlySet<string>): string | undefined => {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^[^a-z]+|_+$/g, "")
      .slice(0, 34)
      .replace(/_+$/g, "") || "flow";
  for (let n = 1; n < 1000; n += 1) {
    const candidate = n === 1 ? base : `${base}_${n}`;
    if (!taken.has(candidate) && builderKeySchema.safeParse(candidate).success) return candidate;
  }
  return undefined;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const message = (value: string) => ({
  kind: "literal" as const,
  literal: { type: "text" as const, value },
});

class FlowCreateRefusal extends Error {}
const refuse = (reason: string): never => {
  throw new FlowCreateRefusal(reason);
};

/**
 * Binds one control event to a flow: a fresh binding alias, an event alias and its declaration,
 * with the record subject when the control has one.
 */
const bindControl = (
  source: ApplicationSourceDocument,
  controlAlias: string,
  event: StudioFlowControlEvent,
  flowKey: string,
  inputs: SourceBinding["inputs"],
  borrowed: StudioBorrowedChoices | null,
  rowActionLabel?: string,
): Readonly<{ id: string; eventId: string }> => {
  const body = source.body;
  const page = body.pages.find((candidate) =>
    sourcePageItems(candidate.composition).some((item) => item.props.id === controlAlias),
  );
  const item =
    page === undefined
      ? undefined
      : sourcePageItems(page.composition).find((entry) => entry.props.id === controlAlias);
  const rowActionMenu = event === "row_action" && hasRowActionMenu(item);
  if (
    !rowActionMenu &&
    body.flow_bindings.some(
      (binding) => binding.control === controlAlias && binding.event === event,
    )
  )
    refuse(
      event === "action"
        ? "This control already runs a flow when it is used. Open that flow and change it instead."
        : event === "card_moved"
          ? "This board already runs a flow when a card is moved. Open that flow and change it instead."
          : "This control already runs a flow for that event. Open that flow and change it instead.",
    );
  const aliases = new Set([
    ...body.flow_bindings.flatMap((binding) => [binding.id, binding.event_id]),
    ...body.events.map((entry) => entry.id),
  ]);
  const id = keyFrom(`binding_${flowKey}`, aliases);
  if (id === undefined)
    return refuse("No free name could be made for the binding. Choose another name.");
  const label = rowActionLabel?.trim();
  if (event === "row_action" && item === undefined)
    return refuse("The row action's control is no longer on the page.");
  if (rowActionMenu && item !== undefined) {
    if (label === undefined || label.length === 0 || label.length > 60)
      return refuse("Name the row action menu item, in at most 60 characters.");
    if (item.props.row_actions !== undefined && !Array.isArray(item.props.row_actions))
      return refuse(
        "The control's row actions are not a list. Correct them before binding a flow.",
      );
    if (Array.isArray(item.props.row_actions) && item.props.row_actions.length >= 20)
      return refuse("A control can have at most 20 row actions.");
  }
  const pageRecord =
    page !== undefined && "record_type" in page && typeof page.record_type === "string"
      ? page.record_type
      : null;
  const resolved = controlEventRecordType(
    event,
    item,
    pageRecord,
    studioQueryChoices(source, borrowed),
  );
  if (resolved === undefined)
    return refuse(
      event === "card_moved" || event === "card_added"
        ? "Choose the board's choice field first."
        : "The row's query could not be resolved. Reload the draft and choose its query before binding a flow.",
    );
  const recordType = resolved ?? undefined;
  // A binding is unique by its control and event, so every control of one record type raising one
  // kind of event shares that record type's one declared event of that kind.
  const declared = new Set(
    body.events.filter((entry) => entry.record_type === recordType).map((entry) => entry.id),
  );
  const shared =
    rowActionMenu || recordType === undefined
      ? undefined
      : body.flow_bindings.find(
          (binding) => binding.event === event && declared.has(binding.event_id),
        )?.event_id;
  // A block with one row action names its event in `row_action_event_id`: the binding takes that
  // identity (the setting stays when the binding is removed), or the block gets the new one.
  const blockRowAction =
    event === "row_action" && !rowActionMenu && item !== undefined
      ? item.props.row_action_event_id
      : undefined;
  const blockEventId =
    typeof blockRowAction === "string" && blockRowAction.trim().length > 0
      ? blockRowAction.trim()
      : undefined;
  const eventId =
    blockEventId ??
    shared ??
    keyFrom(
      rowActionMenu || recordType === undefined
        ? `event_${flowKey}`
        : `event_${recordType.slice(recordType.lastIndexOf(":") + 1)}_${event}`,
      aliases,
    );
  if (eventId === undefined)
    return refuse("No free name could be made for the binding's event. Choose another name.");
  if (!body.events.some((entry) => entry.id === eventId)) {
    if (body.events.length >= 100)
      refuse("An application can declare at most 100 events, so no more controls can be bound.");
    body.events.push({
      id: eventId,
      key: `vortex.app.events.${eventId}`,
      label: studioWords(event),
      ...(recordType === undefined ? {} : { record_type: recordType }),
      carries: [],
      personal_or_sensitive_values_allowed: false,
    });
  }
  body.flow_bindings.push({
    id,
    control: controlAlias,
    event_id: eventId,
    event,
    flow: flowKey,
    inputs,
  });
  if (event === "row_action" && !rowActionMenu && item !== undefined)
    (item.props as Record<string, unknown>).row_action_event_id = eventId;
  if (event === "row_clicked") {
    if (item !== undefined) item.props.row_click = { mode: "flow", event_id: eventId };
  }
  if (event === "inline_edit" || event === "row_edit") {
    if (item === undefined) return refuse("The table is no longer on the page.");
    // The table names the action that saves a change in its Inline editing feature.
    const props = item.props as Record<string, unknown>;
    const features = isPlainRecord(props.features) ? props.features : {};
    const feature = isPlainRecord(features[event]) ? features[event] : {};
    props.features = { ...features, [event]: { ...feature, event_id: eventId } };
  }
  if (rowActionMenu && item !== undefined) {
    const features = isPlainRecord(item.props.features) ? item.props.features : {};
    item.props.features = { ...features, row_actions: { enabled: true } };
    item.props.row_actions = [
      ...(Array.isArray(item.props.row_actions) ? item.props.row_actions : []),
      { event_id: eventId, label, icon: "workflow", placement: "menu" },
    ];
  }
  return { id, eventId };
};

const interactiveFlow = (
  key: string,
  name: string,
  parts: Pick<SourceFlow, "inputs" | "tasks" | "outputs"> &
    Readonly<{ description?: string; recordInput?: string }>,
): SourceFlow => ({
  contractVersion: flowContractVersion,
  id: key,
  key,
  ...(parts.description === undefined ? {} : { description: parts.description }),
  labels: { name },
  execution: "interactive",
  runAs: { kind: "initiator" },
  inputs: parts.inputs,
  ...(parts.recordInput === undefined ? {} : { recordInput: parts.recordInput }),
  variables: {},
  triggers: [],
  tasks: parts.tasks,
  outputs: parts.outputs,
  errors: [],
  finally: [],
});

const created = (
  candidate: ApplicationSourceDocument,
  flow: SourceFlow,
  moduleKey: string | null,
  binding: Readonly<{ id: string; eventId: string }> | undefined,
): StudioFlowCreateResult => {
  const parsed = applicationSourceDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      kind: "refused",
      reason:
        first === undefined
          ? "The draft is not valid with this flow."
          : `The new flow is not valid: ${first.message} (${first.path.map(String).join(", ")}).`,
    };
  }
  const issue = validateFlow(flow)[0];
  if (issue !== undefined)
    return {
      kind: "refused",
      reason: `${describeStudioFlowLocation(flow, issue.path)}: ${issue.message}.`,
    };
  return {
    kind: "applied",
    source: parsed.data,
    selection: { kind: "flow", flowAlias: flow.id, moduleKey },
    ...(binding === undefined ? {} : { binding }),
  };
};

export const applyStudioFlowCreate = (
  source: Readonly<ApplicationSourceDocument>,
  command: StudioFlowCreateCommand,
  borrowed: StudioBorrowedChoices | null,
): StudioFlowCreateResult => {
  try {
    const candidate: ApplicationSourceDocument = structuredClone(source);
    const body = candidate.body;
    if (command.kind === "bind") {
      const flow = body.flows.find((entry) => entry.key === command.flowKey);
      if (flow === undefined)
        return { kind: "refused", reason: "That flow is no longer in the draft." };
      return created(
        candidate,
        flow,
        null,
        bindControl(
          candidate,
          command.controlAlias,
          command.event,
          flow.key,
          command.bindingInputs,
          borrowed,
          command.rowActionLabel,
        ),
      );
    }
    const name = command.name.trim();
    if (name.length < 1 || name.length > 100)
      return { kind: "refused", reason: "Name the flow, in at most 100 characters." };
    if (command.kind === "before_save") {
      if (!command.message.trim())
        return { kind: "refused", reason: "Write the warning message before adding the rule." };
      const module = body.modules.find((entry) => entry.key === command.moduleKey);
      if (module === undefined)
        return {
          kind: "refused",
          reason: "This application does not own that module, so it cannot hold a flow for it.",
        };
      if (!module.record_types.some((recordType) => recordType.key === command.recordTypeKey))
        return { kind: "refused", reason: "That record type is not in the module." };
      if (command.operations.length === 0)
        return {
          kind: "refused",
          reason: "Choose when the flow runs: when a record is created, changed, or both.",
        };
      const key = keyFrom(name, new Set(module.flows.flatMap((entry) => [entry.id, entry.key])));
      if (key === undefined)
        return {
          kind: "refused",
          reason: "No free name could be made for this flow. Choose another name.",
        };
      const flow: SourceFlow = {
        contractVersion: flowContractVersion,
        id: key,
        key,
        labels: { name },
        execution: "transaction",
        runAs: { kind: "saver" },
        inputs: {},
        variables: {},
        outputs: {},
        errors: [],
        finally: [],
        triggers: [
          {
            id: "before_save",
            type: "BeforeSave",
            recordTypeId: command.recordTypeKey,
            inputs: {},
            operations: command.operations.map((kind) => ({ kind })),
            priority: 100,
          },
        ],
        tasks: [
          {
            id: "warn",
            type: "rule.warn",
            version: "1.0.0",
            properties: { message: message(command.message.trim()) },
          },
        ],
      };
      module.flows.push(flow);
      return created(candidate, flow, module.key, undefined);
    }
    if (command.kind === "action" && command.event === "card_moved" && command.recordType === null)
      return { kind: "refused", reason: "Choose the board's choice field first." };
    if (
      command.kind === "action" &&
      (command.event === "inline_edit" || command.event === "row_edit") &&
      command.recordType === null
    )
      return { kind: "refused", reason: "Choose the table's query first." };
    const key = keyFrom(name, new Set(body.flows.flatMap((entry) => [entry.id, entry.key])));
    if (key === undefined)
      return {
        kind: "refused",
        reason: "No free name could be made for this flow. Choose another name.",
      };
    let flow: SourceFlow;
    let binding: Readonly<{ id: string; eventId: string }>;
    if (
      command.kind === "action" &&
      command.recordType !== null &&
      studioFlowCreateSavesChange(command.event, command.recordType)
    ) {
      // A board's card move and a table's inline edit each save the changed value of one record
      // through the one Save record task: the record and the changed field with its new value.
      flow = interactiveFlow(key, name, {
        outputs: {},
        recordInput: "record",
        inputs: {
          record: { type: "record_reference", required: true, recordTypeIds: [command.recordType] },
          values: { type: "json", required: true },
        },
        tasks: [
          {
            id: command.event === "card_moved" ? "save_stage" : "save_edit",
            type: "record.save",
            version: "1.0.0",
            properties: {
              record_type: {
                kind: "literal",
                literal: { type: "text", value: command.recordType },
              },
              record: { kind: "reference", reference: { source: "input", name: "record" } },
              values: { kind: "reference", reference: { source: "input", name: "values" } },
            },
          },
        ] as SourceFlow["tasks"],
      });
      binding = bindControl(
        candidate,
        command.controlAlias,
        command.event,
        key,
        {
          record: { kind: "caller", name: "record_id" },
          values: { kind: "caller", name: "values" },
        },
        borrowed,
      );
    } else if (command.kind === "action") {
      flow = interactiveFlow(key, name, {
        outputs: {},
        ...(command.recordType === null || command.event === "card_added"
          ? {}
          : { recordInput: "record_id" }),
        inputs:
          command.event === "card_added"
            ? { stage: { type: "text", required: true } }
            : command.recordType === null
              ? {}
              : {
                  record_id: {
                    type: "record_reference",
                    required: true,
                    recordTypeIds: [command.recordType],
                  },
                },
        tasks: [],
      });
      const step = command.step;
      if (step === undefined)
        return refuse("Choose what the flow does: run an operation or show a message.");
      if (step.kind === "message") {
        if (!step.message.trim()) return refuse("Write the message the flow shows.");
        flow.tasks = [
          {
            id: "show_message",
            type: "interface.show_message",
            version: "1.0.0",
            properties: { message: message(step.message.trim()) },
          },
        ];
      } else {
        const operation = body.modules
          .flatMap((module) => module.actions)
          .find((entry) => entry.key === step.operation);
        if (operation === undefined)
          return refuse("That operation is no longer in the application.");
        flow.tasks = [
          {
            id: "run_operation",
            type: "operation.call",
            version: "1.0.0",
            properties: studioOperationCallProperties(flow, operation),
          },
        ];
      }
      if (command.event === "form_submit") {
        flow.inputs = { ...flow.inputs, values: { type: "json", required: true } };
      }
      binding = bindControl(
        candidate,
        command.controlAlias,
        command.event,
        key,
        command.event === "form_submit"
          ? {
              values: { kind: "caller", name: "values" },
              ...(command.recordType === null
                ? {}
                : { record_id: { kind: "caller" as const, name: "record" } }),
            }
          : command.event === "card_added"
            ? { stage: { kind: "caller", name: "value" } }
            : command.recordType === null
              ? {}
              : { record_id: { kind: "caller", name: "record_id" } },
        borrowed,
        command.rowActionLabel,
      );
    } else {
      flow = interactiveFlow(key, name, {
        description: command.description,
        inputs: command.inputs,
        tasks: command.tasks,
        outputs: command.outputs,
      });
      binding = bindControl(
        candidate,
        command.controlAlias,
        command.event,
        key,
        command.bindingInputs,
        borrowed,
        command.rowActionLabel,
      );
    }
    body.flows.push(flow);
    return created(candidate, flow, null, binding);
  } catch (error) {
    if (error instanceof FlowCreateRefusal) return { kind: "refused", reason: error.message };
    throw error;
  }
};
