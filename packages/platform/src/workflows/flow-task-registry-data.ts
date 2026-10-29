import type { z } from "zod";
import type { FlowTaskEffectClass, safeFlowResultKindSchema } from "./flow-effects";
import { flowControlTaskTypeKeys } from "./flow-task-tree";
import { flowMaximumServerSeconds } from "./flow-limits";
import type {
  FlowStepRuns,
  FlowTaskPropertyType,
  FlowTaskRunLocation,
  FlowTaskTypeDefinition,
  flowTaskPropertyDeclarationSchema,
  flowTaskOutputDeclarationSchema,
} from "./flow-task-registry";

export const flowRegisteredTaskTypeKeys = [
  "record.save",
  "record.create",
  "record.set_fields",
  "record.link",
  "record.delete",
  "record.restore",
  "record.changes",
  "record.query",
  "record.read_fields",
  "record.pin_identity",
  "operation.call",
  "backend.run",
  "event.announce",
  "data.calculate",
  "data.record_link",
  "data.set_values",
  "data.set_variable",
  "data.format",
  "rule.require",
  "rule.warn",
  "rule.refuse",
  "interface.show_message",
  "interface.clear_message",
  "interface.set_value",
  "interface.validate_form",
  "interface.show_form",
  "interface.confirm",
  "interface.navigate",
  "interface.refresh",
  "interface.set_panel",
  "interface.set_filter",
] as const;
export type FlowRegisteredTaskTypeKey = (typeof flowRegisteredTaskTypeKeys)[number];
export type FlowControlTaskTypeKey = (typeof flowControlTaskTypeKeys)[number];
export type FlowTaskTypeKey = FlowControlTaskTypeKey | FlowRegisteredTaskTypeKey;

const page = { page: true, server: false, backend: false } as const;
const server = { page: false, server: true, backend: false } as const;
const nowhere = { page: false, server: false, backend: false } as const;

/** Where each step runs today; each later batch flips a flag when it lands the implementation. */
export const flowTaskRuns = Object.freeze({
  if: server,
  switch: server,
  for_each: server,
  sequential: server,
  run_flow: server,
  stop: server,
  "record.save": server,
  "record.create": server,
  "record.set_fields": server,
  "record.link": nowhere,
  "record.delete": server,
  "record.restore": nowhere,
  "record.changes": server,
  "record.query": nowhere,
  "record.read_fields": server,
  "record.pin_identity": server,
  "operation.call": server,
  "backend.run": nowhere,
  "event.announce": server,
  "data.calculate": server,
  "data.record_link": server,
  "data.set_values": nowhere,
  "data.set_variable": server,
  "data.format": nowhere,
  "rule.require": server,
  "rule.warn": server,
  "rule.refuse": server,
  "interface.show_message": page,
  "interface.clear_message": nowhere,
  "interface.set_value": nowhere,
  "interface.validate_form": nowhere,
  "interface.show_form": page,
  "interface.confirm": page,
  "interface.navigate": page,
  "interface.refresh": page,
  "interface.set_panel": page,
  "interface.set_filter": page,
} as const satisfies Record<FlowTaskTypeKey, FlowStepRuns>);

type StepsRunning<Where extends keyof FlowStepRuns> = {
  [Type in FlowTaskTypeKey]: (typeof flowTaskRuns)[Type][Where] extends true ? Type : never;
}[FlowTaskTypeKey];
/** The steps with a page implementation; the page's implementation map covers exactly these. */
export type PageStepType = StepsRunning<"page">;
/** The steps with a server implementation; the server's implementation map covers exactly these. */
export type ServerStepType = StepsRunning<"server">;

type SafeResult = z.infer<typeof safeFlowResultKindSchema>;
const outcomesByEffect = {
  pure: ["completed"],
  read: ["completed", "refused", "validation", "failed"],
  change: ["committed", "refused", "conflict", "validation", "uncertain", "failed"],
  background_start: [
    "background_pending",
    "refused",
    "conflict",
    "validation",
    "uncertain",
    "failed",
  ],
  interface: ["completed"],
} as const satisfies Record<FlowTaskEffectClass, readonly SafeResult[]>;

type Property = z.infer<typeof flowTaskPropertyDeclarationSchema>;
const required = (type: FlowTaskPropertyType): Property => ({ type, required: true });
const optional = (type: FlowTaskPropertyType): Property => ({ type, required: false });
type Output = z.infer<typeof flowTaskOutputDeclarationSchema>;
const output = (key: string, type: Output["type"]): Output => ({ key, type });

type DefinitionInput = {
  title: string;
  summary: string;
  runLocations: readonly FlowTaskRunLocation[];
  effect: FlowTaskEffectClass;
  effectDeclaredBy?: "operation_descriptor";
  transactionScope?: "saved_record";
  actionFlowTransaction?: true;
  protectedOperationKey?: string;
  properties?: Record<string, Property>;
  outputs?: readonly Output[];
  redaction?: "identifiers_only" | "safe_fields" | "no_payload";
};

const allLocations = ["browser", "server", "transaction"] as const;
const protectedLocations = ["server"] as const;
const applyRecordChanges = "record.apply_changes";

const controlDefinitions: Record<FlowControlTaskTypeKey, DefinitionInput> = {
  if: {
    title: "If",
    summary: "Runs one list of tasks when a condition holds, otherwise another.",
    runLocations: allLocations,
    effect: "pure",
  },
  switch: {
    title: "Switch",
    summary: "Runs the list of tasks whose case matches a value.",
    runLocations: allLocations,
    effect: "pure",
  },
  for_each: {
    title: "For each",
    summary: "Runs a list of tasks for every item, within the flow's item limit.",
    runLocations: allLocations,
    effect: "pure",
  },
  sequential: {
    title: "Sequential",
    summary: "Groups tasks that run one after another.",
    runLocations: allLocations,
    effect: "pure",
  },
  run_flow: {
    title: "Run flow",
    summary: "Runs another flow of the same execution kind and waits for its result.",
    runLocations: allLocations,
    effect: "pure",
  },
  stop: {
    title: "Stop",
    summary: "Ends the flow with a named outcome.",
    runLocations: allLocations,
    effect: "pure",
  },
};

const recordProperties = {
  record_type: required("record_type_id"),
  record: required("record_reference"),
};

const registeredDefinitions: Record<FlowRegisteredTaskTypeKey, DefinitionInput> = {
  // Record tasks: every one of them calls apply record changes, in one transaction per call.
  "record.save": {
    title: "Save record",
    summary: "Saves a record from a form or values, creating it or changing it by revision.",
    runLocations: protectedLocations,
    effect: "change",
    protectedOperationKey: applyRecordChanges,
    properties: {
      record_type: required("record_type_id"),
      record: optional("record_reference"),
      values: required("field_values"),
      selected_owner_group_id: optional("text"),
      // The inputs of the named action that owns the chosen option; absent means none.
      action_inputs: optional("input_map"),
    },
    outputs: [output("record", "record_reference")],
  },
  "record.create": {
    title: "Create record",
    summary: "Creates a record.",
    runLocations: protectedLocations,
    effect: "change",
    actionFlowTransaction: true,
    protectedOperationKey: applyRecordChanges,
    properties: { record_type: required("record_type_id"), values: required("field_values") },
    outputs: [output("record", "record_reference")],
  },
  "record.set_fields": {
    title: "Set fields",
    summary: "Sets fields of a record; in a save transaction, only of the record being saved.",
    runLocations: ["server", "transaction"],
    effect: "change",
    transactionScope: "saved_record",
    protectedOperationKey: applyRecordChanges,
    properties: {
      record_type: optional("record_type_id"),
      record: optional("record_reference"),
      values: required("field_values"),
    },
    outputs: [output("record", "record_reference")],
  },
  "record.link": {
    title: "Link records",
    summary: "Adds a relationship between two records.",
    runLocations: protectedLocations,
    effect: "change",
    protectedOperationKey: applyRecordChanges,
    properties: {
      relationship: required("relationship_id"),
      subject: required("record_reference"),
      target: required("record_reference"),
    },
    outputs: [output("relationship", "relationship_reference")],
  },
  "record.delete": {
    title: "Delete record",
    summary: "Soft-deletes a record.",
    runLocations: protectedLocations,
    effect: "change",
    actionFlowTransaction: true,
    protectedOperationKey: applyRecordChanges,
    properties: recordProperties,
  },
  "record.restore": {
    title: "Restore record",
    summary: "Restores a soft-deleted record.",
    runLocations: protectedLocations,
    effect: "change",
    protectedOperationKey: applyRecordChanges,
    properties: recordProperties,
    outputs: [output("record", "record_reference")],
  },
  "record.changes": {
    title: "Apply record changes",
    summary:
      "Applies several record changes that must succeed or fail together, in one transaction.",
    runLocations: protectedLocations,
    effect: "change",
    actionFlowTransaction: true,
    protectedOperationKey: applyRecordChanges,
    properties: { changes: required("record_change_list") },
    outputs: [output("records", "record_reference_list")],
  },
  "record.query": {
    title: "Query records",
    summary: "Reads records through a declared query under the run's authority.",
    runLocations: ["server", "transaction"],
    effect: "read",
    properties: { query: required("query_id"), parameters: optional("input_map") },
    outputs: [output("records", "record_reference_list")],
    redaction: "safe_fields",
  },
  "record.read_fields": {
    title: "Read selected record fields",
    summary: "Reads a bounded set of fields from one selected record under the run's authority.",
    runLocations: ["server"],
    effect: "read",
    properties: {
      record_type: required("record_type_id"),
      record: required("record_reference"),
      fields: required("json"),
    },
    outputs: [output("values", "json")],
    redaction: "safe_fields",
  },
  "record.pin_identity": {
    title: "Acquire record pin identity",
    summary:
      "Resolves one permitted installed record and returns only its exact identity for a pin.",
    runLocations: ["server"],
    effect: "read",
    properties: {
      application_key: required("text"),
      record_type_key: required("text"),
      record_id: required("text"),
    },
    outputs: [
      output("organization_id", "text"),
      output("application_root_id", "text"),
      output("module_root_id", "text"),
      output("module_release_revision", "whole_number"),
      output("record_type_id", "text"),
      output("storage_contract_id", "text"),
      output("record_id", "text"),
    ],
    redaction: "no_payload",
  },
  "operation.call": {
    title: "Call protected operation",
    summary: "Calls one published protected operation; the operation declares its own effect.",
    runLocations: protectedLocations,
    effect: "change",
    effectDeclaredBy: "operation_descriptor",
    properties: {
      operation: required("protected_operation_key"),
      inputs: optional("input_map"),
      refusal_feedback: optional("input_map"),
    },
    outputs: [output("result", "json")],
  },
  "backend.run": {
    title: "Run on back end",
    summary:
      "Runs a flow on the back end after this step's changes commit: await returns its outputs, start returns a run reference at once.",
    runLocations: ["server"],
    effect: "background_start",
    properties: {
      flow: required("flow_id"),
      mode: required("builder_key"),
      inputs: optional("input_map"),
    },
    outputs: [output("run", "workflow_run_reference"), output("outputs", "json")],
  },
  "event.announce": {
    title: "Announce event",
    summary: "Announces a named event about a record through the one event writer.",
    runLocations: ["server", "transaction"],
    effect: "change",
    transactionScope: "saved_record",
    properties: { event: required("namespaced_key"), record: optional("record_reference") },
  },

  // Pure tasks: computed from their inputs, so they may run anywhere.
  "data.calculate": {
    title: "Calculate",
    summary: "Evaluates a typed formula and returns its result, of the declared result type.",
    runLocations: allLocations,
    effect: "pure",
    // `result_type` names a value type; the formula's type must match it and `value` takes it.
    properties: {
      formula: required("formula"),
      result_type: required("builder_key"),
      places: optional("whole_number"),
      rounding: optional("builder_key"),
    },
    outputs: [output("value", "json")],
  },
  "data.record_link": {
    title: "Build record link value",
    summary: "Builds a canonical record link value from one declared record input.",
    runLocations: ["server"],
    effect: "pure",
    properties: {
      record_type: required("record_type_id"),
      record: required("record_reference"),
    },
    outputs: [output("value", "json")],
  },
  "data.set_values": {
    title: "Set values",
    summary: "Builds a copy of a record's values with fields set, without saving it.",
    runLocations: allLocations,
    effect: "pure",
    properties: { record: required("record_reference"), values: required("field_values") },
    outputs: [output("record", "record_reference")],
  },
  "data.set_variable": {
    title: "Set variable",
    summary: "Sets a flow variable.",
    runLocations: allLocations,
    effect: "pure",
    properties: { variable: required("builder_key"), value: required("any_value") },
  },
  "data.format": {
    title: "Format value",
    summary: "Formats a value with a registered formatter.",
    runLocations: allLocations,
    effect: "pure",
    properties: {
      formatter: required("builder_key"),
      input: required("any_value"),
      places: optional("whole_number"),
      currency: optional("text"),
      unit: optional("builder_key"),
    },
    outputs: [output("value", "text")],
  },
  // Save rules give feedback in the browser and are authoritative in the save transaction.
  "rule.require": {
    title: "Require field",
    summary: "Requires a field to have a value before the record can be saved.",
    runLocations: ["browser", "transaction"],
    effect: "pure",
    properties: { field: required("field_id"), message: required("message_text") },
  },
  "rule.warn": {
    title: "Warn",
    summary: "Shows a warning that does not stop the save.",
    runLocations: ["browser", "transaction"],
    effect: "pure",
    properties: { message: required("message_text") },
  },
  "rule.refuse": {
    title: "Refuse save",
    summary: "Refuses the save with a reason.",
    runLocations: ["browser", "transaction"],
    effect: "pure",
    properties: {
      reason: required("builder_key"),
      message: required("message_text"),
      field: optional("field_id"),
    },
  },

  // Interface tasks: browser-only. A server-driven flow returns a typed intent and a continuation.
  "interface.show_message": {
    title: "Show message",
    summary:
      "Shows a safe message: in a dialog, a toast, the page banner, under a component or in a message slot.",
    runLocations: ["browser"],
    effect: "interface",
    properties: {
      message: required("message_text"),
      /** dialog, toast, banner, inline (under `component`) or slot (the message slot `component`). */
      target: required("builder_key"),
      /** The placement an inline message sits under, or the message slot it fills. */
      component: optional("placement_id"),
      /** info, success, warning or error. */
      severity: required("builder_key"),
      /** A dialog's heading: what the person was doing ("Install or upgrade"). */
      title: optional("message_text"),
      /** One action the message offers, bound to a flow ("Undo"). */
      action_label: optional("message_text"),
      action_flow: optional("flow_id"),
    },
  },
  "interface.clear_message": {
    title: "Clear message",
    summary: "Removes the message a target shows.",
    runLocations: ["browser"],
    effect: "interface",
    properties: { target: required("builder_key"), component: optional("placement_id") },
  },
  "interface.set_value": {
    title: "Set page value",
    summary: "Sets a declared page value; the page shows and reads it, the server never trusts it.",
    runLocations: ["browser"],
    effect: "interface",
    properties: { value: required("builder_key"), to: required("any_value") },
  },
  "interface.validate_form": {
    title: "Validate form",
    summary: "Checks a form's fields and stops the flow with the problems shown when one is invalid.",
    runLocations: ["browser"],
    effect: "interface",
    properties: { form: required("form_id") },
    outputs: [output("valid", "yes_no")],
  },
  "interface.show_form": {
    title: "Show form",
    summary: "Shows a form and continues with the person's answers.",
    runLocations: ["browser"],
    effect: "interface",
    properties: { form: required("form_id"), inputs: optional("input_map") },
    outputs: [output("submitted", "yes_no"), output("values", "json")],
  },
  "interface.confirm": {
    title: "Confirm",
    summary:
      "Asks the person to confirm before the flow continues, optionally listing what it covers and offering one opt-in.",
    runLocations: ["browser"],
    effect: "interface",
    // `details` is a list of short lines shown under the message; `choice` labels one opt-in the
    // person may tick with a yes, answered as `choice` (always no when no choice is offered).
    properties: {
      title: optional("message_text"),
      message: required("message_text"),
      details: optional("json"),
      choice: optional("message_text"),
      confirm_label: optional("message_text"),
      destructive: optional("yes_no"),
    },
    outputs: [output("confirmed", "yes_no"), output("choice", "yes_no")],
  },
  "interface.navigate": {
    title: "Navigate",
    summary: "Opens a page.",
    runLocations: ["browser"],
    effect: "interface",
    properties: { page: required("page_id"), parameters: optional("input_map") },
  },
  "interface.refresh": {
    title: "Refresh",
    summary: "Refreshes the data of the page or one component on it.",
    runLocations: ["browser"],
    effect: "interface",
    properties: { component: optional("builder_key") },
  },
  "interface.set_panel": {
    title: "Open or close panel",
    summary: "Opens or closes a panel on the page.",
    runLocations: ["browser"],
    effect: "interface",
    properties: { panel: required("placement_id"), state: required("builder_key") },
  },
  "interface.set_filter": {
    title: "Set filter",
    summary: "Sets a filter of a list component.",
    runLocations: ["browser"],
    effect: "interface",
    properties: {
      component: required("builder_key"),
      field: required("field_id"),
      value: optional("any_value"),
    },
  },
};

const buildDefinition = (type: string, input: DefinitionInput): FlowTaskTypeDefinition => {
  const category = (flowControlTaskTypeKeys as readonly string[]).includes(type)
    ? "control"
    : "registered";
  const protectedEffect = input.effect === "change" || input.effect === "background_start";
  return {
    type,
    category,
    version: "1.0.0",
    title: input.title,
    summary: input.summary,
    runLocations: [...input.runLocations],
    runs: { ...flowTaskRuns[type as FlowTaskTypeKey] },
    effect: input.effect,
    effectDeclaredBy: input.effectDeclaredBy ?? "task",
    ...(input.transactionScope ? { transactionScope: input.transactionScope } : {}),
    ...(input.actionFlowTransaction ? { actionFlowTransaction: true as const } : {}),
    ...(input.protectedOperationKey ? { protectedOperationKey: input.protectedOperationKey } : {}),
    properties: input.properties ?? {},
    outputs: [...(input.outputs ?? [])],
    outcomes: [...outcomesByEffect[input.effect]],
    defaultPolicy: {
      timeoutSeconds: flowMaximumServerSeconds,
      duplicateProtection: protectedEffect ? "required" : "not_applicable",
      redaction: input.redaction ?? (protectedEffect ? "identifiers_only" : "no_payload"),
    },
  };
};

/** Every task type, keyed by its type key; each is registered exactly once. */
export const flowTaskRegistry: Readonly<Record<FlowTaskTypeKey, FlowTaskTypeDefinition>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries({ ...controlDefinitions, ...registeredDefinitions }).map(([type, input]) => [
        type,
        Object.freeze(buildDefinition(type, input)),
      ]),
    ) as Record<FlowTaskTypeKey, FlowTaskTypeDefinition>,
  );
