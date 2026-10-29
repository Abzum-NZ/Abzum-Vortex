import { z } from "zod";
import { flowTaskEffectClassSchema, safeFlowResultKindSchema } from "./flow-effects";
import type { FlowTaskEffectClass } from "./flow-effects";
import { workflowValueTypeSchema } from "../catalogue/catalogues";
import { retryPolicySchema } from "../catalogue/common";
import { flowControlTaskTypeKeys, flowDurableOnlyTaskTypeKeys, flowTaskChildLists, isFlowControlTask } from "./flow-contracts";
import type { FlowDefinition, FlowExecutionKind, FlowSource, FlowTask } from "./flow-contracts";
import {
  builderKeySchema,
  namespacedKeySchema,
  stableDefinitionReleaseVersionSchema,
} from "../catalogue/identifiers";
import { flowMaximumServerSeconds } from "./flow-limits";

/*
 * The one registry of task types (architecture decision 1, "The task registry"). Every building
 * block of every flow is registered once, with where it may run, what it does to the world, its
 * typed properties, outputs and outcomes, its default policy and how it compiles for Kestra.
 *
 * This contract owns the catalogue and the publication placement check. Execution belongs to the
 * shared flow interpreter, the server orchestrator, the browser runner and the Kestra compiler,
 * which read these declarations and never redeclare them. Control tasks are registered here too,
 * so publication can check the run location of every task in a flow; their shapes stay in
 * `flow-contracts.ts`.
 */
/**
 * Where a task may run.
 * - `browser`: in the page; interface and pure tasks only.
 * - `server`: a protected operation in its own short transaction.
 * - `transaction`: inside the owning record save, for every writer.
 * - `durable`: on Kestra.
 */
export const flowTaskRunLocationSchema = z.enum(["browser", "server", "transaction", "durable"]);
export type FlowTaskRunLocation = z.infer<typeof flowTaskRunLocationSchema>;

/**
 * Where a step has an implementation: the page (the page performs it), the server (the server
 * interpreter or a server runner executes it) and the back end (a back-end adapter runs it). The
 * contract's `runLocations` say where a step may be placed; these flags say where it runs today.
 * Publication refuses a step placed where it does not run, naming it, and Studio's palette offers
 * a step only where it runs. The page and server implementation maps are typed from these flags
 * (`PageStepType`, `ServerStepType`), so a flag without an implementation fails the type check.
 */
export const flowStepRunsSchema = z
  .object({ page: z.boolean(), server: z.boolean(), backend: z.boolean() })
  .strict();
export type FlowStepRuns = z.infer<typeof flowStepRunsSchema>;


/**
 * How a task compiles to a Kestra flow when it is placed in a durable flow. Customer text is never
 * emitted as template text in any mode (the compiler's rules in decision 1).
 * - `native_control`: the Kestra control task with the same meaning. Its condition, switch value
 *   or item list is computed by the Vortex evaluator through the protected callback, and Kestra
 *   branches only on that result.
 * - `evaluator_callback`: a pure task; the Vortex evaluator computes it through the protected
 *   callback, and Kestra branches only on the result.
 * - `protected_callback`: a read, change or background-start task; Kestra calls the signed
 *   protected callback once, with the duplicate-protection key.
 * - `native_wait`: waits for a moment computed by the Vortex evaluator.
 * - `human_task`: pauses the run, creates the person's task through the callback and resumes on
 *   the person's answer.
 * - `not_compiled`: never runs on Kestra. Publication refuses it in a durable flow.
 */
export const flowTaskKestraCompileModeSchema = z.enum([
  "native_control",
  "evaluator_callback",
  "protected_callback",
  "native_wait",
  "human_task",
  "not_compiled",
]);
export type FlowTaskKestraCompileMode = z.infer<typeof flowTaskKestraCompileModeSchema>;

/** The declared type of one task property. */
export const flowTaskPropertyTypeSchema = z.enum([
  ...workflowValueTypeSchema.options,
  "any_value",
  "formula",
  "record_type_id",
  "field_id",
  "field_values",
  "record_change_list",
  "query_id",
  "page_id",
  "form_id",
  "placement_id",
  "relationship_id",
  "connection_binding_id",
  "protected_operation_key",
  "flow_id",
  "builder_key",
  "namespaced_key",
  "message_text",
  "input_map",
]);
export type FlowTaskPropertyType = z.infer<typeof flowTaskPropertyTypeSchema>;

export const flowTaskPropertyDeclarationSchema = z
  .object({ type: flowTaskPropertyTypeSchema, required: z.boolean() })
  .strict();

export const flowTaskOutputDeclarationSchema = z
  .object({ key: builderKeySchema, type: workflowValueTypeSchema })
  .strict();

/** The default policy a task starts with; a builder may tighten it within the flow's limits. */
export const flowTaskDefaultPolicySchema = z
  .object({
    timeoutSeconds: z.number().int().min(1).max(7_776_000),
    retry: retryPolicySchema.optional(),
    duplicateProtection: z.enum(["not_applicable", "required"]),
    redaction: z.enum(["identifiers_only", "safe_fields", "no_payload"]),
  })
  .strict();

const flowTaskTypeKeySchema = z.union([builderKeySchema, namespacedKeySchema]);

/** The properties that name the target of a saved-record task outside a transaction flow. */
export const flowSavedRecordTargetProperties = ["record_type", "record"] as const;

export const flowTaskTypeDefinitionSchema = z
  .object({
    /** Control tasks use a plain key; every other task uses a dotted key that no control task can take. */
    type: flowTaskTypeKeySchema,
    category: z.enum(["control", "registered"]),
    /** A published flow pins this exact version on every task of the type. */
    version: stableDefinitionReleaseVersionSchema,
    title: z.string().min(1).max(60),
    summary: z.string().min(1).max(300),
    runLocations: z.array(flowTaskRunLocationSchema).min(1).max(4),
    /** Where an implementation exists today (`flowTaskRuns`); the contract allows `runLocations`. */
    runs: flowStepRunsSchema,
    effect: flowTaskEffectClassSchema,
    /**
     * When the effect is declared by the protected operation the task calls, `effect` is the widest
     * class that operation can have, and the operation's own descriptor decides each placement.
     */
    effectDeclaredBy: z.enum(["task", "operation_descriptor"]),
    /**
     * A `change` task may run in a transaction only on the record being saved. Such a task declares
     * its target properties (`flowSavedRecordTargetProperties`) as optional: a transaction flow never
     * names them, because the task applies to the saved record, and every other flow must.
     */
    transactionScope: z.literal("saved_record").optional(),
    /**
     * A `change` task that may also run in an action flow: a `transaction` flow with no trigger,
     * started through its binding for the record a named action runs on. Its changes to
     * other records are one apply record changes call. A BeforeSave flow shares its run with every
     * other rule and may change only the record being saved, so this task is never placed there.
     */
    actionFlowTransaction: z.literal(true).optional(),
    /** The one protected operation the task calls, when the registry fixes it. */
    protectedOperationKey: namespacedKeySchema.optional(),
    properties: z.record(builderKeySchema, flowTaskPropertyDeclarationSchema),
    outputs: z.array(flowTaskOutputDeclarationSchema).max(10),
    /** The results the task can report; the first is its confirmed result. */
    outcomes: z.array(safeFlowResultKindSchema).min(1),
    defaultPolicy: flowTaskDefaultPolicySchema,
    kestra: z.object({ mode: flowTaskKestraCompileModeSchema }).strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (path: string[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    const locations = new Set(value.runLocations);
    const controlKeys: readonly string[] = flowControlTaskTypeKeys;
    if (locations.size !== value.runLocations.length)
      issue(["runLocations"], "Run locations must be unique");
    if ((value.category === "control") !== controlKeys.includes(value.type))
      issue(["category"], "Exactly the control task keys are control tasks");
    if (value.category === "registered" && !value.type.includes("."))
      issue(["type"], "A registered task type uses a dotted key such as record.save");
    if (value.category === "control" && Object.keys(value.properties).length > 0)
      issue(["properties"], "A control task's shape is declared by the flow contract");
    if (
      (flowDurableOnlyTaskTypeKeys as readonly string[]).includes(value.type) &&
      (locations.size !== 1 || !locations.has("durable"))
    )
      issue(["runLocations"], "Wait and parallel tasks run only in durable flows");
    if (value.effect === "interface") {
      if (locations.size !== 1 || !locations.has("browser"))
        issue(["runLocations"], "An interface task is browser-only");
    } else if (locations.has("browser") && value.effect !== "pure")
      issue(["runLocations"], "Only pure and interface tasks may run in the browser");
    if (locations.has("transaction")) {
      if (value.effect === "background_start" || value.effect === "interface")
        issue(
          ["runLocations"],
          "A transaction task is pure, a read, or a change to the saved record",
        );
      if (value.effect === "change" && value.transactionScope !== "saved_record")
        issue(
          ["transactionScope"],
          "A change may run in a transaction only on the record being saved",
        );
    }
    if (value.transactionScope !== undefined && !locations.has("transaction"))
      issue(["transactionScope"], "A transaction scope applies only to a transaction task");
    if (value.actionFlowTransaction === true) {
      if (value.effect !== "change")
        issue(["actionFlowTransaction"], "Only a change task may be placed in an action flow");
      if (locations.has("transaction"))
        issue(
          ["actionFlowTransaction"],
          "A task that already runs in a save transaction has no separate action flow placement",
        );
    }
    if (value.transactionScope === "saved_record") {
      if (value.properties.record === undefined)
        issue(
          ["properties", "record"],
          "A saved-record task declares the record it changes outside transactions",
        );
      for (const name of flowSavedRecordTargetProperties)
        if (value.properties[name]?.required === true)
          issue(
            ["properties", name],
            "A saved-record task's target is optional, named only outside transactions",
          );
    }
    const durableCompiled = value.kestra.mode !== "not_compiled";
    if (durableCompiled !== locations.has("durable"))
      issue(
        ["kestra", "mode"],
        "A task compiles for Kestra exactly when it can run in a durable flow",
      );
    const expectedModes: Partial<
      Record<FlowTaskEffectClass, readonly FlowTaskKestraCompileMode[]>
    > = {
      pure: ["native_control", "evaluator_callback", "native_wait", "not_compiled"],
      read: ["protected_callback", "not_compiled"],
      change: ["protected_callback"],
      background_start: ["protected_callback"],
      interface: ["not_compiled"],
    };
    if (
      value.category === "registered" &&
      !expectedModes[value.effect]?.includes(value.kestra.mode)
    )
      issue(["kestra", "mode"], "The Kestra compile mode does not fit the task's effect");
    if (value.category === "registered" && value.kestra.mode === "native_control")
      issue(["kestra", "mode"], "Only control tasks compile to native Kestra control tasks");
    const protectedEffect = value.effect === "change" || value.effect === "background_start";
    if (protectedEffect !== (value.defaultPolicy.duplicateProtection === "required"))
      issue(
        ["defaultPolicy", "duplicateProtection"],
        "Duplicate protection is required exactly for changes and background starts",
      );
    if (value.defaultPolicy.retry !== undefined && !locations.has("durable"))
      issue(
        ["defaultPolicy", "retry"],
        "Retries are allowed only for tasks that run in durable flows",
      );
    if (
      (locations.size > 1 || !locations.has("durable")) &&
      value.defaultPolicy.timeoutSeconds > flowMaximumServerSeconds
    )
      issue(
        ["defaultPolicy", "timeoutSeconds"],
        `A task that can run outside durable flows times out within ${flowMaximumServerSeconds} seconds`,
      );
    if (new Set(value.outputs.map((output) => output.key)).size !== value.outputs.length)
      issue(["outputs"], "Output keys must be unique");
    if (new Set(value.outcomes).size !== value.outcomes.length)
      issue(["outcomes"], "Outcomes must be unique");
  });
export type FlowTaskTypeDefinition = z.infer<typeof flowTaskTypeDefinitionSchema>;

// ─── The catalogue ───────────────────────────────────────────────────────────────────────────

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
  parallel: nowhere,
  wait_until: nowhere,
  wait_for_person: nowhere,
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
  kestra: FlowTaskKestraCompileMode;
  timeoutSeconds?: number;
  retry?: z.infer<typeof retryPolicySchema>;
  redaction?: "identifiers_only" | "safe_fields" | "no_payload";
};

const allLocations = ["browser", "server", "transaction", "durable"] as const;
const protectedLocations = ["server", "durable"] as const;
const durableRetry = {
  maximumAttempts: 3,
  initialDelaySeconds: 5,
  maximumDelaySeconds: 60,
  backoff: "exponential",
} as const;
const applyRecordChanges = "record.apply_changes";

const controlDefinitions: Record<FlowControlTaskTypeKey, DefinitionInput> = {
  if: {
    title: "If",
    summary: "Runs one list of tasks when a condition holds, otherwise another.",
    runLocations: allLocations,
    effect: "pure",
    kestra: "native_control",
  },
  switch: {
    title: "Switch",
    summary: "Runs the list of tasks whose case matches a value.",
    runLocations: allLocations,
    effect: "pure",
    kestra: "native_control",
  },
  for_each: {
    title: "For each",
    summary: "Runs a list of tasks for every item, within the flow's item limit.",
    runLocations: allLocations,
    effect: "pure",
    kestra: "native_control",
  },
  sequential: {
    title: "Sequential",
    summary: "Groups tasks that run one after another.",
    runLocations: allLocations,
    effect: "pure",
    kestra: "native_control",
  },
  run_flow: {
    title: "Run flow",
    summary: "Runs another flow of the same execution kind and waits for its result.",
    runLocations: allLocations,
    effect: "pure",
    kestra: "native_control",
  },
  stop: {
    title: "Stop",
    summary: "Ends the flow with a named outcome.",
    runLocations: allLocations,
    effect: "pure",
    kestra: "native_control",
  },
  parallel: {
    title: "Parallel",
    summary: "Runs several branches at the same time.",
    runLocations: ["durable"],
    effect: "pure",
    kestra: "native_control",
  },
  wait_until: {
    title: "Wait until",
    summary: "Pauses a durable run until a date and time.",
    runLocations: ["durable"],
    effect: "pure",
    kestra: "native_wait",
    timeoutSeconds: 7_776_000,
  },
  wait_for_person: {
    title: "Wait for a person",
    summary: "Pauses a durable run until a person answers a form.",
    runLocations: ["durable"],
    effect: "pure",
    kestra: "human_task",
    timeoutSeconds: 7_776_000,
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
    kestra: "protected_callback",
    retry: durableRetry,
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
    kestra: "protected_callback",
    retry: durableRetry,
  },
  "record.set_fields": {
    title: "Set fields",
    summary: "Sets fields of a record; in a save transaction, only of the record being saved.",
    runLocations: ["server", "transaction", "durable"],
    effect: "change",
    transactionScope: "saved_record",
    protectedOperationKey: applyRecordChanges,
    properties: {
      record_type: optional("record_type_id"),
      record: optional("record_reference"),
      values: required("field_values"),
    },
    outputs: [output("record", "record_reference")],
    kestra: "protected_callback",
    retry: durableRetry,
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
    kestra: "protected_callback",
    retry: durableRetry,
  },
  "record.delete": {
    title: "Delete record",
    summary: "Soft-deletes a record.",
    runLocations: protectedLocations,
    effect: "change",
    actionFlowTransaction: true,
    protectedOperationKey: applyRecordChanges,
    properties: recordProperties,
    kestra: "protected_callback",
    retry: durableRetry,
  },
  "record.restore": {
    title: "Restore record",
    summary: "Restores a soft-deleted record.",
    runLocations: protectedLocations,
    effect: "change",
    protectedOperationKey: applyRecordChanges,
    properties: recordProperties,
    outputs: [output("record", "record_reference")],
    kestra: "protected_callback",
    retry: durableRetry,
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
    kestra: "protected_callback",
    retry: durableRetry,
  },
  "record.query": {
    title: "Query records",
    summary: "Reads records through a declared query under the run's authority.",
    runLocations: ["server", "transaction", "durable"],
    effect: "read",
    properties: { query: required("query_id"), parameters: optional("input_map") },
    outputs: [output("records", "record_reference_list")],
    kestra: "protected_callback",
    retry: durableRetry,
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
    kestra: "not_compiled",
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
    kestra: "not_compiled",
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
    kestra: "protected_callback",
    retry: durableRetry,
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
    kestra: "not_compiled",
  },
  "event.announce": {
    title: "Announce event",
    summary: "Announces a named event about a record through the one event writer.",
    runLocations: ["server", "transaction", "durable"],
    effect: "change",
    transactionScope: "saved_record",
    properties: { event: required("namespaced_key"), record: optional("record_reference") },
    kestra: "protected_callback",
    retry: durableRetry,
  },

  // Pure tasks: computed from their inputs, so they may run anywhere.
  "data.calculate": {
    title: "Calculate",
    summary: "Evaluates a typed formula and returns its result, of the declared result type.",
    runLocations: allLocations,
    effect: "pure",
    // `result_type` names a value type; the formula's type must match it and `value` takes it.
    properties: { formula: required("formula"), result_type: required("builder_key") },
    outputs: [output("value", "json")],
    kestra: "evaluator_callback",
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
    kestra: "not_compiled",
  },
  "data.set_values": {
    title: "Set values",
    summary: "Builds a copy of a record's values with fields set, without saving it.",
    runLocations: allLocations,
    effect: "pure",
    properties: { record: required("record_reference"), values: required("field_values") },
    outputs: [output("record", "record_reference")],
    kestra: "evaluator_callback",
  },
  "data.set_variable": {
    title: "Set variable",
    summary: "Sets a flow variable.",
    runLocations: allLocations,
    effect: "pure",
    properties: { variable: required("builder_key"), value: required("any_value") },
    kestra: "evaluator_callback",
  },
  "data.format": {
    title: "Format value",
    summary: "Formats a value with a registered formatter.",
    runLocations: allLocations,
    effect: "pure",
    properties: { formatter: required("builder_key"), input: required("any_value") },
    outputs: [output("value", "json")],
    kestra: "evaluator_callback",
  },
  // Save rules give feedback in the browser and are authoritative in the save transaction.
  "rule.require": {
    title: "Require field",
    summary: "Requires a field to have a value before the record can be saved.",
    runLocations: ["browser", "transaction"],
    effect: "pure",
    properties: { field: required("field_id"), message: required("message_text") },
    kestra: "not_compiled",
  },
  "rule.warn": {
    title: "Warn",
    summary: "Shows a warning that does not stop the save.",
    runLocations: ["browser", "transaction"],
    effect: "pure",
    properties: { message: required("message_text") },
    kestra: "not_compiled",
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
    kestra: "not_compiled",
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
    kestra: "not_compiled",
  },
  "interface.clear_message": {
    title: "Clear message",
    summary: "Removes the message a target shows.",
    runLocations: ["browser"],
    effect: "interface",
    properties: { target: required("builder_key"), component: optional("placement_id") },
    kestra: "not_compiled",
  },
  "interface.set_value": {
    title: "Set page value",
    summary: "Sets a declared page value; the page shows and reads it, the server never trusts it.",
    runLocations: ["browser"],
    effect: "interface",
    properties: { value: required("builder_key"), to: required("any_value") },
    kestra: "not_compiled",
  },
  "interface.validate_form": {
    title: "Validate form",
    summary: "Checks a form's fields and stops the flow with the problems shown when one is invalid.",
    runLocations: ["browser"],
    effect: "interface",
    properties: { form: required("form_id") },
    outputs: [output("valid", "yes_no")],
    kestra: "not_compiled",
  },
  "interface.show_form": {
    title: "Show form",
    summary: "Shows a form and continues with the person's answers.",
    runLocations: ["browser"],
    effect: "interface",
    properties: { form: required("form_id"), inputs: optional("input_map") },
    outputs: [output("submitted", "yes_no"), output("values", "json")],
    kestra: "not_compiled",
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
    kestra: "not_compiled",
  },
  "interface.navigate": {
    title: "Navigate",
    summary: "Opens a page.",
    runLocations: ["browser"],
    effect: "interface",
    properties: { page: required("page_id"), parameters: optional("input_map") },
    kestra: "not_compiled",
  },
  "interface.refresh": {
    title: "Refresh",
    summary: "Refreshes the data of the page or one component on it.",
    runLocations: ["browser"],
    effect: "interface",
    properties: { component: optional("builder_key") },
    kestra: "not_compiled",
  },
  "interface.set_panel": {
    title: "Open or close panel",
    summary: "Opens or closes a panel on the page.",
    runLocations: ["browser"],
    effect: "interface",
    properties: { panel: required("placement_id"), state: required("builder_key") },
    kestra: "not_compiled",
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
    kestra: "not_compiled",
  },
};

const buildDefinition = (type: string, input: DefinitionInput): FlowTaskTypeDefinition => {
  const category = (flowControlTaskTypeKeys as readonly string[]).includes(type)
    ? "control"
    : "registered";
  const protectedEffect = input.effect === "change" || input.effect === "background_start";
  const durableOnly = input.runLocations.length === 1 && input.runLocations[0] === "durable";
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
      timeoutSeconds: input.timeoutSeconds ?? (durableOnly ? 300 : flowMaximumServerSeconds),
      ...(input.retry ? { retry: input.retry } : {}),
      duplicateProtection: protectedEffect ? "required" : "not_applicable",
      redaction: input.redaction ?? (protectedEffect ? "identifiers_only" : "no_payload"),
    },
    kestra: { mode: input.kestra },
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

// ─── Publication: every task's run location ──────────────────────────────────────────────────

/** Where each execution kind runs its steps today: the page and the server, or the back end. */
const flowExecutionImplementations = {
  interactive: ["page", "server"],
  transaction: ["server"],
  background: ["backend"],
  durable: ["backend"],
} as const satisfies Record<FlowExecutionKind, readonly (keyof FlowStepRuns)[]>;

/** Where each execution kind runs its tasks. A task may be placed only where it can run. */
export const flowExecutionRunLocations = {
  interactive: ["browser", "server"],
  transaction: ["transaction"],
  background: ["server"],
  durable: ["durable"],
} as const satisfies Record<FlowExecutionKind, readonly FlowTaskRunLocation[]>;

export type FlowTaskPlacementIssue = {
  path: (string | number)[];
  code:
    | "unknown_task_type"
    | "unsupported_task_version"
    | "wrong_run_location"
    | "unknown_property"
    | "missing_property"
    | "saved_record_target"
    | "refusal_not_possible"
    | "not_yet_runnable";
  message: string;
};

const locationLabels: Record<FlowTaskRunLocation, string> = {
  browser: "the browser",
  server: "the server",
  transaction: "a save transaction",
  durable: "a durable flow",
};

/**
 * Checks every task of a flow, including nested tasks, error handlers and finally tasks, against
 * the registry: the type and pinned version exist, the task can run where this execution kind runs
 * it, its properties match the declared ones, a task in a save transaction changes only the
 * record being saved, and it branches on refusal only when it can be refused. Values inside
 * properties are checked by the compiler, not here.
 */
export const validateFlowTaskPlacement = (
  flow: FlowDefinition | FlowSource,
  registry: Readonly<Record<string, FlowTaskTypeDefinition>> = flowTaskRegistry,
): FlowTaskPlacementIssue[] => {
  const issues: FlowTaskPlacementIssue[] = [];
  const allowedHere = flowExecutionRunLocations[flow.execution] as readonly FlowTaskRunLocation[];
  // An action flow is a transaction flow with no trigger, started only through its binding; every
  // BeforeSave flow shares its run with the other rules and never places an action-flow task.
  const actionFlow = flow.execution === "transaction" && flow.triggers.length === 0;
  const beforeSave = flow.triggers.some((trigger) => trigger.type === "BeforeSave");
  const lifecycleRule = flow.triggers.some(
    (trigger) =>
      trigger.type === "BeforeSave" &&
      trigger.operations.some(
        (operation) => operation.kind === "delete" || operation.kind === "restore",
      ),
  );
  const visit = (tasks: readonly FlowTask[], path: (string | number)[]) => {
    tasks.forEach((flowTask, index) => {
      const taskPath = [...path, index];
      const definition = Object.hasOwn(registry, flowTask.type)
        ? registry[flowTask.type]
        : undefined;
      if (!definition) {
        issues.push({
          path: [...taskPath, "type"],
          code: "unknown_task_type",
          message: `${flowTask.type} is not a registered task type`,
        });
      } else {
        if (
          beforeSave &&
          !["if", "stop", "rule.require", "rule.warn", "rule.refuse"].includes(flowTask.type)
        )
          issues.push({
            path: [...taskPath, "type"],
            code: "wrong_run_location",
            message: `${definition.title} cannot run before a save`,
          });
        // A rule before a delete or restore reads the stored record and has nothing to require.
        else if (lifecycleRule && flowTask.type === "rule.require")
          issues.push({
            path: [...taskPath, "type"],
            code: "wrong_run_location",
            message: `${definition.title} cannot run before a record is deleted or restored`,
          });
        // Only a save reads the warnings and requirements a rule task reports; an action flow
        // would drop them, so it may only refuse.
        if (
          flow.execution === "transaction" &&
          !beforeSave &&
          (flowTask.type === "rule.require" || flowTask.type === "rule.warn")
        )
          issues.push({
            path: [...taskPath, "type"],
            code: "wrong_run_location",
            message: `${definition.title} runs only before a save`,
          });
        if (
          !definition.runLocations.some((location) => allowedHere.includes(location)) &&
          !(actionFlow && definition.actionFlowTransaction === true)
        )
          issues.push({
            path: [...taskPath, "type"],
            code: "wrong_run_location",
            message: `${definition.title} runs only in ${definition.runLocations
              .map((location) => locationLabels[location])
              .join(" or ")}, so it cannot be placed in a ${flow.execution} flow`,
          });
        if (
          !(flowExecutionImplementations[flow.execution] as readonly (keyof FlowStepRuns)[]).some(
            (where) => definition.runs[where],
          )
        )
          issues.push({
            path: [...taskPath, "type"],
            code: "not_yet_runnable",
            message: `${definition.title} cannot run in a ${flow.execution} flow yet`,
          });
        if (!isFlowControlTask(flowTask)) {
          const registered = flowTask as Extract<FlowTask, { properties: unknown }>;
          if (beforeSave && registered.allowRefusal === true)
            issues.push({
              path: [...taskPath, "allowRefusal"],
              code: "refusal_not_possible",
              message: "A refusal before a save ends the save instead of continuing the flow",
            });
          if (registered.version !== definition.version)
            issues.push({
              path: [...taskPath, "version"],
              code: "unsupported_task_version",
              message: `${definition.title} is at version ${definition.version}, not ${registered.version}`,
            });
          for (const name of Object.keys(registered.properties))
            if (!Object.hasOwn(definition.properties, name))
              issues.push({
                path: [...taskPath, "properties", name],
                code: "unknown_property",
                message: `${definition.title} has no property ${name}`,
              });
          for (const [name, property] of Object.entries(definition.properties))
            if (property.required && !Object.hasOwn(registered.properties, name))
              issues.push({
                path: [...taskPath, "properties", name],
                code: "missing_property",
                message: `${definition.title} requires the property ${name}`,
              });
          if (definition.transactionScope === "saved_record")
            for (const name of flowSavedRecordTargetProperties) {
              if (!Object.hasOwn(definition.properties, name)) continue;
              const named = Object.hasOwn(registered.properties, name);
              if (flow.execution === "transaction" && named)
                issues.push({
                  path: [...taskPath, "properties", name],
                  code: "saved_record_target",
                  message: `In a save transaction, ${definition.title} changes only the record being saved, so it cannot name ${name}`,
                });
              else if (flow.execution !== "transaction" && !named)
                issues.push({
                  path: [...taskPath, "properties", name],
                  code: "missing_property",
                  message: `${definition.title} requires the property ${name} outside a save transaction`,
                });
            }
          if (
            registered.allowRefusal === true &&
            !definition.outcomes.some(
              (outcome) =>
                outcome === "refused" || outcome === "conflict" || outcome === "validation",
            )
          )
            issues.push({
              path: [...taskPath, "allowRefusal"],
              code: "refusal_not_possible",
              message: `${definition.title} cannot be refused, so it has nothing to branch on`,
            });
        }
      }
      for (const child of flowTaskChildLists(flowTask))
        visit(child.tasks, [...taskPath, ...child.path]);
    });
  };
  visit(flow.tasks, ["tasks"]);
  visit(flow.errors, ["errors"]);
  visit(flow.finally, ["finally"]);
  return issues;
};
