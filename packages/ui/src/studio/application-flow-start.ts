import {
  builderKeySchema,
  flowLiteralSchema,
  workflowValueTypeSchema,
  type ApplicationSourceDocument,
  type FlowLiteral,
  type SourceFlow,
} from "@vortex/platform/schema";
import type { StudioSemanticSelection } from "./semantic-selection";
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
 * declares, where each input of each binding comes from (what the control that starts it supplies,
 * or a fixed value), and its record triggers (before a record is saved, after a record event).
 * A change is one edit of the stored flow and its bindings, checked as every flow edit is.
 */

type FlowTrigger = SourceFlow["triggers"][number];
type Binding = ApplicationSourceDocument["body"]["flow_bindings"][number];

/**
 * One declared input. `id` is the input's identity in this form (its stored name, or a new one for
 * an added input): binding sources are keyed by it, so renaming an input carries them along.
 */
export type StudioFlowInputDraft = Readonly<{ id: string; name: string; type: string; required: boolean; recordType: string | null }>;

/** Where one binding input comes from: a value the control supplies by name, a fixed value, or nothing. */
export type StudioFlowBindingInputDraft =
  | Readonly<{ kind: "caller"; name: string }>
  | Readonly<{ kind: "fixed"; literal: FlowLiteral }>
  | Readonly<{ kind: "none" }>;

export type StudioFlowTriggerDraft =
  | Readonly<{ kind: "before_save"; recordType: string; create: boolean; update: boolean; priority: number }>
  | Readonly<{ kind: "event"; recordType: string; eventKind: string }>
  /** A trigger the Start inspector shows but does not change (a schedule, an incoming message, an action transition). */
  | Readonly<{ kind: "kept"; description: string }>;

/** A control that starts the flow; `inputs` is keyed by the input's form identity (`StudioFlowInputDraft.id`). */
export type StudioFlowBindingDraft = Readonly<{ id: string; control: string; event: string;
  inputs: Readonly<Record<string, StudioFlowBindingInputDraft>> }>;

export type StudioFlowStartDraft = Readonly<{
  name: string;
  inputs: readonly StudioFlowInputDraft[];
  bindings: readonly StudioFlowBindingDraft[];
  triggers: readonly StudioFlowTriggerDraft[];
}>;

export type StudioFlowStartProjection =
  | Readonly<{ kind: "available"; draft: StudioFlowStartDraft; execution: SourceFlow["execution"];
      /** For each binding, the values its control supplies by name. */
      callerNames: Readonly<Record<string, readonly Readonly<{ name: string; label: string }>[]>> }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

/** What a control supplies to the flow it starts, by event, as the page runtime fills it. */
const suppliedByEvent: Readonly<Record<string, readonly Readonly<{ name: string; label: string }>[]>> = {
  action: [{ name: "record_id", label: "The record the page shows" }, { name: "values", label: "The answers of the form it sits in" }],
  form_submit: [{ name: "values", label: "All the answers of the form" }, { name: "record", label: "The record the form edits" },
    { name: "selected_owner_group_id", label: "The owner group chosen on the form" }],
  row_clicked: [{ name: "record_id", label: "The clicked record" }],
  row_action: [{ name: "record_id", label: "The record of the row" }],
  bulk_action: [{ name: "record_ids", label: "The selected records" }],
  card_moved: [{ name: "record_id", label: "The moved record" }, { name: "values", label: "The card's new values" },
    { name: "value", label: "The column it was dropped in" }],
  inline_edit: [{ name: "record_id", label: "The edited record" }, { name: "values", label: "The edited values" }],
};

const triggerDraft = (trigger: FlowTrigger): StudioFlowTriggerDraft => {
  if (trigger.type === "BeforeSave" && trigger.operations.every((operation) => operation.kind !== "transition"))
    return { kind: "before_save", recordType: trigger.recordTypeId, create: trigger.operations.some((operation) => operation.kind === "create"),
      update: trigger.operations.some((operation) => operation.kind === "update"), priority: trigger.priority };
  if (trigger.type === "Event" && trigger.event.kind === "standard")
    return { kind: "event", recordType: trigger.recordTypeId, eventKind: trigger.event.eventKind };
  return { kind: "kept", description: trigger.type === "Schedule" ? "On a schedule" : trigger.type === "IncomingMessage"
    ? "When a message arrives" : trigger.type === "Event" ? "After a declared event" : "Before a named action moves a record on" };
};

const bindingInputDraft = (input: Binding["inputs"][string] | undefined): StudioFlowBindingInputDraft => {
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
  return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, renameInputReferences(child, renames)]));
};

const flowOf = (source: Readonly<ApplicationSourceDocument>, selection: StudioFlowSelection): SourceFlow | undefined =>
  studioFlowCollection(source, selection.moduleKey)?.find((candidate) => candidate.id === selection.flowAlias);

/** The Start inspector's form for a flow. */
export const projectStudioFlowStart = (
  source: Readonly<ApplicationSourceDocument>,
  selection: StudioFlowSelection,
  formFields: (controlAlias: string) => readonly Readonly<{ name: string; label: string }>[],
): StudioFlowStartProjection => {
  const flow = flowOf(source, selection);
  if (flow === undefined) return { kind: "unavailable", reason: "This flow is no longer in the draft." };
  const bindings = selection.moduleKey !== null ? [] : source.body.flow_bindings.filter((binding) =>
    binding.flow === flow.id || binding.flow === flow.key);
  const inputs = Object.entries(flow.inputs ?? {}).map(([name, declaration]) => ({ id: name, name, type: declaration.type,
    required: declaration.required, recordType: declaration.recordTypeIds?.[0] ?? null }));
  return {
    kind: "available",
    execution: flow.execution,
    draft: {
      name: flow.labels?.name ?? studioWords(flow.key),
      inputs,
      bindings: bindings.map((binding) => ({ id: binding.id, control: binding.control, event: binding.event,
        inputs: Object.fromEntries(inputs.map((input) => [input.id, bindingInputDraft(binding.inputs[input.name])])) })),
      triggers: (flow.triggers ?? []).map(triggerDraft),
    },
    callerNames: Object.fromEntries(bindings.map((binding) => {
      const supplied = [...(suppliedByEvent[binding.event] ?? [])];
      if (binding.event === "form_submit")
        for (const field of formFields(binding.control))
          if (!supplied.some((entry) => entry.name === field.name)) supplied.push({ name: field.name, label: `The form's ${field.label}` });
      return [binding.id, supplied];
    })),
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
  if (name.length < 1 || name.length > 100) return { kind: "invalid", reason: "How it starts, Name: name the flow in at most 100 characters." };
  flow.labels = { ...flow.labels, name };
  const inputs: SourceFlow["inputs"] = {};
  for (const input of draft.inputs) {
    const where = `How it starts, input ${studioWords(input.name)}`;
    if (!builderKeySchema.safeParse(input.name).success)
      return { kind: "invalid", reason: `${where}: name it with lowercase words joined by underscores, such as record_id.` };
    if (Object.hasOwn(inputs, input.name)) return { kind: "invalid", reason: `${where}: two inputs have this name. Name each input once.` };
    const type = workflowValueTypeSchema.safeParse(input.type);
    if (!type.success) return { kind: "invalid", reason: `${where}: choose what kind of value it is.` };
    const listsRecords = type.data === "record_reference" || type.data === "record_reference_list";
    if (listsRecords && input.recordType === null) return { kind: "invalid", reason: `${where}: choose the record type it names.` };
    const before = Object.hasOwn(flow.inputs ?? {}, input.id) ? flow.inputs[input.id] : undefined;
    inputs[input.name] = { ...(before?.description === undefined ? {} : { description: before.description }),
      type: type.data, required: input.required, ...(listsRecords ? { recordTypeIds: [input.recordType!] } : {}) };
  }
  // A renamed input keeps what reads it: every step and output reference follows the new name.
  const renames = new Map(draft.inputs.filter((input) => input.id !== input.name && Object.hasOwn(flow.inputs ?? {}, input.id))
    .map((input) => [input.id, input.name]));
  flow.inputs = inputs;
  if (renames.size > 0) {
    const renamed = renameInputReferences({ tasks: flow.tasks, errors: flow.errors, finally: flow.finally, outputs: flow.outputs }, renames) as
      Pick<SourceFlow, "tasks" | "errors" | "finally" | "outputs">;
    Object.assign(flow, renamed);
  }
  for (const bindingDraft of draft.bindings) {
    const binding = candidate.body.flow_bindings.find((entry) => entry.id === bindingDraft.id);
    if (binding === undefined) return { kind: "stale", reason: "A control that starts this flow changed. Open the flow again." };
    const next: Binding["inputs"] = {};
    for (const input of draft.inputs) {
      const value = bindingDraft.inputs[input.id] ?? { kind: "none" as const };
      const inputName = input.name;
      if (value.kind === "none") continue;
      if (value.kind === "caller") {
        if (!builderKeySchema.safeParse(value.name).success)
          return { kind: "invalid", reason: `How it starts, input ${studioWords(inputName)}: choose what the control supplies.` };
        next[inputName] = { kind: "caller", name: value.name };
      } else {
        if (!flowLiteralSchema.safeParse(value.literal).success)
          return { kind: "invalid", reason: `How it starts, input ${studioWords(inputName)}: this fixed value does not fit its kind.` };
        next[inputName] = { kind: "literal", literal: value.literal };
      }
    }
    for (const [inputName, declaration] of Object.entries(inputs))
      if (declaration.required && !Object.hasOwn(next, inputName))
        return { kind: "invalid", reason: `How it starts, input ${studioWords(inputName)}: it is required, so say where it comes from when the control is used.` };
    binding.inputs = next;
  }
  if (draft.triggers.length !== (flow.triggers ?? []).length)
    return { kind: "stale", reason: "The triggers of this flow changed. Open the flow again." };
  flow.triggers = (flow.triggers ?? []).map((trigger, index): FlowTrigger => {
    const edited = draft.triggers[index]!;
    if (edited.kind === "before_save" && trigger.type === "BeforeSave")
      return { ...trigger, recordTypeId: edited.recordType, priority: edited.priority,
        operations: [...(edited.create ? [{ kind: "create" as const }] : []), ...(edited.update ? [{ kind: "update" as const }] : [])] };
    if (edited.kind === "event" && trigger.type === "Event")
      return { ...trigger, recordTypeId: edited.recordType, event: { kind: "standard", eventKind: edited.eventKind as never } };
    return trigger;
  });
  for (const [index, trigger] of (flow.triggers ?? []).entries())
    if (trigger.type === "BeforeSave" && trigger.operations.length === 0)
      return { kind: "invalid", reason: `How it starts, trigger ${index + 1}: choose when it runs, when a record is created, changed, or both.` };
  return validatedStudioFlowEdit(candidate, current.source, expectedSelection, flow.tasks[0]?.id ?? "", current);
};
