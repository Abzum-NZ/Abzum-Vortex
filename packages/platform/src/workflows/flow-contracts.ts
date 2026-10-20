import { z } from "zod";
import { workflowValueTypeSchema } from "../catalogue/catalogues";
import {
  correlationIdSchema,
  descriptionSchema,
  jsonValueSchema,
  retryPolicySchema,
} from "../catalogue/common";
import type { JsonValue } from "../catalogue/common";
import {
  actorIdSchema,
  applicationRootIdSchema,
  actionIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  namespacedKeySchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  permissionIdSchema,
  recordTypeIdSchema,
  stableDefinitionReleaseVersionSchema,
  timestampSchema,
} from "../catalogue/identifiers";
import {
  boundedRecord,
  flowFormulaSchema,
  flowFormulaUsesNow,
  flowLiteralSchema,
  flowFormulaValueSchema,
  flowLiteralValueSchema,
  flowReferenceValueSchema,
  flowValueSchema,
  shorthandReferenceValueSchema,
  templateFreeText,
} from "./flow-values";
import type { FlowFormula, FlowLiteral, FlowValue } from "./flow-values";

/** Maximum number of detail lines a flow confirmation can present for explicit review. */
export const maximumFlowConfirmationDetailLines = 500;

/**
 * The one flow definition every behaviour kind uses: interactive actions, named-action bodies,
 * before-save rules, background reactions and durable workflows. It is shaped like a Kestra flow
 * (architecture decision 1): a stored, ordered, nested task list with typed inputs, variables,
 * triggers, outputs, error handling and policies. It is data, never code, and it has no free
 * node-and-edge graph.
 *
 * This contract owns structure and the limits that can be decided from one flow. The task
 * registry (`flow-task-registry.ts`: which task types exist, where they run, their typed
 * properties, and the publication placement check), the value-type catalogue, permanent-identity
 * compilation and cross-definition validation are separate contracts that only read the shapes
 * declared here. Value types currently reuse `workflowValueTypeSchema`
 * until the value-type catalogue replaces it.
 */
export const flowContractVersion = "1.0.0" as const;

/** Closed limits from the architecture decisions, exported so one number governs every consumer. */
export const flowMaximumTaskCount = 100;
export const flowMaximumTaskNestingDepth = 5;

/** The declared type of one JSON object member when its literal shape is known. */
export const flowJsonMemberType = (
  value: JsonValue,
): "text" | "yes_no" | "whole_number" | "decimal_number" | "json" => {
  if (typeof value === "string") return "text";
  if (typeof value === "boolean") return "yes_no";
  if (typeof value === "number")
    return Number.isSafeInteger(value) ? "whole_number" : "decimal_number";
  return "json";
};
export const flowMaximumForEachItemsDurable = 1_000;
export const flowMaximumForEachItemsOther = 100;
export const flowMaximumRunFlowDepth = 3;
/** Runtime budgets for one interactive or background run; enforced by the orchestrator. */
export const flowMaximumProtectedOperations = 25;
export const flowMaximumServerSeconds = 10;

const nilUuid = "00000000-0000-0000-0000-000000000000";
/** Permanent flow identity, distinct from the readable `key`. */
export const flowIdSchema = z
  .uuid()
  .refine((value) => value !== nilUuid, {
    message: "A platform-issued identifier cannot be the nil UUID",
  })
  .brand<"FlowId">();
export type FlowId = z.infer<typeof flowIdSchema>;

export const flowExecutionKindSchema = z.enum([
  "interactive",
  "transaction",
  "background",
  "durable",
]);
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

export const flowBeforeSaveOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create") }).strict(),
  z.object({ kind: z.literal("update") }).strict(),
  z.object({ kind: z.literal("transition"), actionId: actionIdSchema }).strict(),
]);

/** The closed recurrence value a Schedule trigger owns. */
export const flowScheduleRecurrenceSchema = z
  .object({
    cadence: z.enum(["hourly", "daily", "weekly", "monthly"]),
    interval: z.number().int().min(1).max(365),
    timeZone: z.string().min(1).max(100),
    minute: z.number().int().min(0).max(59),
    hour: z.number().int().min(0).max(23).optional(),
    weekDay: z.number().int().min(1).max(7).optional(),
    monthDay: z.number().int().min(1).max(31).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const needsHour = value.cadence !== "hourly";
    const valid =
      (value.hour !== undefined) === needsHour &&
      (value.weekDay !== undefined) === (value.cadence === "weekly") &&
      (value.monthDay !== undefined) === (value.cadence === "monthly");
    if (!valid)
      context.addIssue({
        code: "custom",
        path: ["cadence"],
        message: "Schedule fields must match cadence",
      });
  });

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
      operations: z.array(flowBeforeSaveOperationSchema).min(1).max(20),
      /** Applicable flows run in ascending priority, then in their authored source order. */
      priority: z.number().int().min(0).max(1_000),
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
  z
    .object({
      ...triggerCommonShape,
      type: z.literal("Schedule"),
      recurrence: flowScheduleRecurrenceSchema,
      duplicateProtection: z.literal("scheduled_instant"),
    })
    .strict(),
  z
    .object({
      ...triggerCommonShape,
      type: z.literal("IncomingMessage"),
      messageKey: builderKeySchema,
      duplicateProtection: z.literal("verified_message"),
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
  Schedule: ["durable"],
  IncomingMessage: ["background", "durable"],
} as const satisfies Record<FlowTrigger["type"], readonly FlowExecutionKind[]>);

// ─── Run as ───────────────────────────────────────────────────────────────────────────────────

/**
 * Whose authority protected tasks use. It follows from the execution kind and how the flow starts:
 * - `initiator`: the actor who started the run. For an interactive flow that is the initiating
 *   person (an agent acts as its person); for a durable flow started through Run background flow
 *   it is the run-as of the flow that started it, so a start can never gain another authority.
 * - `saver`: the actor of the save or named action that owns the transaction.
 * - `specified_account` or `system`: required by background flows and by durable flows started by
 *   a Schedule or IncomingMessage trigger; a Run background flow start still uses its starter's
 *   run-as. Execution bindings are Access-owned grants; naming one here grants nothing by itself.
 */
export const flowRunAsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("initiator") }).strict(),
  z.object({ kind: z.literal("saver") }).strict(),
  z
    .object({
      kind: z.literal("specified_account"),
      executionBindingId: containedComponentIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("system"), executionBindingId: containedComponentIdSchema }).strict(),
]);
export type FlowRunAs = z.infer<typeof flowRunAsSchema>;

/** The principal selected by one verified flow-level run-as binding. */
const executionAuthorityActorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("specified_account"),
      organizationAccountId: organizationAccountIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("system"), systemActorId: actorIdSchema }).strict(),
]);

/**
 * The non-person authority a flow orchestrator establishes after resolving its run-as binding.
 * This names the principal only; it carries no person session and grants no task permission.
 * Access still resolves the exact grant for every protected task and operation, and callers must
 * never construct this value from request input or treat parsing it as an authorization decision.
 */
export const executionAuthorityContextSchema = z
  .object({
    kind: z.literal("execution_authority"),
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    flowId: flowIdSchema,
    executionBindingId: containedComponentIdSchema,
    actor: executionAuthorityActorSchema,
    correlationId: correlationIdSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict()
  .refine((value) => Date.parse(value.expiresAt) > Date.parse(value.issuedAt), {
    path: ["expiresAt"],
    message: "Execution-authority context must expire after it is issued",
  });
export type ExecutionAuthorityContext = z.infer<typeof executionAuthorityContextSchema>;

// ─── Tasks: an ordered, nested list ──────────────────────────────────────────────────────────

export const flowControlTaskTypeKeys = [
  "if",
  "switch",
  "for_each",
  "sequential",
  "run_flow",
  "stop",
  "parallel",
  "wait_until",
  "wait_for_person",
] as const;
/** Control tasks that exist only in durable flows. */
export const flowDurableOnlyTaskTypeKeys = ["parallel", "wait_until", "wait_for_person"] as const;

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
  retry?: z.infer<typeof retryPolicySchema> | undefined;
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
    | { type: "parallel"; branches: FlowTask[][] }
    | { type: "wait_until"; until: FlowValue }
    | {
        type: "wait_for_person";
        formId: z.infer<typeof containedComponentIdSchema>;
        assignee: FlowValue;
        inputs: Record<string, FlowValue>;
      }
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
  retry: retryPolicySchema.optional(),
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
        maximumItems: z.number().int().min(1).max(flowMaximumForEachItemsDurable),
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
    z
      .object({
        ...taskCommonShape,
        type: z.literal("parallel"),
        branches: z.array(list).min(2).max(10),
      })
      .strict(),
    z
      .object({ ...taskCommonShape, type: z.literal("wait_until"), until: flowValueSchema })
      .strict(),
    z
      .object({
        ...taskCommonShape,
        type: z.literal("wait_for_person"),
        formId: containedComponentIdSchema,
        assignee: flowValueSchema,
        inputs: boundedRecord(flowValueSchema, 50),
      })
      .strict(),
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
    case "parallel":
      control.branches.forEach((branch, index) =>
        lists.push({ path: ["branches", index], tasks: branch }),
      );
      break;
    default:
      break;
  }
  return lists;
};

/** Every value and formula a task reads, so placement checks reach all of them. */
const taskFormulas = (task: FlowTask): FlowFormula[] => {
  const values: FlowValue[] = [];
  const formulas: FlowFormula[] = [];
  if (isFlowControlTask(task)) {
    const control = task as Extract<FlowTask, { type: (typeof flowControlTaskTypeKeys)[number] }>;
    if (control.type === "if") formulas.push(control.condition);
    else if (control.type === "switch") values.push(control.value);
    else if (control.type === "for_each") values.push(control.items);
    else if (control.type === "run_flow") values.push(...Object.values(control.inputs));
    else if (control.type === "wait_until") values.push(control.until);
    else if (control.type === "wait_for_person")
      values.push(control.assignee, ...Object.values(control.inputs));
  } else {
    values.push(...Object.values((task as { properties: Record<string, FlowValue> }).properties));
  }
  for (const value of values) collectValueFormulas(value, formulas);
  return formulas;
};

/** Every formula one value holds, including nested map entries and array items. */
const collectValueFormulas = (value: FlowValue, into: FlowFormula[]): void => {
  if (value.kind === "formula") into.push(value.formula);
  else if (value.kind === "map")
    for (const entry of Object.values(value.entries)) collectValueFormulas(entry, into);
  else if (value.kind === "array") for (const item of value.items) collectValueFormulas(item, into);
};

// ─── The flow ────────────────────────────────────────────────────────────────────────────────

const flowBaseShape = {
  contractVersion: z.literal(flowContractVersion),
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
  /** Retries are allowed only in durable flows. */
  retry: retryPolicySchema.optional(),
  timeout: flowTaskTimeoutSchema.optional(),
  concurrency: z
    .object({
      limit: z.number().int().min(1).max(100),
      behavior: z.enum(["queue", "cancel", "fail"]),
    })
    .strict()
    .optional(),
};

type FlowShape = {
  execution: FlowExecutionKind;
  runAs: FlowRunAs;
  inputs: Record<string, unknown>;
  recordInput?: string | undefined;
  variables: Record<string, unknown>;
  triggers: FlowTrigger[];
  tasks: FlowTask[];
  outputs: Record<string, FlowOutputDeclaration>;
  errors: FlowTask[];
  finally: FlowTask[];
  retry?: z.infer<typeof retryPolicySchema> | undefined;
  timeout?: z.infer<typeof flowTaskTimeoutSchema> | undefined;
  concurrency?: { limit: number; behavior: "queue" | "cancel" | "fail" } | undefined;
};

const refineFlow = (flow: FlowShape, context: z.RefinementCtx) => {
  const issue = (path: (string | number)[], message: string) =>
    context.addIssue({ code: "custom", path, message });
  const durable = flow.execution === "durable";

  for (const name of Object.keys(flow.variables))
    if (name in flow.inputs)
      issue(["variables", name], "A variable cannot reuse the name of an input");

  // An interactive flow names the input that carries its record; a record trigger supplies the
  // record of every other flow that has one.
  if (flow.recordInput !== undefined) {
    const declaration = flow.inputs[flow.recordInput] as
      Readonly<{ type?: unknown; required?: unknown; recordTypeIds?: unknown }> | undefined;
    if (flow.execution !== "interactive")
      issue(["recordInput"], "Only an interactive flow names the input that carries its record");
    else if (
      declaration === undefined ||
      declaration.type !== "record_reference" ||
      declaration.required !== true ||
      !Array.isArray(declaration.recordTypeIds) ||
      declaration.recordTypeIds.length !== 1
    )
      issue(
        ["recordInput"],
        "The record input must be a declared, required input naming one record of one record type",
      );
  }

  // Triggers must fit the execution kind, and a flow has one execution kind.
  if (flow.execution === "interactive" && flow.triggers.length > 0)
    issue(["triggers"], "An interactive flow starts only through bindings, never a trigger");
  const triggerIds = new Set<string>();
  flow.triggers.forEach((trigger, index) => {
    if (triggerIds.has(trigger.id)) issue(["triggers", index, "id"], "Trigger ids must be unique");
    triggerIds.add(trigger.id);
    if (!(flowTriggerExecutionKinds[trigger.type] as readonly string[]).includes(flow.execution))
      issue(
        ["triggers", index, "type"],
        `A ${trigger.type} trigger cannot start a ${flow.execution} flow`,
      );
    if (trigger.condition !== undefined && flowFormulaUsesNow(trigger.condition))
      issue(["triggers", index, "condition"], "The now operator is not allowed in a trigger");
  });

  // Run as follows from the execution kind and how the flow starts. A durable flow without a
  // system trigger starts only through Run background flow, so it keeps its starter's run-as and
  // cannot declare a specified account or System that a person could borrow by starting it.
  const systemStarted = flow.triggers.some(
    (trigger) => trigger.type === "Schedule" || trigger.type === "IncomingMessage",
  );
  const allowedRunAs: readonly FlowRunAs["kind"][] =
    flow.execution === "interactive"
      ? ["initiator"]
      : flow.execution === "transaction"
        ? ["saver"]
        : flow.execution === "background" || systemStarted
          ? ["specified_account", "system"]
          : ["initiator"];
  if (!allowedRunAs.includes(flow.runAs.kind))
    issue(
      ["runAs", "kind"],
      `A ${flow.execution} flow${systemStarted ? " started by a schedule or message" : ""} cannot run as ${flow.runAs.kind}`,
    );

  // Policies.
  if (!durable && flow.retry !== undefined)
    issue(["retry"], "Retries are allowed only in durable flows");
  if (!durable && flow.timeout !== undefined && flow.timeout.seconds > flowMaximumServerSeconds)
    issue(
      ["timeout", "seconds"],
      `Only durable flows may time out after more than ${flowMaximumServerSeconds} seconds`,
    );
  if (
    flow.concurrency !== undefined &&
    flow.execution !== "durable" &&
    flow.execution !== "background"
  )
    issue(["concurrency"], "Concurrency limits apply only to background and durable flows");

  // Tasks: identity, count, nesting, placement and limits.
  const seenTaskIds = new Set<string>();
  let taskCount = 0;
  const timeAllowed = flow.execution === "interactive" || flow.execution === "background";
  const forEachMaximum = durable ? flowMaximumForEachItemsDurable : flowMaximumForEachItemsOther;
  const visit = (tasks: readonly FlowTask[], path: (string | number)[], depth: number) => {
    tasks.forEach((task, index) => {
      const taskPath = [...path, index];
      taskCount += 1;
      if (depth > flowMaximumTaskNestingDepth)
        issue(taskPath, `Tasks cannot nest deeper than ${flowMaximumTaskNestingDepth} levels`);
      if (seenTaskIds.has(task.id)) issue([...taskPath, "id"], "Task ids must be unique in a flow");
      seenTaskIds.add(task.id);
      if (!durable && (flowDurableOnlyTaskTypeKeys as readonly string[]).includes(task.type))
        issue([...taskPath, "type"], `${task.type} is allowed only in durable flows`);
      if (!durable && task.retry !== undefined)
        issue([...taskPath, "retry"], "Retries are allowed only in durable flows");
      if (!durable && task.timeout !== undefined && task.timeout.seconds > flowMaximumServerSeconds)
        issue(
          [...taskPath, "timeout", "seconds"],
          `Only durable flows may time out after more than ${flowMaximumServerSeconds} seconds`,
        );
      if (
        task.type === "for_each" &&
        (task as { maximumItems: number }).maximumItems > forEachMaximum
      )
        issue(
          [...taskPath, "maximumItems"],
          `For each allows at most ${forEachMaximum.toLocaleString("en-NZ")} items in ${durable ? "durable" : "non-durable"} flows`,
        );
      if (!timeAllowed && taskFormulas(task).some(flowFormulaUsesNow))
        issue(taskPath, "The now operator is allowed only in interactive and background flows");
      for (const child of flowTaskChildLists(task))
        visit(child.tasks, [...taskPath, ...child.path], depth + 1);
    });
  };
  visit(flow.tasks, ["tasks"], 1);
  visit(flow.errors, ["errors"], 1);
  visit(flow.finally, ["finally"], 1);
  if (taskCount > flowMaximumTaskCount)
    issue(
      ["tasks"],
      `A flow can hold at most ${flowMaximumTaskCount} tasks including nested tasks`,
    );

  for (const [name, output] of Object.entries(flow.outputs)) {
    if (timeAllowed) continue;
    const formulas: FlowFormula[] = [];
    collectValueFormulas(output.value, formulas);
    if (formulas.some(flowFormulaUsesNow))
      issue(
        ["outputs", name, "value"],
        "The now operator is allowed only in interactive and background flows",
      );
  }
};

/**
 * The authored form. A flow is authored inside its owner's release; the namespace is derived
 * from that owner and can never be authored.
 */
export const flowSourceSchema = z.object(flowBaseShape).strict().superRefine(refineFlow);
export type FlowSource = z.infer<typeof flowSourceSchema>;

/** The canonical form: the authored fields plus the owner-derived namespace. */
export const flowSchema = z
  .object({ ...flowBaseShape, namespace: namespacedKeySchema })
  .strict()
  .superRefine(refineFlow);
export type FlowDefinition = z.infer<typeof flowSchema>;

// ─── Bindings ────────────────────────────────────────────────────────────────────────────────

/**
 * A value supplied by the invoking surface itself, for example a selection or a form's answers.
 * Its type is checked against the target flow's declared input at publication.
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
