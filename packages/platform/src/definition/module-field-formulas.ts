import {
  calculationMaximumNestingDepth,
  calculationMaximumOperandCount,
  calculationResultTypesByOperation,
} from "../catalogue/common";
import { exactDecimalTextSchema } from "../records/module-field-values";
import type { ApplicationSourceDocument } from "./application-source-contracts";
import { queryTotalAccepts, queryTotalOperationLabels } from "./module-query-edit";
import {
  exactIntegerLiteral,
  numericOperationDimension,
  typedFieldValueType,
  type NumericDimension,
} from "./validation/field-types";

/**
 * Calculations and totals as the Data tab edits them: which result a formula can produce, why a
 * formula or total can't be applied (in the words of the formula editor), and how it reads. A
 * total of related records takes the same operations, and of the same field types, as a query's
 * totals: there is one aggregation model.
 */

type InlineModule = ApplicationSourceDocument["body"]["modules"][number];
type RecordType = InlineModule["record_types"][number];
type SourceField = RecordType["fields"][number];
export type CalculationSettings = Extract<SourceField, { type: "calculation" }>["settings"];
export type CalculationExpression = CalculationSettings["expression"];
export type CalculationOperation = CalculationExpression["operation"];
export type CalculationNumber = Extract<CalculationExpression, { operation: "numeric" }>["operands"][number];
export type CalculationNumberOperation = Extract<CalculationExpression, { operation: "numeric" }>["numeric_operation"];
export type CalculationResultType = CalculationSettings["result_type"];
export type TotalSettings = Extract<SourceField, { type: "total" }>["settings"];
export type TotalOperation = TotalSettings["operation"];

/** A field a formula or total may name, in its authored form. */
export type FormulaField = Readonly<{ key: string; label: string; type: string; settings: unknown }>;


export const calculationOperationLabels = {
  join_text: "Join text", numeric: "Work out a number", condition: "Yes or no, from a condition",
  date_offset: "Move a date", deadline_passed: "Whether a deadline has passed",
} as const satisfies Record<CalculationOperation, string>;
export const calculationNumberOperationLabels = {
  add: "Add", subtract: "Subtract", multiply: "Multiply", divide: "Divide",
} as const satisfies Record<CalculationNumberOperation, string>;
const operationSigns: Readonly<Record<CalculationNumberOperation, string>> = { add: "+", subtract: "−", multiply: "×", divide: "÷" };
export const calculationResultTypeLabels = {
  text: "Text", whole_number: "Whole number", decimal_number: "Decimal number", money: "Money", yes_no: "Yes or no",
  date: "Date", date_time: "Date and time",
} as const satisfies Record<CalculationResultType, string>;
/** A total's operations, named as a query's totals name them. */
export const totalOperationLabels: Readonly<Record<TotalOperation, string>> = queryTotalOperationLabels;

/** The value type a field holds, with a calculation or total read as its result. */
const valueType = (field: FormulaField | undefined): string | undefined =>
  field === undefined ? undefined : typedFieldValueType({ type: field.type, settings: field.settings as never });

/** Fields a joined text can take: text and choice values, including text calculations. */
export const joinTextAccepts = (field: FormulaField): boolean => ["text", "choice"].includes(valueType(field) ?? "");
/** Fields a number in a formula can be: whole and decimal numbers and money, including numeric results. */
export const numberAccepts = (field: FormulaField): boolean => ["whole_number", "decimal_number", "money"].includes(valueType(field) ?? "");
export const dateAccepts = (field: FormulaField): boolean => ["date", "date_time"].includes(valueType(field) ?? "");
export const wholeNumberAccepts = (field: FormulaField): boolean => valueType(field) === "whole_number";

/** Whether a number of a formula is money or a plain number, through any nesting; undefined when it can't be worked out. */
export const calculationNumberDimension = (value: CalculationNumber, fields: ReadonlyMap<string, FormulaField>, depth = 1): NumericDimension | undefined => {
  if (depth > calculationMaximumNestingDepth) return undefined;
  if (value.source === "literal") return exactDecimalTextSchema.safeParse(value.value).success ? "dimensionless" : undefined;
  if (value.source === "field") {
    const type = valueType(fields.get(value.field));
    return type === "money" ? "money" : type === "whole_number" || type === "decimal_number" ? "dimensionless" : undefined;
  }
  if (value.operands.length < 2) return undefined;
  return numericOperationDimension(value.numeric_operation, value.operands.map((operand) => calculationNumberDimension(operand, fields, depth + 1)));
};

/** The results a formula can produce, given the fields it names; empty while the formula can't be worked out. */
export const calculationResultChoices = (expression: CalculationExpression, fields: ReadonlyMap<string, FormulaField>): readonly CalculationResultType[] => {
  switch (expression.operation) {
    case "numeric": {
      const dimension = calculationNumberDimension({ source: "numeric", numeric_operation: expression.numeric_operation, operands: expression.operands }, fields);
      return dimension === undefined ? [] : dimension === "money" ? ["money"] : ["whole_number", "decimal_number"];
    }
    case "date_offset": {
      const type = valueType(fields.get(expression.date_field));
      return type === "date" || type === "date_time" ? [type] : [];
    }
    default:
      return calculationResultTypesByOperation[expression.operation];
  }
};

const valuesIn = (value: CalculationNumber): number =>
  value.source === "numeric" ? 1 + value.operands.reduce((sum, operand) => sum + valuesIn(operand), 0) : 1;
const depthOf = (value: CalculationNumber, depth = 1): number =>
  value.source === "numeric" ? Math.max(depth, ...value.operands.map((operand) => depthOf(operand, depth + 1))) : depth;

const dimensionProblem = (operation: CalculationNumberOperation, dimensions: readonly (NumericDimension | undefined)[]): string | undefined => {
  if (dimensions.some((dimension) => dimension === undefined)) return undefined;
  if (numericOperationDimension(operation, dimensions) !== undefined) return undefined;
  switch (operation) {
    case "add": case "subtract": return "money can only be added to or taken from money, not a plain number";
    case "multiply": return "money can only be multiplied by plain numbers, not by money";
    case "divide": return "only the first value can be money, and money can't be divided by money";
  }
};

/**
 * Why a calculation's settings can't be applied, in the words of the formula editor. `fields` are
 * the other fields of its record type, by key. The schema and the publication checks judge the rest.
 */
export const calculationProblems = (settings: CalculationSettings, fields: ReadonlyMap<string, FormulaField>): string[] => {
  const problems: string[] = [];
  const known = (where: string, key: string): FormulaField | undefined => {
    const field = fields.get(key);
    if (field === undefined) problems.push(`${where}: "${key}" is not another field of this record type.`);
    return field;
  };
  const expression = settings.expression;
  switch (expression.operation) {
    case "join_text":
      if (expression.fields.length === 0) problems.push("Joined fields: choose at least one field.");
      for (const key of expression.fields) {
        const field = known("Joined fields", key);
        if (field !== undefined && !joinTextAccepts(field)) problems.push(`Joined fields: ${field.label} is not text or a choice, so it can't be joined.`);
      }
      break;
    case "numeric": {
      const visit = (value: CalculationNumber, where: string): void => {
        if (value.source === "literal") {
          if (!exactDecimalTextSchema.safeParse(value.value).success) problems.push(`${where}: enter an exact number, for example 100 or 0.15.`);
        } else if (value.source === "field") {
          const field = known(where, value.field);
          if (field !== undefined && !numberAccepts(field)) problems.push(`${where}: ${field.label} is not a number or money.`);
        } else {
          if (value.operands.length < 2) problems.push(`${where}: a part needs at least two values.`);
          value.operands.forEach((operand, index) => visit(operand, `${where}, value ${index + 1}`));
          const problem = dimensionProblem(value.numeric_operation, value.operands.map((operand) => calculationNumberDimension(operand, fields)));
          if (problem !== undefined) problems.push(`${where}: ${problem}.`);
        }
      };
      const root: CalculationNumber = { source: "numeric", numeric_operation: expression.numeric_operation, operands: expression.operands };
      visit(root, "Formula");
      if (depthOf(root) > calculationMaximumNestingDepth) problems.push(`Formula: parts can be nested at most ${calculationMaximumNestingDepth} deep.`);
      if (valuesIn(root) - 1 > calculationMaximumOperandCount) problems.push(`Formula: it can hold at most ${calculationMaximumOperandCount} values and parts.`);
      break;
    }
    case "condition":
      if ((expression as { condition?: unknown }).condition === undefined) problems.push("Condition: add at least one comparison.");
      break;
    case "date_offset": {
      const field = known("Date", expression.date_field);
      if (field !== undefined && !dateAccepts(field)) problems.push(`Date: ${field.label} is not a date.`);
      if (expression.amount.source === "literal") {
        if (!exactIntegerLiteral(expression.amount.value)) problems.push("By how much: enter a whole number, for example 30 or -7.");
      } else {
        const amount = known("By how much", expression.amount.field);
        if (amount !== undefined && !wholeNumberAccepts(amount)) problems.push(`By how much: ${amount.label} is not a whole number.`);
      }
      break;
    }
    case "deadline_passed": {
      const due = known("Due", expression.due_field);
      if (due !== undefined && !dateAccepts(due)) problems.push(`Due: ${due.label} is not a date.`);
      if (expression.status_field === undefined) {
        if (expression.terminal_status_values.length > 0) problems.push("Finished statuses: choose the status field they belong to.");
      } else {
        const status = known("Status", expression.status_field);
        if (status !== undefined && !joinTextAccepts(status)) problems.push(`Status: ${status.label} is not text or a choice.`);
      }
      break;
    }
  }
  if (problems.length === 0) {
    const choices = calculationResultChoices(expression, fields);
    if (!choices.includes(settings.result_type))
      problems.push(choices.length === 0 ? "Result: the formula can't be worked out yet."
        : `Result: this formula gives ${choices.map((type) => calculationResultTypeLabels[type].toLowerCase()).join(" or ")}.`);
  }
  const precise = settings.result_type === "decimal_number" || settings.result_type === "money";
  if (precise && settings.decimal_places === undefined) problems.push("Decimal places: enter how many decimal places the result keeps.");
  if (settings.evaluation === "stored" && expression.operation === "deadline_passed")
    problems.push("When it is worked out: a deadline depends on the current time, so it is worked out each time it is read.");
  return problems;
};

/** A formula's number as a person reads it, for example "Value × (1 − Discount ÷ 100)". */
export const describeCalculationNumber = (value: CalculationNumber, labelOf: (key: string) => string, nested = false): string => {
  if (value.source === "literal") return value.value;
  if (value.source === "field") return labelOf(value.field);
  const text = value.operands.map((operand) => describeCalculationNumber(operand, labelOf, true)).join(` ${operationSigns[value.numeric_operation]} `);
  return nested ? `(${text})` : text;
};

/** A calculation as one line a person reads, for the field editor and the Data tab. */
export const describeCalculation = (expression: CalculationExpression, labelOf: (key: string) => string): string => {
  switch (expression.operation) {
    case "join_text":
      return expression.fields.map(labelOf).join(expression.separator === "" ? " + " : ` + "${expression.separator}" + `);
    case "numeric":
      return describeCalculationNumber({ source: "numeric", numeric_operation: expression.numeric_operation, operands: expression.operands }, labelOf);
    case "condition":
      return "Yes when its condition holds, otherwise no";
    case "date_offset": {
      const amount = expression.amount.source === "literal" ? expression.amount.value : labelOf(expression.amount.field);
      return `${labelOf(expression.date_field)} + ${amount} ${expression.unit}`;
    }
    case "deadline_passed": {
      const finished = expression.status_field === undefined || expression.terminal_status_values.length === 0 ? ""
        : `, unless ${labelOf(expression.status_field)} is ${expression.terminal_status_values.map(String).join(" or ")}`;
      return `Yes once ${labelOf(expression.due_field)} has passed${finished}`;
    }
  }
};

/** The formula a calculation starts with when its operation is chosen, from the record type's own fields. */
export const starterCalculationExpression = (operation: CalculationOperation, fields: readonly FormulaField[]): CalculationExpression => {
  const first = (accepts: (field: FormulaField) => boolean) => fields.find(accepts)?.key;
  switch (operation) {
    case "join_text": {
      const key = first(joinTextAccepts);
      return { operation, fields: key === undefined ? [] : [key], separator: " " };
    }
    case "numeric": {
      const key = first(numberAccepts);
      return { operation, numeric_operation: "multiply",
        operands: [key === undefined ? { source: "literal", value: "1" } : { source: "field", field: key }, { source: "literal", value: "1" }] };
    }
    case "condition":
      // No condition yet: the editor builds it, and calculationProblems refuses the formula until then.
      return { operation } as CalculationExpression;
    case "date_offset":
      return { operation, date_field: first(dateAccepts) ?? "", amount: { source: "literal", value: "7" }, unit: "days" };
    case "deadline_passed":
      return { operation, due_field: first(dateAccepts) ?? "", terminal_status_values: [] };
  }
};

/** The fields of related records a total's operation can be taken of: the same rule as a query's totals. */
export const totalAccepts = (operation: TotalOperation, field: FormulaField): boolean =>
  queryTotalAccepts(operation, field.type);

/** The result a total produces from its operation and field: one rule, so the editor never asks for it. */
export const totalResultType = (operation: TotalOperation, field: FormulaField | undefined): CalculationResultType | undefined => {
  if (operation === "count") return "whole_number";
  if (field === undefined) return undefined;
  if (operation === "average") return field.type === "money" ? "money" : "decimal_number";
  return field.type as CalculationResultType;
};

/** A relationship a total of this record type can count or add up: a link from another record type to it. */
export type TotalRelationship = Readonly<{ reference: string; label: string; recordName: string; fields: readonly FormulaField[] }>;

/** The links of the application's own record types that point at one record type, as totals name them. */
export const totalRelationships = (source: ApplicationSourceDocument, moduleKey: string, recordKey: string): readonly TotalRelationship[] => {
  const target = `${moduleKey}:${recordKey}`;
  const reaches = (owner: string, reference: string | undefined) =>
    reference !== undefined && (reference === target || (owner === moduleKey && reference === recordKey));
  return source.body.modules.flatMap((module) => module.record_types.flatMap((record) => record.relationships
    .filter((relationship) => reaches(module.key, relationship.to_record_type) ||
      (relationship.to_record_types ?? []).some((reference) => reaches(module.key, reference)))
    .map((relationship) => {
      const from = record.fields.find((field) => field.key === relationship.from_field);
      return { reference: `${module.key}:${record.key}.${relationship.key}`, label: `${record.plural_name} by ${from?.label ?? relationship.key}`,
        recordName: record.plural_name, fields: record.fields.map(({ key, label, type, settings }) => ({ key, label, type, settings })) };
    })));
};

/** Why a total's settings can't be applied, in the words of the total editor. */
export const totalProblems = (settings: TotalSettings, relationship: TotalRelationship | undefined): string[] => {
  if (relationship === undefined) return ["Related records: choose the link whose records are totalled."];
  const problems: string[] = [];
  const field = settings.field === undefined ? undefined : relationship.fields.find((item) => item.key === settings.field);
  if (settings.operation === "count") {
    if (settings.field !== undefined) problems.push("Field: a number of records counts records, not a field.");
  } else if (settings.field === undefined) problems.push(`Field: choose the field of ${relationship.recordName} to take the ${totalOperationLabels[settings.operation].toLowerCase()} of.`);
  else if (field === undefined) problems.push(`Field: ${settings.field} is not a field of ${relationship.recordName} any more.`);
  else if (!totalAccepts(settings.operation, field))
    problems.push(`Field: the ${totalOperationLabels[settings.operation].toLowerCase()} can't be taken of ${field.label}.`);
  if (settings.currency !== undefined && (settings.operation !== "sum" || field?.type !== "money"))
    problems.push("Currency: only a sum of money has a currency.");
  if (settings.operation === "average" && settings.decimal_places === undefined)
    problems.push("Decimal places: enter how many decimal places the average keeps.");
  return problems;
};

/** A total as one line a person reads, for example "Number of Record tags" or "Sum of Amount of Line items". */
export const describeTotal = (settings: TotalSettings, relationship: TotalRelationship | undefined): string => {
  const records = relationship?.recordName ?? settings.relationship;
  const field = settings.field === undefined ? undefined : relationship?.fields.find((item) => item.key === settings.field)?.label ?? settings.field;
  const what = settings.operation === "count" ? `${totalOperationLabels.count} of ${records}`
    : `${totalOperationLabels[settings.operation]} of ${field ?? "a field"} of ${records}`;
  return settings.filter === undefined ? what : `${what}, of those that match its filter`;
};
