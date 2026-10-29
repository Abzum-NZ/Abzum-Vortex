import { z } from "zod";
import { workflowValueTypeSchema } from "../catalogue/catalogues";
import {
  conditionMaximumNestingDepth,
  conditionMaximumOperandCount,
  jsonValueSchema,
} from "../catalogue/common";
import type { JsonValue } from "../catalogue/common";
import { typedValueMatchesType } from "../rules/condition-types";
import { builderKeySchema, fieldIdSchema } from "../catalogue/identifiers";

/**
 * The value language of a flow: closed references, typed literals, formulas and constructed
 * map and array values. `flow-contracts.ts` composes these into declarations, triggers, tasks
 * and the flow itself.
 */

/** A task output may select a bounded sequence of named fields from a JSON output. */
export const flowMaximumTaskOutputPathDepth = 5;

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
export const templateFreeText = (schema: z.ZodString) =>
  schema.refine((value) => !hasTemplateDelimiter(value), {
    message: "Text cannot contain template delimiters; use a typed reference",
  });

export const boundedRecord = <Value extends z.ZodType>(value: Value, maximum: number) =>
  z.record(builderKeySchema, value).refine((record) => Object.keys(record).length <= maximum, {
    message: `At most ${maximum} entries are allowed`,
  });

// ─── Closed reference syntax ────────────────────────────────────────────────────────────────

/**
 * A reference resolved to its typed form. Names are declared builder keys; Module calculation
 * fields use permanent identities and are refused in ordinary Flow contexts. Nothing is ever
 * evaluated as text. `{{ outputs.task.outcome }}` is a task output whose key is `outcome`; a
 * bounded suffix such as `{{ outputs.form.values.label }}` selects named fields from a JSON output.
 */
export const flowReferenceObjectSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("input"), name: builderKeySchema }).strict(),
  z.object({ source: z.literal("variable"), name: builderKeySchema }).strict(),
  z.object({ source: z.literal("trigger_record"), field: builderKeySchema }).strict(),
  z.object({ source: z.literal("trigger_previous"), field: builderKeySchema }).strict(),
  z.object({ source: z.literal("module_field"), fieldId: fieldIdSchema }).strict(),
  z
    .object({
      source: z.literal("task_output"),
      task: builderKeySchema,
      key: builderKeySchema,
      path: z.array(builderKeySchema).min(1).max(flowMaximumTaskOutputPathDepth).optional(),
    })
    .strict(),
  z.object({ source: z.literal("execution_actor") }).strict(),
  z.object({ source: z.literal("execution_now") }).strict(),
  /** A value the page declares; it lives only in the page and never crosses to the server. */
  z.object({ source: z.literal("page"), name: builderKeySchema }).strict(),
  /** A field of a named form on the page: the form's placement and the field's key. */
  z
    .object({ source: z.literal("form"), form: z.string().min(1).max(240), field: builderKeySchema })
    .strict(),
]);
export type FlowReference = z.infer<typeof flowReferenceObjectSchema>;

const referenceName = "([a-z][a-z0-9]*(?:_[a-z0-9]+)*)";
const referencePatterns = {
  input: new RegExp(`^\\{\\{\\s*inputs\\.${referenceName}\\s*\\}\\}$`),
  variable: new RegExp(`^\\{\\{\\s*vars\\.${referenceName}\\s*\\}\\}$`),
  triggerRecord: new RegExp(`^\\{\\{\\s*trigger\\.record\\.${referenceName}\\s*\\}\\}$`),
  triggerPrevious: new RegExp(`^\\{\\{\\s*trigger\\.previous\\.${referenceName}\\s*\\}\\}$`),
  moduleField: /^\{\{\s*module\.fields\.([0-9a-fA-F-]+)\s*\}\}$/,
  taskOutput: new RegExp(
    `^\\{\\{\\s*outputs\\.${referenceName}\\.${referenceName}((?:\\.${referenceName})*)\\s*\\}\\}$`,
  ),
  executionActor: /^\{\{\s*execution\.actor\s*\}\}$/,
  executionNow: /^\{\{\s*execution\.now\s*\}\}$/,
  page: new RegExp(`^\\{\\{\\s*page\\.${referenceName}\\s*\\}\\}$`),
  form: new RegExp(`^\\{\\{\\s*forms\\.${referenceName}\\.${referenceName}\\s*\\}\\}$`),
} as const;

/**
 * Parses one whole string as exactly one closed reference. Anything else, including a reference
 * embedded in other text, a function, filter, arithmetic or an undeclared root, returns `undefined`.
 */
export const parseFlowReference = (text: string): FlowReference | undefined => {
  let match: RegExpExecArray | null;
  let reference: FlowReference | undefined;
  if ((match = referencePatterns.input.exec(text)))
    reference = { source: "input", name: match[1]! };
  else if ((match = referencePatterns.variable.exec(text)))
    reference = { source: "variable", name: match[1]! };
  else if ((match = referencePatterns.triggerRecord.exec(text)))
    reference = { source: "trigger_record", field: match[1]! };
  else if ((match = referencePatterns.triggerPrevious.exec(text)))
    reference = { source: "trigger_previous", field: match[1]! };
  else if ((match = referencePatterns.moduleField.exec(text))) {
    const fieldId = fieldIdSchema.safeParse(match[1]);
    if (fieldId.success) reference = { source: "module_field", fieldId: fieldId.data };
  } else if ((match = referencePatterns.taskOutput.exec(text))) {
    const path = match[3] === "" ? undefined : match[3]!.slice(1).split(".");
    reference = {
      source: "task_output",
      task: match[1]!,
      key: match[2]!,
      ...(path === undefined ? {} : { path }),
    };
  } else if (referencePatterns.executionActor.test(text)) reference = { source: "execution_actor" };
  else if (referencePatterns.executionNow.test(text)) reference = { source: "execution_now" };
  else if ((match = referencePatterns.page.exec(text)))
    reference = { source: "page", name: match[1]! };
  else if ((match = referencePatterns.form.exec(text)))
    reference = { source: "form", form: match[1]!, field: match[2]! };
  return reference !== undefined && flowReferenceObjectSchema.safeParse(reference).success
    ? reference
    : undefined;
};

const referenceTextSchema = z.string().transform((text, context) => {
  const reference = parseFlowReference(text);
  if (reference === undefined) {
    context.addIssue({
      code: "custom",
      message:
        "Use a closed reference such as {{ inputs.x }}, {{ vars.x }}, {{ trigger.record.f }}, {{ trigger.previous.f }}, {{ outputs.task.key }}, {{ outputs.form.values.label }}, {{ execution.actor }}, {{ execution.now }}, {{ page.x }} or {{ forms.form.field }}; Module calculations may use {{ module.fields.<permanent fieldId> }}; text is never evaluated",
    });
    return z.NEVER;
  }
  return reference;
});

/** Authored as the closed text or already typed; always parsed to the typed reference. */
export const flowReferenceSchema = z.union([referenceTextSchema, flowReferenceObjectSchema]);

// ─── Typed literals ────────────────────────────────────────────────────────────────────────

export const flowLiteralSchema = z
  .object({ type: workflowValueTypeSchema, value: jsonValueSchema })
  .strict()
  .superRefine((literal, context) => {
    if (!typedValueMatchesType(literal.value, literal.type, "flow"))
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

type ArithmeticPrecision = { scale: number; rounding: FlowRoundingMode };
export type FlowFormula =
  | { op: "literal"; type: FlowLiteral["type"]; value: JsonValue }
  | { op: "reference"; reference: FlowReference }
  | { op: "now" }
  | {
      op: "deadline_passed";
      due: FlowFormula;
      status?: FlowFormula | undefined;
      terminalStatusValues: JsonValue[];
    }
  | { op: "record_id"; arg: FlowFormula }
  | { op: "add" | "multiply"; args: FlowFormula[] }
  | { op: "subtract" | "divide"; args: [FlowFormula, FlowFormula] }
  | ({ op: "round"; arg: FlowFormula } & ArithmeticPrecision)
  | { op: "min" | "max" | "coalesce"; args: FlowFormula[] }
  | ({ op: "percent"; args: [FlowFormula, FlowFormula] } & ArithmeticPrecision)
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
        op: z.literal("deadline_passed"),
        due: flowFormulaTreeSchema,
        status: flowFormulaTreeSchema.optional(),
        terminalStatusValues: z.array(jsonValueSchema).max(20),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.status === undefined && value.terminalStatusValues.length > 0)
          context.addIssue({
            code: "custom",
            path: ["status"],
            message: "Terminal statuses require a status operand",
          });
      }),
    z.object({ op: z.literal("record_id"), arg: flowFormulaTreeSchema }).strict(),
    z
      .object({
        op: z.literal("add"),
        args: z.array(flowFormulaTreeSchema).min(2).max(10),
      })
      .strict(),
    z
      .object({
        op: z.literal("multiply"),
        args: z.array(flowFormulaTreeSchema).min(2).max(10),
      })
      .strict(),
    z
      .object({
        op: z.literal("subtract"),
        args: z.tuple([flowFormulaTreeSchema, flowFormulaTreeSchema]),
      })
      .strict(),
    z
      .object({
        op: z.literal("divide"),
        args: z.tuple([flowFormulaTreeSchema, flowFormulaTreeSchema]),
      })
      .strict(),
    z.object({ op: z.literal("round"), arg: flowFormulaTreeSchema, ...precisionShape }).strict(),
    z.object({ op: z.literal("min"), args: z.array(flowFormulaTreeSchema).min(1).max(20) }).strict(),
    z.object({ op: z.literal("max"), args: z.array(flowFormulaTreeSchema).min(1).max(20) }).strict(),
    z.object({ op: z.literal("coalesce"), args: z.array(flowFormulaTreeSchema).min(1).max(20) }).strict(),
    z.object({ op: z.literal("percent"), args: z.tuple([flowFormulaTreeSchema, flowFormulaTreeSchema]), ...precisionShape }).strict(),
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
    z.object({ op: z.literal("or"), args: z.array(flowFormulaTreeSchema).min(2).max(20) }).strict(),
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

export const flowFormulaChildren = (formula: FlowFormula): readonly FlowFormula[] => {
  switch (formula.op) {
    case "literal":
    case "reference":
    case "now":
      return [];
    case "add":
    case "multiply":
    case "subtract":
    case "divide":
    case "min":
    case "max":
    case "coalesce":
    case "percent":
    case "and":
    case "or":
      return formula.args;
    case "round":
    case "record_id":
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
    case "deadline_passed":
      return [formula.due, ...(formula.status === undefined ? [] : [formula.status])];
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
  const inspected = flowFormulaChildren(formula).map((child) => inspectFormula(child, depth + 1));
  return {
    depth: Math.max(depth, ...inspected.map((child) => child.depth)),
    nodes: 1 + inspected.reduce((total, child) => total + child.nodes, 0),
    usesNow:
      formula.op === "now" ||
      formula.op === "deadline_passed" ||
      inspected.some((child) => child.usesNow),
  };
};

/** True when the formula reads the current time through the `now` operator. */
export const flowFormulaUsesNow = (formula: FlowFormula): boolean =>
  inspectFormula(formula).usesNow;

/** A divide at a numeric escape must be protected by an explicit rounding operation. */
export const flowFormulaHasUnroundedDivide = (formula: FlowFormula): boolean =>
  formula.op !== "round" &&
  (formula.op === "divide" ||
    (formula.op === "if"
      ? [formula.then, formula.else]
      : flowFormulaChildren(formula)
    ).some(flowFormulaHasUnroundedDivide));

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

// ─── Values: literal, closed reference, formula, map or array ────────────────────────────────

/** Closed constructor bounds; map and array nesting share the same five-level budget. */
export const flowMaximumMapEntries = 100;
export const flowMaximumMapDepth = 5;
export const flowMaximumArrayItems = 100;

/**
 * A map of named values. Like an array, it carries other values, so a task property
 * declared as an input map can fill its entries from the flow's own inputs, variables and task
 * outputs instead of only from a fixed literal. A plain JSON object literal is still exactly a
 * literal: a constructed map is resolved entry by entry, and each entry is a flow value of its own.
 */
export type FlowMapValue = Readonly<{
  kind: "map";
  entries: Readonly<Record<string, FlowValue>>;
}>;

/** An ordered JSON array whose members are independently resolved flow values. */
export type FlowArrayValue = Readonly<{
  kind: "array";
  items: readonly FlowValue[];
}>;

export type FlowValueObject =
  | Readonly<{ kind: "literal"; literal: FlowLiteral }>
  | Readonly<{ kind: "reference"; reference: FlowReference }>
  | Readonly<{ kind: "formula"; formula: FlowFormula }>
  | FlowMapValue
  | FlowArrayValue;

/** Every value a task property, flow output or named input map entry may hold. */
export type FlowValue = FlowValueObject;

/** Count every enclosing map or array once, including the root constructor. */
const flowCompositeValuesWithinDepth = (values: readonly FlowValue[], depth: number): boolean =>
  depth <= flowMaximumMapDepth &&
  values.every((entry) =>
    entry.kind === "map"
      ? flowCompositeValuesWithinDepth(Object.values(entry.entries), depth + 1)
      : entry.kind !== "array" || flowCompositeValuesWithinDepth(entry.items, depth + 1),
  );

/**
 * The entries of one map value: at most `flowMaximumMapEntries` named entries, and nesting no
 * deeper than `flowMaximumMapDepth` combined maps and arrays. Both bounds are checked on parsed
 * entries, so alternating constructors cannot evade the nesting limit.
 */
const flowMapEntriesSchema = (): z.ZodType<Record<string, FlowValue>> =>
  z
    .record(builderKeySchema, flowValueSchema)
    .refine((entries) => Object.keys(entries).length <= flowMaximumMapEntries, {
      message: `A map value holds at most ${flowMaximumMapEntries} entries`,
    })
    .refine((entries) => flowCompositeValuesWithinDepth(Object.values(entries), 1), {
      message: `A constructed value nests no deeper than ${flowMaximumMapDepth} maps and arrays`,
    });

const flowArrayItemsSchema = (): z.ZodType<FlowValue[]> =>
  z
    .array(flowValueSchema)
    .max(flowMaximumArrayItems)
    .refine((items) => flowCompositeValuesWithinDepth(items, 1), {
      message: `A constructed value nests no deeper than ${flowMaximumMapDepth} maps and arrays`,
    });

export const flowLiteralValueSchema = z
  .object({ kind: z.literal("literal"), literal: flowLiteralSchema })
  .strict();
export const flowReferenceValueSchema = z
  .object({ kind: z.literal("reference"), reference: flowReferenceSchema })
  .strict();
export const flowFormulaValueSchema = z
  .object({ kind: z.literal("formula"), formula: flowFormulaSchema })
  .strict();

const flowMapValueSchema = z
  .object({
    kind: z.literal("map"),
    // Built through a function so the recursive entry schema is created only when it is used.
    entries: z.lazy(flowMapEntriesSchema),
  })
  .strict();

const flowArrayValueSchema = z
  .object({ kind: z.literal("array"), items: z.lazy(flowArrayItemsSchema) })
  .strict();

export const flowValueObjectSchema = z.discriminatedUnion("kind", [
  flowLiteralValueSchema,
  flowReferenceValueSchema,
  flowFormulaValueSchema,
  flowMapValueSchema,
  flowArrayValueSchema,
]);

export const shorthandReferenceValueSchema = z.string().transform((text, context) => {
  const reference = parseFlowReference(text);
  if (reference === undefined) {
    context.addIssue({
      code: "custom",
      message:
        'A bare text value must be exactly one closed reference; write a literal as { kind: "literal", literal: { type, value } }',
    });
    return z.NEVER;
  }
  return { kind: "reference" as const, reference };
});

/**
 * A value in a task property or input map. A bare string is only accepted as one whole closed
 * reference, so an untyped or malformed reference is refused rather than kept as text. Its five
 * object kinds are exactly `FlowValue`; map entries and array items recurse through this schema.
 */
export const flowValueSchema = z.union([shorthandReferenceValueSchema, flowValueObjectSchema]);
