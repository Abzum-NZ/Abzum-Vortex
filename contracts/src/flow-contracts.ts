import { z } from "zod";
import { workflowValueTypeSchema } from "./catalogues";
import {
  conditionMaximumNestingDepth,
  conditionMaximumOperandCount,
  descriptionSchema,
  jsonValueSchema,
  retryPolicySchema,
} from "./common";
import type { JsonValue } from "./common";
import { parseExactDecimal } from "./exact-decimal";
import {
  actionIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  namespacedKeySchema,
  permissionIdSchema,
  recordTypeIdSchema,
  stableDefinitionReleaseVersionSchema,
} from "./identifiers";

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

const templateDelimiterPattern = /\{\{|\{%/;
const hasTemplateDelimiter = (value: string) => templateDelimiterPattern.test(value);
const jsonContainsTemplateDelimiter = (value: JsonValue): boolean => {
  if (typeof value === "string") return hasTemplateDelimiter(value);
  if (Array.isArray(value)) return value.some(jsonContainsTemplateDelimiter);
  if (value !== null && typeof value === "object")
    return Object.entries(value).some(
      ([key, child]) => hasTemplateDelimiter(key) || jsonContainsTemplateDelimiter(child),
    );
  return false;
};

/** Builder-facing text. It can never carry template delimiters, so no text can become a template. */
const templateFreeText = (schema: z.ZodString) =>
  schema.refine((value) => !hasTemplateDelimiter(value), {
    message: "Text cannot contain template delimiters; use a typed reference",
  });

const boundedRecord = <Value extends z.ZodType>(value: Value, maximum: number) =>
  z.record(builderKeySchema, value).refine((record) => Object.keys(record).length <= maximum, {
    message: `At most ${maximum} entries are allowed`,
  });

// ─── Closed reference syntax ────────────────────────────────────────────────────────────────

/**
 * A reference resolved to its typed form. Names are declared builder keys; nothing here is ever
 * evaluated as text. `{{ outputs.task.outcome }}` is a task output whose key is `outcome`.
 */
export const flowReferenceObjectSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("input"), name: builderKeySchema }).strict(),
  z.object({ source: z.literal("variable"), name: builderKeySchema }).strict(),
  z.object({ source: z.literal("trigger_record"), field: builderKeySchema }).strict(),
  z.object({ source: z.literal("trigger_previous"), field: builderKeySchema }).strict(),
  z
    .object({ source: z.literal("task_output"), task: builderKeySchema, key: builderKeySchema })
    .strict(),
  z.object({ source: z.literal("execution_actor") }).strict(),
  z.object({ source: z.literal("execution_now") }).strict(),
]);
export type FlowReference = z.infer<typeof flowReferenceObjectSchema>;

const referenceName = "([a-z][a-z0-9]*(?:_[a-z0-9]+)*)";
const referencePatterns = {
  input: new RegExp(`^\\{\\{\\s*inputs\\.${referenceName}\\s*\\}\\}$`),
  variable: new RegExp(`^\\{\\{\\s*vars\\.${referenceName}\\s*\\}\\}$`),
  triggerRecord: new RegExp(`^\\{\\{\\s*trigger\\.record\\.${referenceName}\\s*\\}\\}$`),
  triggerPrevious: new RegExp(`^\\{\\{\\s*trigger\\.previous\\.${referenceName}\\s*\\}\\}$`),
  taskOutput: new RegExp(`^\\{\\{\\s*outputs\\.${referenceName}\\.${referenceName}\\s*\\}\\}$`),
  executionActor: /^\{\{\s*execution\.actor\s*\}\}$/,
  executionNow: /^\{\{\s*execution\.now\s*\}\}$/,
} as const;

/**
 * Parses one whole string as exactly one closed reference. Anything else, including a reference
 * embedded in other text, a function, filter, arithmetic or an undeclared root, returns `undefined`.
 */
export const parseFlowReference = (text: string): FlowReference | undefined => {
  let match: RegExpExecArray | null;
  let reference: FlowReference | undefined;
  if ((match = referencePatterns.input.exec(text))) reference = { source: "input", name: match[1]! };
  else if ((match = referencePatterns.variable.exec(text)))
    reference = { source: "variable", name: match[1]! };
  else if ((match = referencePatterns.triggerRecord.exec(text)))
    reference = { source: "trigger_record", field: match[1]! };
  else if ((match = referencePatterns.triggerPrevious.exec(text)))
    reference = { source: "trigger_previous", field: match[1]! };
  else if ((match = referencePatterns.taskOutput.exec(text)))
    reference = { source: "task_output", task: match[1]!, key: match[2]! };
  else if (referencePatterns.executionActor.test(text)) reference = { source: "execution_actor" };
  else if (referencePatterns.executionNow.test(text)) reference = { source: "execution_now" };
  return reference !== undefined && flowReferenceObjectSchema.safeParse(reference).success
    ? reference
    : undefined;
};

/** The one canonical text form of a typed reference, for designers and diagnostics. */
export const formatFlowReference = (reference: FlowReference): string => {
  switch (reference.source) {
    case "input":
      return `{{ inputs.${reference.name} }}`;
    case "variable":
      return `{{ vars.${reference.name} }}`;
    case "trigger_record":
      return `{{ trigger.record.${reference.field} }}`;
    case "trigger_previous":
      return `{{ trigger.previous.${reference.field} }}`;
    case "task_output":
      return `{{ outputs.${reference.task}.${reference.key} }}`;
    case "execution_actor":
      return "{{ execution.actor }}";
    case "execution_now":
      return "{{ execution.now }}";
  }
};

const referenceTextSchema = z.string().transform((text, context) => {
  const reference = parseFlowReference(text);
  if (reference === undefined) {
    context.addIssue({
      code: "custom",
      message:
        "Use a closed reference such as {{ inputs.x }}, {{ vars.x }}, {{ trigger.record.f }}, {{ trigger.previous.f }}, {{ outputs.task.key }}, {{ execution.actor }} or {{ execution.now }}; text is never evaluated",
    });
    return z.NEVER;
  }
  return reference;
});

/** Authored as the closed text or already typed; always parsed to the typed reference. */
export const flowReferenceSchema = z.union([referenceTextSchema, flowReferenceObjectSchema]);

// ─── Typed literals ────────────────────────────────────────────────────────────────────────

const isoDateSchema = z.iso.date();
const isoDateTimeSchema = z.iso.datetime({ offset: true });
const isNonEmptyText = (value: JsonValue) => typeof value === "string" && value.length > 0;

const literalMatchesType = (type: string, value: JsonValue): boolean => {
  switch (type) {
    case "yes_no":
      return typeof value === "boolean";
    case "whole_number":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "decimal_number":
    case "money":
      return parseExactDecimal(value) !== undefined;
    case "date":
      return isoDateSchema.safeParse(value).success;
    case "date_time":
      return isoDateTimeSchema.safeParse(value).success;
    case "text":
    case "formatted_text":
      return typeof value === "string";
    case "choice":
    case "record_reference":
    case "organization_account_reference":
    case "workflow_run_reference":
    case "relationship_reference":
    case "file_reference":
      return isNonEmptyText(value);
    case "several_choices":
    case "record_reference_list":
    case "relationship_reference_list":
      return Array.isArray(value) && value.every(isNonEmptyText);
    case "json":
      return true;
    default:
      return false;
  }
};

export const flowLiteralSchema = z
  .object({ type: workflowValueTypeSchema, value: jsonValueSchema })
  .strict()
  .superRefine((literal, context) => {
    if (!literalMatchesType(literal.type, literal.value))
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: `The literal does not match the ${literal.type} type`,
      });
    if (jsonContainsTemplateDelimiter(literal.value))
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Literal text cannot contain template delimiters; use a typed reference",
      });
  });
export type FlowLiteral = z.infer<typeof flowLiteralSchema>;

// ─── Formula: a typed JSON expression tree over a closed operator catalogue ───────────────────

export const flowRoundingModeSchema = z.enum([
  "half_up",
  "half_even",
  "half_down",
  "up",
  "down",
  "ceiling",
  "floor",
]);
export const flowDateUnitSchema = z.enum(["minutes", "hours", "days", "weeks", "months", "years"]);
export type FlowRoundingMode = z.infer<typeof flowRoundingModeSchema>;
export type FlowDateUnit = z.infer<typeof flowDateUnitSchema>;

export const flowFormulaOperatorKeys = [
  "literal",
  "reference",
  "now",
  "add",
  "subtract",
  "multiply",
  "divide",
  "round",
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "starts_with",
  "ends_with",
  "is_empty",
  "is_not_empty",
  "in",
  "and",
  "or",
  "not",
  "if",
  "join",
  "date_add",
  "date_diff",
] as const;

type ArithmeticPrecision = { scale: number; rounding: FlowRoundingMode };
export type FlowFormula =
  | { op: "literal"; type: FlowLiteral["type"]; value: JsonValue }
  | { op: "reference"; reference: FlowReference }
  | { op: "now" }
  | ({ op: "add" | "multiply"; args: FlowFormula[] } & ArithmeticPrecision)
  | ({ op: "subtract" | "divide"; args: [FlowFormula, FlowFormula] } & ArithmeticPrecision)
  | ({ op: "round"; arg: FlowFormula } & ArithmeticPrecision)
  | {
      op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "contains" | "starts_with" | "ends_with";
      left: FlowFormula;
      right: FlowFormula;
    }
  | { op: "is_empty" | "is_not_empty"; arg: FlowFormula }
  | { op: "in"; value: FlowFormula; options: FlowFormula[] }
  | { op: "and" | "or"; args: FlowFormula[] }
  | { op: "not"; arg: FlowFormula }
  | { op: "if"; condition: FlowFormula; then: FlowFormula; else: FlowFormula }
  | { op: "join"; parts: FlowFormula[]; separator?: string | undefined }
  | { op: "date_add"; date: FlowFormula; amount: FlowFormula; unit: FlowDateUnit }
  | { op: "date_diff"; from: FlowFormula; to: FlowFormula; unit: FlowDateUnit };

const precisionShape = {
  scale: z.number().int().min(0).max(18),
  rounding: flowRoundingModeSchema,
};

const flowFormulaTreeSchema: z.ZodType<FlowFormula> = z.lazy(() =>
  z.discriminatedUnion("op", [
    z
      .object({
        op: z.literal("literal"),
        type: workflowValueTypeSchema,
        value: jsonValueSchema,
      })
      .strict()
      .superRefine((literal, context) => {
        const checked = flowLiteralSchema.safeParse({ type: literal.type, value: literal.value });
        if (!checked.success)
          for (const issue of checked.error.issues)
            context.addIssue({ code: "custom", path: issue.path, message: issue.message });
      }),
    z.object({ op: z.literal("reference"), reference: flowReferenceSchema }).strict(),
    z.object({ op: z.literal("now") }).strict(),
    z
      .object({
        op: z.literal("add"),
        args: z.array(flowFormulaTreeSchema).min(2).max(10),
        ...precisionShape,
      })
      .strict(),
    z
      .object({
        op: z.literal("multiply"),
        args: z.array(flowFormulaTreeSchema).min(2).max(10),
        ...precisionShape,
      })
      .strict(),
    z
      .object({
        op: z.literal("subtract"),
        args: z.tuple([flowFormulaTreeSchema, flowFormulaTreeSchema]),
        ...precisionShape,
      })
      .strict(),
    z
      .object({
        op: z.literal("divide"),
        args: z.tuple([flowFormulaTreeSchema, flowFormulaTreeSchema]),
        ...precisionShape,
      })
      .strict(),
    z.object({ op: z.literal("round"), arg: flowFormulaTreeSchema, ...precisionShape }).strict(),
    z
      .object({
        op: z.enum(["eq", "neq", "lt", "lte", "gt", "gte", "contains", "starts_with", "ends_with"]),
        left: flowFormulaTreeSchema,
        right: flowFormulaTreeSchema,
      })
      .strict(),
    z.object({ op: z.literal("is_empty"), arg: flowFormulaTreeSchema }).strict(),
    z.object({ op: z.literal("is_not_empty"), arg: flowFormulaTreeSchema }).strict(),
    z
      .object({
        op: z.literal("in"),
        value: flowFormulaTreeSchema,
        options: z.array(flowFormulaTreeSchema).min(1).max(50),
      })
      .strict(),
    z
      .object({ op: z.literal("and"), args: z.array(flowFormulaTreeSchema).min(2).max(20) })
      .strict(),
    z
      .object({ op: z.literal("or"), args: z.array(flowFormulaTreeSchema).min(2).max(20) })
      .strict(),
    z.object({ op: z.literal("not"), arg: flowFormulaTreeSchema }).strict(),
    z
      .object({
        op: z.literal("if"),
        condition: flowFormulaTreeSchema,
        then: flowFormulaTreeSchema,
        else: flowFormulaTreeSchema,
      })
      .strict(),
    z
      .object({
        op: z.literal("join"),
        parts: z.array(flowFormulaTreeSchema).min(1).max(20),
        separator: templateFreeText(z.string().max(20)).optional(),
      })
      .strict(),
    z
      .object({
        op: z.literal("date_add"),
        date: flowFormulaTreeSchema,
        amount: flowFormulaTreeSchema,
        unit: flowDateUnitSchema,
      })
      .strict(),
    z
      .object({
        op: z.literal("date_diff"),
        from: flowFormulaTreeSchema,
        to: flowFormulaTreeSchema,
        unit: flowDateUnitSchema,
      })
      .strict(),
  ]),
);

const formulaChildren = (formula: FlowFormula): readonly FlowFormula[] => {
  switch (formula.op) {
    case "literal":
    case "reference":
    case "now":
      return [];
    case "add":
    case "multiply":
    case "subtract":
    case "divide":
    case "and":
    case "or":
      return formula.args;
    case "round":
    case "is_empty":
    case "is_not_empty":
    case "not":
      return [formula.arg];
    case "in":
      return [formula.value, ...formula.options];
    case "if":
      return [formula.condition, formula.then, formula.else];
    case "join":
      return formula.parts;
    case "date_add":
      return [formula.date, formula.amount];
    case "date_diff":
      return [formula.from, formula.to];
    default:
      return [formula.left, formula.right];
  }
};

const inspectFormula = (
  formula: FlowFormula,
  depth = 1,
): { depth: number; nodes: number; usesNow: boolean } => {
  const inspected = formulaChildren(formula).map((child) => inspectFormula(child, depth + 1));
  return {
    depth: Math.max(depth, ...inspected.map((child) => child.depth)),
    nodes: 1 + inspected.reduce((total, child) => total + child.nodes, 0),
    usesNow: formula.op === "now" || inspected.some((child) => child.usesNow),
  };
};

/** True when the formula reads the current time through the `now` operator. */
export const flowFormulaUsesNow = (formula: FlowFormula): boolean =>
  inspectFormula(formula).usesNow;

/**
 * A formula bounded in depth and size. Whether `now` may appear depends on where the formula
 * lives (read-time computed fields and interactive or background flows only), so the flow
 * contract enforces that at its own level.
 */
export const flowFormulaSchema: z.ZodType<FlowFormula> = flowFormulaTreeSchema.superRefine(
  (formula, context) => {
    const inspected = inspectFormula(formula);
    if (inspected.depth > conditionMaximumNestingDepth)
      context.addIssue({
        code: "custom",
        message: `Formula nesting cannot exceed ${conditionMaximumNestingDepth} levels`,
      });
    if (inspected.nodes > conditionMaximumOperandCount)
      context.addIssue({
        code: "custom",
        message: `Formula cannot exceed ${conditionMaximumOperandCount} operators and operands`,
      });
  },
);

// ─── Values: literal, closed reference or formula ─────────────────────────────────────────────

export const flowValueObjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), literal: flowLiteralSchema }).strict(),
  z.object({ kind: z.literal("reference"), reference: flowReferenceSchema }).strict(),
  z.object({ kind: z.literal("formula"), formula: flowFormulaSchema }).strict(),
]);

const shorthandReferenceValueSchema = z.string().transform((text, context) => {
  const reference = parseFlowReference(text);
  if (reference === undefined) {
    context.addIssue({
      code: "custom",
      message:
        "A bare text value must be exactly one closed reference; write a literal as { kind: \"literal\", literal: { type, value } }",
    });
    return z.NEVER;
  }
  return { kind: "reference" as const, reference };
});

/**
 * A value in a task property or input map. A bare string is only accepted as one whole closed
 * reference, so an untyped or malformed reference is refused rather than kept as text.
 */
export const flowValueSchema = z.union([shorthandReferenceValueSchema, flowValueObjectSchema]);
export type FlowValue = z.infer<typeof flowValueSchema>;

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
        context.addIssue({ code: "custom", path: ["default", ...issue.path.slice(1)], message: issue.message });
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
      /** Applicable rules run in ascending priority, then by permanent flow id. */
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
  z
    .object({ kind: z.literal("system"), executionBindingId: containedComponentIdSchema })
    .strict(),
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
      /** When true, a refused, conflict or invalid outcome is branched on instead of failing. */
      allowRefusal: z.boolean().optional(),
    })
    .strict();
  return z.union([control, registered]);
});
export const flowTaskSchema: z.ZodType<FlowTask> = flowTaskTreeSchema;

export const isFlowControlTask = (task: FlowTask): boolean =>
  (flowControlTaskTypeKeys as readonly string[]).includes(task.type);

/** The nested task lists a task owns, with the path segments that reach each. */
export const flowTaskChildLists = (task: FlowTask): { path: (string | number)[]; tasks: FlowTask[] }[] => {
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
  for (const value of values) if (value.kind === "formula") formulas.push(value.formula);
  return formulas;
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
    issue(["timeout", "seconds"], `Only durable flows may time out after more than ${flowMaximumServerSeconds} seconds`);
  if (flow.concurrency !== undefined && flow.execution !== "durable" && flow.execution !== "background")
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
      if (
        !durable &&
        (flowDurableOnlyTaskTypeKeys as readonly string[]).includes(task.type)
      )
        issue([...taskPath, "type"], `${task.type} is allowed only in durable flows`);
      if (!durable && task.retry !== undefined)
        issue([...taskPath, "retry"], "Retries are allowed only in durable flows");
      if (!durable && task.timeout !== undefined && task.timeout.seconds > flowMaximumServerSeconds)
        issue([...taskPath, "timeout", "seconds"], `Only durable flows may time out after more than ${flowMaximumServerSeconds} seconds`);
      if (task.type === "for_each" && (task as { maximumItems: number }).maximumItems > forEachMaximum)
        issue(
          [...taskPath, "maximumItems"],
          `For each allows at most ${forEachMaximum.toLocaleString("en-NZ")} items in ${durable ? "durable" : "non-durable"} flows`,
        );
      if (!timeAllowed && taskFormulas(task).some(flowFormulaUsesNow))
        issue(taskPath, "The now operator is allowed only in interactive and background flows");
      for (const child of flowTaskChildLists(task)) visit(child.tasks, [...taskPath, ...child.path], depth + 1);
    });
  };
  visit(flow.tasks, ["tasks"], 1);
  visit(flow.errors, ["errors"], 1);
  visit(flow.finally, ["finally"], 1);
  if (taskCount > flowMaximumTaskCount)
    issue(["tasks"], `A flow can hold at most ${flowMaximumTaskCount} tasks including nested tasks`);

  for (const [name, output] of Object.entries(flow.outputs)) {
    if (output.value.kind === "formula" && !timeAllowed && flowFormulaUsesNow(output.value.formula))
      issue(["outputs", name, "value"], "The now operator is allowed only in interactive and background flows");
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

export const flowBindingInputSchema = z.union([
  shorthandReferenceValueSchema,
  z.discriminatedUnion("kind", [
    ...flowValueObjectSchema.options,
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
