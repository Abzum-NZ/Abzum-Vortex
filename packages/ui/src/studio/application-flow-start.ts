import { recordsTableInlineEditEvent, recordsTableRowEditEvent } from "@vortex/platform/schema";
import {
  builderKeySchema,
  flowLiteralSchema,
  workflowValueTypeSchema,
  type ApplicationSourceDocument,
  type FlowBeforeSaveOperation,
  type FlowLiteral,
  type SourceFlow,
} from "@vortex/platform/schema";
import type { StudioSemanticSelection } from "./semantic-selection";
import { syncStudioRecordRuleLists } from "./application-record-rules";
import {
  sameStudioFlowContext,
  studioFlowCollection,
  studioWords,
  validatedStudioFlowEdit,
  type StudioFlowContext,
  type StudioFlowEditResult,
  type StudioFlowSelection,
} from "./application-flow-model";

/**
 * How a flow starts, as the Start node's inspector edits it: the flow's name, the inputs it
 * declares, the input that names the record an interactive flow runs for (whose fields its steps
 * then read), where each input of each binding comes from (what the control that starts it
 * supplies, or a fixed value), and its record triggers (before a record is saved, after a record
 * event).
 * A change is one edit of the stored flow and its bindings, checked as every flow edit is.
 */

type FlowTrigger = SourceFlow["triggers"][number];
type Binding = ApplicationSourceDocument["body"]["flow_bindings"][number];

/**
 * One declared input. `id` is the input's identity in this form (its stored name, or a new one for
 * an added input): binding sources are keyed by it, so renaming an input carries them along.
 */
export type StudioFlowInputDraft = Readonly<{
  id: string;
  name: string;
  type: string;
  required: boolean;
  recordType: string | null;
}>;

/** Where one binding input comes from: a value the control supplies by name, a fixed value, or nothing. */
export type StudioFlowBindingInputDraft =
  | Readonly<{ kind: "caller"; name: string }>
  | Readonly<{ kind: "fixed"; literal: FlowLiteral }>
  | Readonly<{ kind: "none" }>;

export type StudioFlowTriggerDraft =
  | Readonly<{
      kind: "before_save";
      recordType: string;
      /** The record writes it covers; the order it runs in is its record type's rule list. */
      operations: readonly FlowBeforeSaveOperation[];
    }>
  | Readonly<{ kind: "event"; recordType: string; eventKind: string }>
  | Readonly<{ kind: "declared_event"; recordType: string; eventKey: string }>;

/** A control that starts the flow; `inputs` is keyed by the input's form identity (`StudioFlowInputDraft.id`). */
export type StudioFlowBindingDraft = Readonly<{
  id: string;
  control: string;
  event: string;
  inputs: Readonly<Record<string, StudioFlowBindingInputDraft>>;
}>;

export type StudioFlowStartDraft = Readonly<{
  name: string;
  inputs: readonly StudioFlowInputDraft[];
  /** The form identity of the input that names the record the flow runs for, or null for none. */
  recordInput: string | null;
  bindings: readonly StudioFlowBindingDraft[];
  triggers: readonly StudioFlowTriggerDraft[];
}>;

export type StudioFlowStartProjection =
  | Readonly<{
      kind: "available";
      draft: StudioFlowStartDraft;
      execution: SourceFlow["execution"];
      /** Declared events, each with its record type as this flow's triggers name it. */
      events: readonly Readonly<{ key: string; label: string; recordType: string }>[];
      /** For each binding, the values its control supplies by name. */
      callerNames: Readonly<Record<string, readonly Readonly<{ name: string; label: string }>[]>>;
    }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

/** What a control supplies to the flow it starts, by event, as the page runtime fills it. */
const suppliedByEvent: Readonly<
  Record<string, readonly Readonly<{ name: string; label: string }>[]>
> = {
  action: [
    { name: "record_id", label: "The record the page shows" },
    { name: "values", label: "The answers of the form it sits in" },
  ],
  form_submit: [
    { name: "values", label: "All the answers of the form" },
    { name: "record", label: "The record the form edits" },
    { name: "selected_owner_group_id", label: "The owner group chosen on the form" },
  ],
  row_clicked: [{ name: "record_id", label: "The clicked record" }],
  row_action: [{ name: "record_id", label: "The record of the row" }],
  card_moved: [
    { name: "record_id", label: "The moved record" },
    { name: "values", label: "The card's new values" },
    { name: "value", label: "The column it was dropped in" },
  ],
  card_added: [{ name: "value", label: "The column the card is added to" }],
  [recordsTableRowEditEvent]: [
    { name: "record_id", label: "The edited record" },
    { name: "values", label: "All changed fields of the row" },
  ],
  [recordsTableInlineEditEvent]: [
    { name: "record_id", label: "The edited record" },
    { name: "values", label: "The edited values" },
  ],
};

export const studioFlowCallerNames = (
  event: string,
  fields: readonly Readonly<{ name: string; label: string }>[] = [],
): readonly Readonly<{ name: string; label: string }>[] => {
  const supplied = [...(suppliedByEvent[event] ?? [])];
  if (event === "form_submit")
    for (const field of fields)
      if (!supplied.some((entry) => entry.name === field.name))
        supplied.push({ name: field.name, label: `The form's ${field.label}` });
  return supplied;
};

const triggerDraft = (trigger: FlowTrigger): StudioFlowTriggerDraft => {
  if (trigger.type === "BeforeSave")
    return {
      kind: "before_save",
      recordType: trigger.recordTypeId,
      operations: trigger.operations.map((operation) => operation.kind),
    };
  if (trigger.type === "Event" && trigger.event.kind === "standard")
    return { kind: "event", recordType: trigger.recordTypeId, eventKind: trigger.event.eventKind };
  if (trigger.type === "Event" && trigger.event.kind === "declared")
    return {
      kind: "declared_event",
      recordType: trigger.recordTypeId,
      eventKey: trigger.event.eventKey,
    };
  throw new TypeError("The flow contains an unknown start type.");
};

const bindingInputDraft = (
  input: Binding["inputs"][string] | undefined,
): StudioFlowBindingInputDraft => {
  if (input === undefined) return { kind: "none" };
  if (typeof input === "object" && input !== null && "kind" in input) {
    if (input.kind === "caller") return { kind: "caller", name: input.name };
    if (input.kind === "literal") return { kind: "fixed", literal: input.literal };
  }
  return { kind: "none" };
};

/** Every input reference under a value, written typed or as the closed text, renamed. */
const renameInputReferences = (value: unknown, renames: ReadonlyMap<string, string>): unknown => {
  if (typeof value === "string") {
    const match = /^{{s*inputs.([a-z][a-z0-9_]*)s*}}$/.exec(value);
    const next = match === null ? undefined : renames.get(match[1]!);
    return next === undefined ? value : `{{ inputs.${next} }}`;
  }
  if (Array.isArray(value)) return value.map((item) => renameInputReferences(item, renames));
  if (value === null || typeof value !== "object") return value;
  const entry = value as Record<string, unknown>;
  if (entry.source === "input" && typeof entry.name === "string" && renames.has(entry.name))
    return { ...entry, name: renames.get(entry.name) };
  return Object.fromEntries(
    Object.entries(entry).map(([key, child]) => [key, renameInputReferences(child, renames)]),
  );
};

const flowOf = (
  source: Readonly<ApplicationSourceDocument>,
  selection: StudioFlowSelection,
): SourceFlow | undefined =>
  studioFlowCollection(source, selection.moduleKey)?.find(
    (candidate) => candidate.id === selection.flowAlias,
  );

/** The Start inspector's form for a flow. */
/** A record type as a trigger of this flow names it: bare inside its own Module, else `module:record`. */
const triggerRecordType = (
  selection: StudioFlowSelection,
  moduleKey: string,
  record: string,
): string | undefined =>
  selection.moduleKey === null
    ? `${moduleKey}:${record}`
    : selection.moduleKey === moduleKey
      ? record
      : undefined;

export const projectStudioFlowStart = (
  source: Readonly<ApplicationSourceDocument>,
  selection: StudioFlowSelection,
  formFields: (controlAlias: string) => readonly Readonly<{ name: string; label: string }>[],
): StudioFlowStartProjection => {
  const flow = flowOf(source, selection);
  if (flow === undefined)
    return { kind: "unavailable", reason: "This flow is no longer in the draft." };
  const bindings =
    selection.moduleKey !== null
      ? []
      : source.body.flow_bindings.filter(
          (binding) => binding.flow === flow.id || binding.flow === flow.key,
        );
  const inputs = Object.entries(flow.inputs ?? {}).map(([name, declaration]) => ({
    id: name,
    name,
    type: declaration.type,
    required: declaration.required,
    recordType: declaration.recordTypeIds?.[0] ?? null,
  }));
  return {
    kind: "available",
    execution: flow.execution,
    events: source.body.modules.flatMap((module) =>
      module.events.flatMap((event) => {
        const recordType = triggerRecordType(selection, module.key, event.record_type);
        return recordType === undefined ? [] : [{ key: event.key, label: event.label, recordType }];
      }),
    ),
    draft: {
      name: flow.labels?.name ?? studioWords(flow.key),
      inputs,
      recordInput: flow.recordInput ?? null,
      bindings: bindings.map((binding) => ({
        id: binding.id,
        control: binding.control,
        event: binding.event,
        inputs: Object.fromEntries(
          inputs.map((input) => [input.id, bindingInputDraft(binding.inputs[input.name])]),
        ),
      })),
      triggers: (flow.triggers ?? []).map(triggerDraft),
    },
    callerNames: Object.fromEntries(
      bindings.map((binding) => {
        return [binding.id, studioFlowCallerNames(binding.event, formFields(binding.control))];
      }),
    ),
  };
};

/** Writes the Start inspector's form back to the flow and its bindings, then checks the flow. */
export const applyStudioFlowStart = (
  current: StudioFlowContext,
  expected: StudioFlowContext,
  selection: StudioSemanticSelection | null,
  expectedSelection: StudioFlowSelection,
  draft: StudioFlowStartDraft,
): StudioFlowEditResult => {
  if (!sameStudioFlowContext(current, expected, selection, expectedSelection))
    return { kind: "stale", reason: "The draft changed. Open the flow again and retry." };
  const candidate: ApplicationSourceDocument = structuredClone(current.source);
  const flow = flowOf(candidate, expectedSelection);
  if (flow === undefined) return { kind: "stale", reason: "This flow is no longer in the draft." };
  const name = draft.name.trim();
  if (name.length < 1 || name.length > 100)
    return {
      kind: "invalid",
      reason: "How it starts, Name: name the flow in at most 100 characters.",
    };
  flow.labels = { ...flow.labels, name };
  const inputs: SourceFlow["inputs"] = {};
  for (const input of draft.inputs) {
    const where = `How it starts, input ${studioWords(input.name)}`;
    if (!builderKeySchema.safeParse(input.name).success)
      return {
        kind: "invalid",
        reason: `${where}: name it with lowercase words joined by underscores, such as record_id.`,
      };
    if (Object.hasOwn(inputs, input.name))
      return {
        kind: "invalid",
        reason: `${where}: two inputs have this name. Name each input once.`,
      };
    const type = workflowValueTypeSchema.safeParse(input.type);
    if (!type.success)
      return { kind: "invalid", reason: `${where}: choose what kind of value it is.` };
    const listsRecords = type.data === "record_reference" || type.data === "record_reference_list";
    if (listsRecords && input.recordType === null)
      return { kind: "invalid", reason: `${where}: choose the record type it names.` };
    const before = Object.hasOwn(flow.inputs ?? {}, input.id) ? flow.inputs[input.id] : undefined;
    inputs[input.name] = {
      ...(before?.description === undefined ? {} : { description: before.description }),
      type: type.data,
      required: input.required,
      ...(listsRecords ? { recordTypeIds: [input.recordType!] } : {}),
    };
  }
  // A renamed input keeps what reads it: every step and output reference follows the new name.
  const renames = new Map(
    draft.inputs
      .filter((input) => input.id !== input.name && Object.hasOwn(flow.inputs ?? {}, input.id))
      .map((input) => [input.id, input.name]),
  );
  flow.inputs = inputs;
  if (draft.recordInput === null) delete flow.recordInput;
  else {
    const recordInput = draft.inputs.find((input) => input.id === draft.recordInput);
    if (
      recordInput === undefined ||
      recordInput.type !== "record_reference" ||
      !recordInput.required
    )
      return {
        kind: "invalid",
        reason: "How it starts, Runs for: choose a required input that names one record.",
      };
    flow.recordInput = recordInput.name;
  }
  if (renames.size > 0) {
    const renamed = renameInputReferences(
      { tasks: flow.tasks, errors: flow.errors, finally: flow.finally, outputs: flow.outputs },
      renames,
    ) as Pick<SourceFlow, "tasks" | "errors" | "finally" | "outputs">;
    Object.assign(flow, renamed);
  }
  for (const bindingDraft of draft.bindings) {
    const binding = candidate.body.flow_bindings.find((entry) => entry.id === bindingDraft.id);
    if (binding === undefined)
      return {
        kind: "stale",
        reason: "A control that starts this flow changed. Open the flow again.",
      };
    const next: Binding["inputs"] = {};
    for (const input of draft.inputs) {
      const value = bindingDraft.inputs[input.id] ?? { kind: "none" as const };
      const inputName = input.name;
      if (value.kind === "none") continue;
      if (value.kind === "caller") {
        if (!builderKeySchema.safeParse(value.name).success)
          return {
            kind: "invalid",
            reason: `How it starts, input ${studioWords(inputName)}: choose what the control supplies.`,
          };
        next[inputName] = { kind: "caller", name: value.name };
      } else {
        if (!flowLiteralSchema.safeParse(value.literal).success)
          return {
            kind: "invalid",
            reason: `How it starts, input ${studioWords(inputName)}: this fixed value does not fit its kind.`,
          };
        next[inputName] = { kind: "literal", literal: value.literal };
      }
    }
    for (const [inputName, declaration] of Object.entries(inputs))
      if (declaration.required && !Object.hasOwn(next, inputName))
        return {
          kind: "invalid",
          reason: `How it starts, input ${studioWords(inputName)}: it is required, so say where it comes from when the control is used.`,
        };
    binding.inputs = next;
  }
  if (draft.triggers.length !== (flow.triggers ?? []).length)
    return { kind: "stale", reason: "The triggers of this flow changed. Open the flow again." };
  for (const trigger of draft.triggers) {
    if (trigger.kind === "declared_event" && trigger.eventKey === "")
      return {
        kind: "invalid",
        reason: "How it starts: choose the event of this record type that starts the flow.",
      };
  }
  flow.triggers = (flow.triggers ?? []).map((trigger, index): FlowTrigger => {
    const edited = draft.triggers[index]!;
    if (edited.kind === "before_save" && trigger.type === "BeforeSave")
      return {
        ...trigger,
        recordTypeId: edited.recordType,
        operations: edited.operations.map((kind) => ({ kind })),
      };
    if (edited.kind === "event" && trigger.type === "Event")
      return {
        ...trigger,
        recordTypeId: edited.recordType,
        event: { kind: "standard", eventKind: edited.eventKind as never },
      };
    if (edited.kind === "declared_event" && trigger.type === "Event")
      return {
        ...trigger,
        recordTypeId: edited.recordType,
        event: { kind: "declared", eventKey: edited.eventKey },
      };
    return trigger;
  });
  for (const [index, trigger] of (flow.triggers ?? []).entries())
    if (trigger.type === "BeforeSave" && trigger.operations.length === 0)
      return {
        kind: "invalid",
        reason: `How it starts, trigger ${index + 1}: choose when it runs, when a record is created, changed, or both.`,
      };
  // A rule that moved to another record type leaves the old one's run order and runs last in the new.
  const module = candidate.body.modules.find((entry) => entry.key === expectedSelection.moduleKey);
  if (module !== undefined) syncStudioRecordRuleLists(module);
  return validatedStudioFlowEdit(
    candidate,
    current.source,
    expectedSelection,
    flow.tasks[0]?.id ?? "",
    current,
  );
};
