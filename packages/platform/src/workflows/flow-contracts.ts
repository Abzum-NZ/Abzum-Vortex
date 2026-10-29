import { z } from "zod";
import { workflowValueTypeSchema } from "../catalogue/catalogues";
import { descriptionSchema, jsonValueSchema } from "../catalogue/common";
import { builderKeySchema, flowIdSchema, namespacedKeySchema, permissionIdSchema, recordTypeIdSchema, stableDefinitionReleaseVersionSchema } from "../catalogue/identifiers";
import type { FlowId } from "../catalogue/identifiers";
import { boundedRecord, flowFormulaSchema, flowLiteralSchema, flowFormulaValueSchema, flowLiteralValueSchema, flowReferenceValueSchema, flowValueSchema, shorthandReferenceValueSchema, templateFreeText } from "./flow-values";
import { flowMaximumTaskCount, flowMaximumForEachItemsOther, flowMaximumRunFlowDepth } from "./flow-limits";
import type { FlowFormula, FlowLiteral, FlowValue } from "./flow-values";

/**
 * The one flow definition every behaviour kind uses: interactive actions, named-action bodies,
 * before-save rules and back-end reactions. It is shaped like a Kestra flow (architecture decision
 * 1): a stored, ordered, nested task list with typed inputs, variables, triggers, outputs, error
 * handling and policies. It is data, never code, and it has no free node-and-edge graph. Its
 * structure rules (identity, limits, triggers against the execution kind, run as) are checked once,
 * by the flow validator's `validateStructure`.
 *
 * This contract owns structure and the limits that can be decided from one flow. The task
 * registry (`flow-task-registry.ts`: which task types exist, where they run, their typed
 * properties, and the publication placement check), the value-type catalogue, permanent-identity
 * compilation and cross-definition validation are separate contracts that only read the shapes
 * declared here. A flow has no version of its own: it is versioned by the definition contract of the
 * module or application source that owns it (`application-contract-versions.ts`).
 */



/**
 * How a flow runs: `interactive`, started by a person or an agent through a binding; `transaction`,
 * inside one record save (BeforeSave rules and named actions); `background`, on the back end after
 * a commit (an after-save subscriber or a Run on back end child).
 */
export const flowExecutionKindSchema = z.enum(["interactive", "transaction", "background"]);
export type FlowExecutionKind = z.infer<typeof flowExecutionKindSchema>;

/** A selected-record read declares at most twenty output members and source field references. */
export const flowMaximumRecordReadFields = 20;

/** Scalar output types supported by Flow for selected-record field projections. */
export const flowReadFieldsScalarTypeKeys = [
  "text",
  "formatted_text",
  "whole_number",
  "decimal_number",
  "money",
  "yes_no",
  "date",
  "date_time",
  "choice",
] as const satisfies readonly z.infer<typeof workflowValueTypeSchema>[];
export const flowReadFieldsScalarTypeSchema = z.enum(flowReadFieldsScalarTypeKeys);
export type FlowReadFieldsScalarType = z.infer<typeof flowReadFieldsScalarTypeSchema>;

/** Compiler-owned scalar types keyed by the aliases in a selected-record projection. */
export const flowReadFieldsTypeMapSchema = z
  .record(builderKeySchema, flowReadFieldsScalarTypeSchema)
  .superRefine((types, context) => {
    const count = Object.keys(types).length;
    if (count < 1)
      context.addIssue({
        code: "custom",
        message: "A selected-record type map must contain at least one member",
      });
    if (count > flowMaximumRecordReadFields)
      context.addIssue({
        code: "custom",
        message: `A selected-record type map can contain at most ${flowMaximumRecordReadFields} members`,
      });
  });

/** One named output member of a selected-record field projection. */
export const flowReadFieldsProjectionEntrySchema = z
  .object({
    alias: builderKeySchema,
    // A source record type alias can use 240 characters, plus a dot and a 40-character field key.
    field: z.string().min(1).max(281),
  })
  .strict();

/** The closed, ordered projection carried by `record.read_fields`. */
export const flowReadFieldsProjectionSchema = z
  .array(flowReadFieldsProjectionEntrySchema)
  .min(1)
  .max(flowMaximumRecordReadFields)
  .superRefine((fields, context) => {
    const aliases = new Set<string>();
    const references = new Set<string>();
    fields.forEach((field, index) => {
      if (aliases.has(field.alias))
        context.addIssue({
          code: "custom",
          path: [index, "alias"],
          message: "Projection aliases must be unique",
        });
      aliases.add(field.alias);
      if (references.has(field.field))
        context.addIssue({
          code: "custom",
          path: [index, "field"],
          message: "Projected field references must be unique",
        });
      references.add(field.field);
    });
  });

/** The projection is authored as one JSON literal, never a runtime map or computed value. */
export const flowReadFieldsProjectionValueSchema = flowValueSchema.superRefine((value, context) => {
  if (value.kind !== "literal" || value.literal.type !== "json") {
    context.addIssue({
      code: "custom",
      message: "A selected-record projection must be a JSON literal",
    });
    return;
  }
  const projection = flowReadFieldsProjectionSchema.safeParse(value.literal.value);
  if (projection.success) return;
  projection.error.issues.forEach((issue) =>
    context.addIssue({
      code: "custom",
      path: ["literal", "value", ...issue.path],
      message: issue.message,
    }),
  );
});

// ─── Declarations ──────────────────────────────────────────────────────────────────────────────

const recordReferenceTypes = new Set(["record_reference", "record_reference_list"]);
const refineDeclaration = (
  value: {
    type: string;
    recordTypeIds?: readonly string[] | undefined;
    default?: FlowLiteral["value"] | undefined;
  },
  context: z.RefinementCtx,
) => {
  if (recordReferenceTypes.has(value.type) !== (value.recordTypeIds !== undefined))
    context.addIssue({
      code: "custom",
      path: ["recordTypeIds"],
      message: "Record-reference values require their allowed record types",
    });
  if (
    value.recordTypeIds !== undefined &&
    new Set(value.recordTypeIds).size !== value.recordTypeIds.length
  )
    context.addIssue({
      code: "custom",
      path: ["recordTypeIds"],
      message: "Allowed record-type identities must be unique",
    });
  if (value.default !== undefined) {
    const checked = flowLiteralSchema.safeParse({ type: value.type, value: value.default });
    if (!checked.success)
      for (const issue of checked.error.issues)
        context.addIssue({
          code: "custom",
          path: ["default", ...issue.path.slice(1)],
          message: issue.message,
        });
  }
};

const declarationShape = {
  type: workflowValueTypeSchema,
  recordTypeIds: z.array(recordTypeIdSchema).min(1).max(20).optional(),
  description: templateFreeText(z.string().min(1).max(300)).optional(),
  default: jsonValueSchema.optional(),
};

export const flowInputDeclarationSchema = z
  .object({ ...declarationShape, required: z.boolean() })
  .strict()
  .superRefine((value, context) => {
    refineDeclaration(value, context);
    if (value.required && value.default !== undefined)
      context.addIssue({
        code: "custom",
        path: ["default"],
        message: "A required input cannot declare a default",
      });
  });
export type FlowInputDeclaration = z.infer<typeof flowInputDeclarationSchema>;

export const flowDefinitionVariableSchema = z
  .object(declarationShape)
  .strict()
  .superRefine(refineDeclaration);
export type FlowDefinitionVariable = z.infer<typeof flowDefinitionVariableSchema>;

export const flowOutputDeclarationSchema = z
  .object({
    type: workflowValueTypeSchema,
    recordTypeIds: declarationShape.recordTypeIds,
    value: flowValueSchema,
  })
  .strict()
  .superRefine(refineDeclaration);
export type FlowOutputDeclaration = z.infer<typeof flowOutputDeclarationSchema>;

// ─── Triggers: only the automatic starts ─────────────────────────────────────────────────────

export const flowStandardEventKindSchema = z.enum([
  "created",
  "changed",
  "deleted",
  "linked",
  "unlinked",
  "reassigned",
  "state_changed",
]);

/**
 * The record writes a BeforeSave flow covers. A delete or restore rule reads the stored record and
 * may only branch, stop, warn or refuse.
 */
export const flowBeforeSaveOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create") }).strict(),
  z.object({ kind: z.literal("update") }).strict(),
  z.object({ kind: z.literal("delete") }).strict(),
  z.object({ kind: z.literal("restore") }).strict(),
]);
export type FlowBeforeSaveOperation = z.infer<typeof flowBeforeSaveOperationSchema>["kind"];

const triggerCommonShape = {
  id: builderKeySchema,
  /** The typed shape of the values this trigger supplies to the flow. */
  inputs: boundedRecord(flowInputDeclarationSchema, 100).default({}),
  /** Optional entry condition over the trigger's own values. */
  condition: flowFormulaSchema.optional(),
};

export const flowTriggerSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...triggerCommonShape,
      type: z.literal("BeforeSave"),
      recordTypeId: recordTypeIdSchema,
      /** Applicable flows run in the order of the record type's ordered rule list. */
      operations: z.array(flowBeforeSaveOperationSchema).min(1).max(4),
    })
    .strict()
    .superRefine((trigger, context) => {
      const keys = trigger.operations.map((operation) => JSON.stringify(operation));
      if (new Set(keys).size !== keys.length)
        context.addIssue({
          code: "custom",
          path: ["operations"],
          message: "Covered record operations must be unique",
        });
    }),
  z
    .object({
      ...triggerCommonShape,
      type: z.literal("Event"),
      recordTypeId: recordTypeIdSchema,
      event: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("standard"), eventKind: flowStandardEventKindSchema }).strict(),
        z.object({ kind: z.literal("declared"), eventKey: namespacedKeySchema }).strict(),
      ]),
      duplicateProtection: z.literal("committed_occurrence"),
    })
    .strict(),
]);
export type FlowTrigger = z.infer<typeof flowTriggerSchema>;

/** The verified source that caused one flow run to start. */
export const flowTriggerOriginSchema = z.enum(["person", "event", "schedule"]);
export type FlowTriggerOrigin = z.infer<typeof flowTriggerOriginSchema>;

/** Which execution kinds each automatic start may run. */
export const flowTriggerExecutionKinds = Object.freeze({
  BeforeSave: ["transaction"],
  Event: ["background"],
} as const satisfies Record<FlowTrigger["type"], readonly FlowExecutionKind[]>);

// ─── Run as ───────────────────────────────────────────────────────────────────────────────────

/**
 * Whose authority protected tasks use, which follows from the execution kind:
 * - `initiator`: the actor who started the run. For an interactive flow that is the initiating
 *   person (an agent acts as its person); a back-end run runs as the person whose action or save
 *   started it, so a start can never gain another authority.
 * - `saver`: the actor of the save or named action that owns the transaction.
 */
export const flowRunAsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("initiator") }).strict(),
  z.object({ kind: z.literal("saver") }).strict(),
]);
export type FlowRunAs = z.infer<typeof flowRunAsSchema>;

// ─── Tasks: an ordered, nested list ──────────────────────────────────────────────────────────

export const flowControlTaskTypeKeys = [
  "if",
  "switch",
  "for_each",
  "sequential",
  "run_flow",
  "stop",
] as const;

/**
 * Registered (non-control) task type keys are dotted, such as `record.save`, so they can never
 * collide with a control task. Which keys exist is the task registry's decision.
 */
export const flowRegisteredTaskTypeSchema = namespacedKeySchema;

export const flowTaskTimeoutSchema = z
  .object({ seconds: z.number().int().min(1).max(7_776_000) })
  .strict();

type FlowTaskCommon = {
  /** Unique within the flow; the `task` segment of `{{ outputs.task.key }}`. */
  id: string;
  description?: string | undefined;
  timeout?: z.infer<typeof flowTaskTimeoutSchema> | undefined;
};
export type FlowTask = FlowTaskCommon &
  (
    | { type: "if"; condition: FlowFormula; then: FlowTask[]; else?: FlowTask[] | undefined }
    | {
        type: "switch";
        value: FlowValue;
        cases: { key: string; when: FlowLiteral; tasks: FlowTask[] }[];
        default?: FlowTask[] | undefined;
      }
    | { type: "for_each"; items: FlowValue; maximumItems: number; tasks: FlowTask[] }
    | { type: "sequential"; tasks: FlowTask[] }
    | { type: "run_flow"; flowId: FlowId; inputs: Record<string, FlowValue> }
    | { type: "stop"; outcome: string }
    | {
        type: string;
        version: string;
        properties: Record<string, FlowValue>;
        readFieldTypes?: Record<string, FlowReadFieldsScalarType> | undefined;
        allowRefusal?: boolean | undefined;
      }
  );

const taskCommonShape = {
  id: builderKeySchema,
  description: templateFreeText(descriptionSchema).optional(),
  timeout: flowTaskTimeoutSchema.optional(),
};

const flowTaskTreeSchema: z.ZodType<FlowTask> = z.lazy(() => {
  const list = z.array(flowTaskTreeSchema).min(1).max(flowMaximumTaskCount);
  const control = z.discriminatedUnion("type", [
    z
      .object({
        ...taskCommonShape,
        type: z.literal("if"),
        condition: flowFormulaSchema,
        then: list,
        else: list.optional(),
      })
      .strict(),
    z
      .object({
        ...taskCommonShape,
        type: z.literal("switch"),
        value: flowValueSchema,
        cases: z
          .array(z.object({ key: builderKeySchema, when: flowLiteralSchema, tasks: list }).strict())
          .min(1)
          .max(20),
        default: list.optional(),
      })
      .strict()
      .superRefine((task, context) => {
        const keys = new Set<string>();
        const values = new Set<string>();
        task.cases.forEach((entry, index) => {
          if (keys.has(entry.key))
            context.addIssue({
              code: "custom",
              path: ["cases", index, "key"],
              message: "Switch case keys must be unique",
            });
          keys.add(entry.key);
          const value = JSON.stringify(entry.when);
          if (values.has(value))
            context.addIssue({
              code: "custom",
              path: ["cases", index, "when"],
              message: "Switch case values must be unique",
            });
          values.add(value);
        });
      }),
    z
      .object({
        ...taskCommonShape,
        type: z.literal("for_each"),
        items: flowValueSchema,
        maximumItems: z.number().int().min(1).max(flowMaximumForEachItemsOther),
        tasks: list,
      })
      .strict(),
    z.object({ ...taskCommonShape, type: z.literal("sequential"), tasks: list }).strict(),
    z
      .object({
        ...taskCommonShape,
        type: z.literal("run_flow"),
        flowId: flowIdSchema,
        inputs: boundedRecord(flowValueSchema, 50),
      })
      .strict(),
    z.object({ ...taskCommonShape, type: z.literal("stop"), outcome: builderKeySchema }).strict(),
  ]);
  const registered = z
    .object({
      ...taskCommonShape,
      type: flowRegisteredTaskTypeSchema,
      /** Published flows pin the exact registered task version. */
      version: stableDefinitionReleaseVersionSchema,
      properties: boundedRecord(flowValueSchema, 50),
      /** Compiler-owned scalar types for each `record.read_fields` projection alias. */
      readFieldTypes: flowReadFieldsTypeMapSchema.optional(),
      /** When true, a refused, conflict or invalid outcome is branched on instead of failing. */
      allowRefusal: z.boolean().optional(),
    })
    .strict()
    .superRefine((task, context) => {
      if (task.type !== "record.read_fields") {
        if (task.readFieldTypes !== undefined)
          context.addIssue({
            code: "custom",
            path: ["readFieldTypes"],
            message: "A selected-record type map is only valid on record.read_fields tasks",
          });
        return;
      }

      if (task.readFieldTypes === undefined)
        context.addIssue({
          code: "custom",
          path: ["readFieldTypes"],
          message: "A record.read_fields task requires compiler-provided member types",
        });
      if (task.properties.fields === undefined) {
        context.addIssue({
          code: "custom",
          path: ["properties", "fields"],
          message: "A record.read_fields task requires its selected-field projection",
        });
        return;
      }

      const projection = flowReadFieldsProjectionValueSchema.safeParse(task.properties.fields);
      if (!projection.success) {
        projection.error.issues.forEach((issue) =>
          context.addIssue({
            code: "custom",
            path: ["properties", "fields", ...issue.path],
            message: issue.message,
          }),
        );
        return;
      }

      if (task.readFieldTypes === undefined) return;
      const projectionValue = task.properties.fields;
      if (projectionValue.kind !== "literal" || projectionValue.literal.type !== "json") return;
      const fields = flowReadFieldsProjectionSchema.safeParse(projectionValue.literal.value);
      if (!fields.success) return;

      const projectionAliases = new Set(fields.data.map((field) => field.alias));
      const memberAliases = new Set(Object.keys(task.readFieldTypes));
      for (const alias of projectionAliases) {
        if (!memberAliases.has(alias))
          context.addIssue({
            code: "custom",
            path: ["readFieldTypes", alias],
            message: "The selected-record type map must include every projection alias",
          });
      }
      for (const alias of memberAliases) {
        if (!projectionAliases.has(alias))
          context.addIssue({
            code: "custom",
            path: ["readFieldTypes", alias],
            message: "The selected-record type map cannot include undeclared aliases",
          });
      }
    });
  return z.union([control, registered]);
});
export const flowTaskSchema: z.ZodType<FlowTask> = flowTaskTreeSchema;

export const isFlowControlTask = (task: FlowTask): boolean =>
  (flowControlTaskTypeKeys as readonly string[]).includes(task.type);

/** The nested task lists a task owns, with the path segments that reach each. */
export const flowTaskChildLists = (
  task: FlowTask,
): { path: (string | number)[]; tasks: FlowTask[] }[] => {
  const lists: { path: (string | number)[]; tasks: FlowTask[] }[] = [];
  if (!isFlowControlTask(task)) return lists;
  const control = task as Extract<FlowTask, { type: (typeof flowControlTaskTypeKeys)[number] }>;
  switch (control.type) {
    case "if":
      lists.push({ path: ["then"], tasks: control.then });
      if (control.else) lists.push({ path: ["else"], tasks: control.else });
      break;
    case "switch":
      control.cases.forEach((entry, index) =>
        lists.push({ path: ["cases", index, "tasks"], tasks: entry.tasks }),
      );
      if (control.default) lists.push({ path: ["default"], tasks: control.default });
      break;
    case "for_each":
    case "sequential":
      lists.push({ path: ["tasks"], tasks: control.tasks });
      break;
    default:
      break;
  }
  return lists;
};

// ─── The flow ────────────────────────────────────────────────────────────────────────────────

const flowBaseShape = {
  id: flowIdSchema,
  key: builderKeySchema,
  description: templateFreeText(descriptionSchema).optional(),
  /** For search and diagnostics only; never selects or authorises a flow. */
  labels: boundedRecord(templateFreeText(z.string().min(1).max(100)), 20).default({}),
  execution: flowExecutionKindSchema,
  runAs: flowRunAsSchema,
  /** The permission checked before the flow may start through any binding. */
  invocationPermissionId: permissionIdSchema.optional(),
  inputs: boundedRecord(flowInputDeclarationSchema, 100).default({}),
  /**
   * The input that names the record an interactive flow runs for (the record a page shows, the
   * moved card). The platform reads that record afresh under the initiator's access, so the flow
   * reads its fields as `{{ trigger.record.<field> }}`, the one way any flow reads its record.
   */
  recordInput: builderKeySchema.optional(),
  variables: boundedRecord(flowDefinitionVariableSchema, 100).default({}),
  triggers: z.array(flowTriggerSchema).max(10).default([]),
  tasks: z.array(flowTaskSchema).min(1).max(flowMaximumTaskCount),
  outputs: boundedRecord(flowOutputDeclarationSchema, 50).default({}),
  /** Tasks that run when the flow fails. */
  errors: z.array(flowTaskSchema).max(flowMaximumTaskCount).default([]),
  /** Tasks that always run last. */
  finally: z.array(flowTaskSchema).max(flowMaximumTaskCount).default([]),
  timeout: flowTaskTimeoutSchema.optional(),
  concurrency: z
    .object({
      limit: z.number().int().min(1).max(100),
      behavior: z.enum(["queue", "cancel", "fail"]),
    })
    .strict()
    .optional(),
};

/**
 * The authored form. A flow is authored inside its owner's release; the namespace is derived
 * from that owner and can never be authored.
 */
export const flowSourceSchema = z.object(flowBaseShape).strict();
export type FlowSource = z.infer<typeof flowSourceSchema>;

/** The canonical form: the authored fields plus the owner-derived namespace. */
export const flowSchema = z.object({ ...flowBaseShape, namespace: namespacedKeySchema }).strict();
export type FlowDefinition = z.infer<typeof flowSchema>;

// ─── Bindings ────────────────────────────────────────────────────────────────────────────────

/**
 * A value supplied by the invoking surface itself, for example a selection or a form's answers.
 * Publication does not type it: the surface fills it at run time. What the flow does with it is
 * typed in the flow, where a mapped operation input must be of its declared type.
 */
export const flowBindingCallerValueSchema = z
  .object({ kind: z.literal("caller"), name: builderKeySchema })
  .strict();

/**
 * A binding's own input value excludes constructed maps and arrays: the invoking surface fills
 * an input from what it already has and never resolves nested flow values. Both constructors are
 * refused by every surface that can start a flow.
 */
export const flowBindingInputSchema = z.union([
  shorthandReferenceValueSchema,
  z.discriminatedUnion("kind", [
    flowLiteralValueSchema,
    flowReferenceValueSchema,
    flowFormulaValueSchema,
    flowBindingCallerValueSchema,
  ]),
]);
export type FlowBindingInput = z.infer<typeof flowBindingInputSchema>;

/**
 * How anything starts a flow: a component placement, navigation item, interface operation, agent
 * tool or parent flow holds the flow id plus a typed input map, and never flow logic of its own.
 */
export const flowBindingSchema = z
  .object({
    flowId: flowIdSchema,
    inputs: boundedRecord(flowBindingInputSchema, 100).default({}),
  })
  .strict();
export type FlowBinding = z.infer<typeof flowBindingSchema>;

// ─── Run flow across flows ─────────────────────────────────────────────────────────────────────

const collectRunFlowTargets = (flow: FlowDefinition | FlowSource): FlowId[] => {
  const targets: FlowId[] = [];
  const walk = (tasks: readonly FlowTask[]) => {
    for (const task of tasks) {
      if (task.type === "run_flow") targets.push((task as { flowId: FlowId }).flowId);
      for (const child of flowTaskChildLists(task)) walk(child.tasks);
    }
  };
  walk(flow.tasks);
  walk(flow.errors);
  walk(flow.finally);
  return targets;
};

export type FlowCallIssue = {
  flowId: FlowId;
  code: "cycle" | "depth_exceeded" | "transaction_calls_non_transaction";
  message: string;
};

/**
 * Checks Run flow across a set of flows that can see each other: no cycles, a chain of at most
 * three nested calls, and a transaction flow calling only transaction flows. Targets outside the
 * supplied set are the dependency validator's concern, not this function's.
 */
export const validateFlowCallGraph = (
  flows: readonly (FlowDefinition | FlowSource)[],
): FlowCallIssue[] => {
  const byId = new Map(flows.map((flow) => [flow.id, flow]));
  const issues: FlowCallIssue[] = [];
  for (const flow of flows) {
    for (const targetId of collectRunFlowTargets(flow)) {
      const target = byId.get(targetId);
      if (flow.execution === "transaction" && target && target.execution !== "transaction")
        issues.push({
          flowId: flow.id,
          code: "transaction_calls_non_transaction",
          message: "A transaction flow may run only another transaction flow",
        });
    }
  }
  // One depth-first walk with memoised chain lengths, so shared callees are measured once.
  const reportedCycles = new Set<FlowId>();
  const visiting = new Set<FlowId>();
  const chainLengths = new Map<FlowId, number>();
  const longestChain = (flow: FlowDefinition | FlowSource): number => {
    const known = chainLengths.get(flow.id);
    if (known !== undefined) return known;
    visiting.add(flow.id);
    let longest = 0;
    for (const targetId of new Set(collectRunFlowTargets(flow))) {
      const target = byId.get(targetId);
      if (!target) continue;
      if (visiting.has(targetId)) {
        if (!reportedCycles.has(targetId)) {
          reportedCycles.add(targetId);
          issues.push({
            flowId: targetId,
            code: "cycle",
            message: "Flows cannot call each other in a cycle",
          });
        }
        continue;
      }
      longest = Math.max(longest, 1 + longestChain(target));
    }
    visiting.delete(flow.id);
    chainLengths.set(flow.id, longest);
    return longest;
  };
  for (const flow of flows) {
    if (longestChain(flow) > flowMaximumRunFlowDepth)
      issues.push({
        flowId: flow.id,
        code: "depth_exceeded",
        message: `Run flow can nest at most ${flowMaximumRunFlowDepth} calls deep`,
      });
  }
  return issues;
};
