import { flowTaskRegistry } from "./flow-task-registry-data";
import { flowControlTaskTypeKeys } from "./flow-task-tree";
export { flowRegisteredTaskTypeKeys, flowTaskRegistry, flowTaskRuns } from "./flow-task-registry-data";
export type {
  FlowRegisteredTaskTypeKey,
  FlowControlTaskTypeKey,
  FlowTaskTypeKey,
  PageStepType,
  PageIntentStepType,
  ServerStepType,
} from "./flow-task-registry-data";
import { z } from "zod";
import { flowTaskEffectClassSchema, safeFlowResultKindSchema } from "./flow-effects";
import { workflowValueTypeSchema } from "../catalogue/catalogues";
import { flowTaskChildLists, isFlowControlTask } from "./flow-contracts";
import type { FlowDefinition, FlowExecutionKind, FlowSource, FlowTask } from "./flow-contracts";
import {
  builderKeySchema,
  namespacedKeySchema,
  stableDefinitionReleaseVersionSchema,
} from "../catalogue/identifiers";
import { flowMaximumServerSeconds } from "./flow-limits";

/*
 * The one registry of task types (architecture decision 1, "The task registry"). Every building
 * block of every flow is registered once, with where it may be placed, where it runs today, what it
 * does to the world, its typed properties, outputs and outcomes and its default policy.
 *
 * This contract owns the catalogue and the publication placement check. Execution belongs to the
 * shared flow interpreter and the server runners, which read these declarations and never
 * redeclare them. Control tasks are registered here too, so publication can check where every task
 * of a flow is placed; their shapes stay in `flow-contracts.ts`.
 */
/**
 * Where a task may run.
 * - `browser`: in the page; interface and pure tasks only.
 * - `server`: a protected operation in its own short transaction.
 * - `transaction`: inside the owning record save, for every writer.
 */
export const flowTaskRunLocationSchema = z.enum(["browser", "server", "transaction"]);
export type FlowTaskRunLocation = z.infer<typeof flowTaskRunLocationSchema>;

/**
 * Where a step has an implementation: the page (the page performs it), the server (the server
 * interpreter or a server runner executes it) and the back end (a back-end adapter runs it). The
 * contract's `runLocations` say where a step may be placed; these flags say where it runs today.
 * Publication refuses a step placed where it does not run, naming it, and Studio's palette offers
 * a step only where it runs. The page and server implementation maps are typed from these flags
 * for registered tasks (`PageIntentStepType`, `ServerStepType`); control tasks are handled by the
 * shared interpreter.
 */
export const flowStepRunsSchema = z
  .object({ page: z.boolean(), server: z.boolean(), backend: z.boolean() })
  .strict();
export type FlowStepRuns = z.infer<typeof flowStepRunsSchema>;


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
    timeoutSeconds: z.number().int().min(1).max(flowMaximumServerSeconds),
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
    const protectedEffect = value.effect === "change" || value.effect === "background_start";
    if (protectedEffect !== (value.defaultPolicy.duplicateProtection === "required"))
      issue(
        ["defaultPolicy", "duplicateProtection"],
        "Duplicate protection is required exactly for changes and background starts",
      );
    if (new Set(value.outputs.map((output) => output.key)).size !== value.outputs.length)
      issue(["outputs"], "Output keys must be unique");
    if (new Set(value.outcomes).size !== value.outcomes.length)
      issue(["outcomes"], "Outcomes must be unique");
  });
export type FlowTaskTypeDefinition = z.infer<typeof flowTaskTypeDefinitionSchema>;

// ─── The catalogue ───────────────────────────────────────────────────────────────────────────

// ─── Publication: every task's run location ──────────────────────────────────────────────────

/** Where each execution kind runs its steps today: the page and the server, or the back end. */
const flowExecutionImplementations = {
  interactive: ["page", "server"],
  transaction: ["server"],
  background: ["backend"],
} as const satisfies Record<FlowExecutionKind, readonly (keyof FlowStepRuns)[]>;

/** Where each execution kind runs its tasks. A task may be placed only where it can run. */
export const flowExecutionRunLocations = {
  interactive: ["browser", "server"],
  transaction: ["transaction"],
  background: ["server"],
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
