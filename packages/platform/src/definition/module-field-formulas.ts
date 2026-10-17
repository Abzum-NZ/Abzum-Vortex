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
export type FormulaField = Readonly<{ key: string; label: string; type: string; settings: unknown; filterable?: boolean }>;


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

/** The value type a field holds, with a calculation or total read as its result. */
const valueType = (field: FormulaField | undefined): string | undefined =>
  field === undefined ? undefined : typedFieldValueType({ type: field.type, settings: field.settings as never });

/** Fields a joined text can take: text and choice values, including text calculations. */
export const joinTextAccepts = (field: FormulaField): boolean => ["text", "choice"].includes(valueType(field) ?? "");
/** Fields a number in a formula can be: whole and decimal numbers and money, including numeric results. */
export const numberAccepts = (field: FormulaField): boolean => ["whole_number", "decimal_number", "money"].includes(valueType(field) ?? "");
export const dateAccepts = (field: FormulaField): boolean => ["date", "date_time"].includes(valueType(field) ?? "");
export const wholeNumberAccepts = (field: FormulaField): boolean => valueType(field) === "whole_number";

/** The keys of the fields an authored condition compares, in its compact or its operand form. */
export const conditionFieldKeys = (condition: unknown): string[] => {
  if (condition === null || typeof condition !== "object") return [];
  const node = condition as Record<string, unknown>;
  if (Array.isArray(node.all)) return node.all.flatMap(conditionFieldKeys);
  if (Array.isArray(node.any)) return node.any.flatMap(conditionFieldKeys);
  if (node.not !== undefined) return conditionFieldKeys(node.not);
  const operand = (value: unknown): string[] => {
    const entry = value as { source?: unknown; field?: unknown } | undefined;
    return entry?.source === "field" && typeof entry.field === "string" ? [entry.field] : [];
  };
  if ("left" in node) return [...operand(node.left), ...operand(node.right)];
  return typeof node.field === "string" ? [node.field] : [];
};

/** The other fields of its record type a calculation's formula reads, by key. */
export const calculationDependencies = (expression: CalculationExpression): string[] => {
  const numbers = (value: CalculationNumber): string[] =>
    value.source === "field" ? [value.field] : value.source === "numeric" ? value.operands.flatMap(numbers) : [];
  switch (expression.operation) {
    case "join_text": return [...expression.fields];
    case "numeric": return expression.operands.flatMap(numbers);
    case "condition": return conditionFieldKeys((expression as { condition?: unknown }).condition);
    case "date_offset": return [expression.date_field, ...(expression.amount.source === "field" ? [expression.amount.field] : [])];
    case "deadline_passed": return [expression.due_field, ...(expression.status_field === undefined ? [] : [expression.status_field])];
  }
};

const calculationOf = (field: FormulaField | undefined): CalculationSettings | undefined =>
  field?.type === "calculation" ? field.settings as CalculationSettings : undefined;

/**
 * The calculations among the fields that are worked out each time a record is read: a deadline,
 * one declared so, and one that reads such a calculation, as publication classifies them. A stored
 * value never depends on one.
 */
export const readTimeCalculations = (fields: ReadonlyMap<string, FormulaField>): ReadonlySet<string> => {
  const known = new Map<string, boolean>();
  const readTime = (key: string, visiting: ReadonlySet<string>): boolean => {
    const cached = known.get(key);
    if (cached !== undefined) return cached;
    const settings = calculationOf(fields.get(key));
    if (settings === undefined || visiting.has(key)) return false;
    const next = new Set(visiting).add(key);
    const result = settings.expression.operation === "deadline_passed" || settings.evaluation === "read_time"
      || calculationDependencies(settings.expression).some((dependency) => readTime(dependency, next));
    known.set(key, result);
    return result;
  };
  return new Set([...fields.keys()].filter((key) => readTime(key, new Set())));
};

/** The fields a formula reads that are worked out each time they're read, which makes it read-time too. */
const readTimeDependencies = (expression: CalculationExpression, fields: ReadonlyMap<string, FormulaField>): FormulaField[] => {
  const readTime = readTimeCalculations(fields);
  return [...new Set(calculationDependencies(expression))].filter((key) => readTime.has(key)).map((key) => fields.get(key)!);
};

/** Whether a calculation is worked out each time it is read whatever is chosen: a deadline, or a formula that reads such a field. */
export const calculationForcedReadTime = (expression: CalculationExpression, fields: ReadonlyMap<string, FormulaField>): boolean =>
  expression.operation === "deadline_passed" || readTimeDependencies(expression, fields).length > 0;

/**
 * A calculation's settings with its result kept to what its formula can give: the result type is
 * offered only among those, decimal places are kept exactly when the result needs them, and when
 * it is worked out is always written down: each time it is read when it must be, otherwise the
 * choice made, when the record is saved by default.
 */
export const settledCalculation = (settings: CalculationSettings, fields: ReadonlyMap<string, FormulaField>): CalculationSettings => {
  const choices = calculationResultChoices(settings.expression, fields);
  const result_type = choices.length === 0 || choices.includes(settings.result_type) ? settings.result_type : choices[0]!;
  const precise = result_type === "decimal_number" || result_type === "money";
  const { decimal_places: places, evaluation, ...rest } = settings;
  return {
    ...rest, result_type,
    evaluation: calculationForcedReadTime(settings.expression, fields) ? "read_time" : evaluation ?? "stored",
    ...(precise ? { decimal_places: places ?? 2 } : {}),
  } as CalculationSettings;
};

/**
 * Decimal places as typed: undefined when empty or not a number. A fraction or a number outside
 * 0 to 12 is kept as typed, so the editor refuses it rather than storing another value.
 */
export const typedDecimalPlaces = (text: string): number | undefined => {
  const places = text.trim() === "" ? Number.NaN : Number(text);
  return Number.isFinite(places) ? places : undefined;
};

/** Whether decimal places are a whole number from 0 to 12, as the contract keeps them. */
const decimalPlacesValid = (places: number | undefined): boolean =>
  places === undefined || (Number.isInteger(places) && places >= 0 && places <= 12);

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
 * the other fields of its record type, by key; `ownKey` is the calculation's own key, absent for a
 * new field, which nothing reads yet. The schema and the publication checks judge the rest.
 */
export const calculationProblems = (settings: CalculationSettings, fields: ReadonlyMap<string, FormulaField>,
  ownKey: string | undefined): string[] => {
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
  if (ownKey !== undefined) {
    // A formula that reads the field itself through other calculations never settles: refuse the circle.
    const circle = (key: string, path: readonly string[]): readonly string[] | undefined => {
      if (key === ownKey) return path;
      if (path.includes(key)) return undefined;
      const read = calculationOf(fields.get(key));
      if (read === undefined) return undefined;
      for (const dependency of new Set(calculationDependencies(read.expression))) {
        const found = circle(dependency, [...path, key]);
        if (found !== undefined) return found;
      }
      return undefined;
    };
    for (const dependency of new Set(calculationDependencies(expression))) {
      const found = circle(dependency, []);
      if (found === undefined || found.length === 0) continue;
      const chain = found.map((key) => fields.get(key)?.label ?? key).join(", which reads ");
      problems.push(`Formula: ${chain}${found.length > 1 ? "," : ""} reads this field, so they would work each other out in a circle.`);
      break;
    }
  }
  const precise = settings.result_type === "decimal_number" || settings.result_type === "money";
  if (precise && settings.decimal_places === undefined) problems.push("Decimal places: enter how many decimal places the result keeps.");
  if (!decimalPlacesValid(settings.decimal_places)) problems.push("Decimal places: enter a whole number from 0 to 12.");
  if (settings.evaluation === "stored" && expression.operation === "deadline_passed")
    problems.push("When it is worked out: a deadline depends on the current time, so it is worked out each time it is read.");
  else if (settings.evaluation === "stored") {
    const readTime = readTimeDependencies(expression, fields);
    if (readTime.length > 0)
      problems.push(`When it is worked out: it reads ${readTime.map((field) => field.label).join(" and ")}, worked out each time ${readTime.length === 1 ? "it is" : "they are"} read, so it is too.`);
  }
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

/** The type of value a total takes of a field: a calculation's or a total's result, otherwise the field's own type. */
const totalledType = (field: FormulaField): string =>
  field.type === "calculation" || field.type === "total" ? String((field.settings as { result_type?: unknown }).result_type) : field.type;

/** The result a total produces from its operation and field: one rule, so the editor never asks for it. */
export const totalResultType = (operation: TotalOperation, field: FormulaField | undefined): CalculationResultType | undefined => {
  if (operation === "count") return "whole_number";
  if (field === undefined) return undefined;
  if (operation === "average") return totalledType(field) === "money" ? "money" : "decimal_number";
  return totalledType(field) as CalculationResultType;
};

/**
 * A relationship a total of this record type can count or add up: a link to it from a record type
 * of its own module, with that record type's fields and those of them worked out each time they're
 * read, which a total can't take.
 */
export type TotalRelationship = Readonly<{
  reference: string; label: string; recordName: string; fields: readonly FormulaField[]; readTime: ReadonlySet<string>;
}>;

/** Whether a total's operation can be taken of a field of its related records: the query totals' rule, on the value it holds. */
export const totalFieldAccepts = (operation: TotalOperation, field: FormulaField, relationship: TotalRelationship): boolean =>
  operation !== "count" && !relationship.readTime.has(field.key) && queryTotalAccepts(operation, totalledType(field));

/** The fields of the related records a total's filter may compare: those people can filter by, and not worked out when read. */
export const totalFilterKeys = (relationship: TotalRelationship): ReadonlySet<string> =>
  new Set(relationship.fields.filter((field) => field.filterable === true && !relationship.readTime.has(field.key)).map((field) => field.key));

/**
 * The links of the module's own record types that point at one record type, as totals name them.
 * A link from another module's record type is never offered: that module already depends on this
 * one through the link, so a total over it would make the two modules depend on each other.
 */
export const totalRelationships = (source: ApplicationSourceDocument, moduleKey: string, recordKey: string): readonly TotalRelationship[] => {
  const reaches = (reference: string | undefined) => reference === recordKey || reference === `${moduleKey}:${recordKey}`;
  const module = source.body.modules.find((item) => item.key === moduleKey);
  return (module?.record_types ?? []).flatMap((record) => record.relationships
    .filter((relationship) => reaches(relationship.to_record_type) || (relationship.to_record_types ?? []).some(reaches))
    .map((relationship) => {
      const from = record.fields.find((field) => field.key === relationship.from_field);
      const fields = record.fields.map(({ key, label, type, settings, filterable }) => ({ key, label, type, settings, filterable }));
      return { reference: `${moduleKey}:${record.key}.${relationship.key}`, label: `${record.plural_name} by ${from?.label ?? relationship.key}`,
        recordName: record.plural_name, fields, readTime: readTimeCalculations(new Map(fields.map((field) => [field.key, field]))) };
    }));
};

/** Why a total's settings can't be applied, in the words of the total editor. */
export const totalProblems = (settings: TotalSettings, relationship: TotalRelationship | undefined): string[] => {
  if (relationship === undefined)
    return [(settings.relationship as string | undefined) === undefined ? "Related records: choose the link whose records are totalled."
      : `Related records: ${settings.relationship} is not a link to this record type from its own module.`];
  const problems: string[] = [];
  const field = settings.field === undefined ? undefined : relationship.fields.find((item) => item.key === settings.field);
  if (settings.operation === "count") {
    if (settings.field !== undefined) problems.push("Field: a number of records counts records, not a field.");
  } else if (settings.field === undefined) problems.push(`Field: choose the field of ${relationship.recordName} to take the ${queryTotalOperationLabels[settings.operation].toLowerCase()} of.`);
  else if (field === undefined) problems.push(`Field: ${settings.field} is not a field of ${relationship.recordName} any more.`);
  else if (relationship.readTime.has(field.key))
    problems.push(`Field: ${field.label} is worked out each time it is read, so a total can't take it.`);
  else if (!totalFieldAccepts(settings.operation, field, relationship))
    problems.push(`Field: the ${queryTotalOperationLabels[settings.operation].toLowerCase()} can't be taken of ${field.label}.`);
  if (settings.currency !== undefined && (settings.operation !== "sum" || field === undefined || totalledType(field) !== "money"))
    problems.push("Currency: only a sum of money has a currency.");
  if (settings.operation === "average" && settings.decimal_places === undefined)
    problems.push("Decimal places: enter how many decimal places the average keeps.");
  if (!decimalPlacesValid(settings.decimal_places)) problems.push("Decimal places: enter a whole number from 0 to 12.");
  const filterable = totalFilterKeys(relationship);
  for (const key of new Set(conditionFieldKeys(settings.filter))) {
    if (filterable.has(key)) continue;
    const label = relationship.fields.find((item) => item.key === key)?.label ?? key;
    problems.push(relationship.readTime.has(key) ? `Filter: ${label} is worked out each time it is read, so a total can't filter by it.`
      : `Filter: people can't filter by ${label}. Tick "People can filter by it" on that field first.`);
  }
  return problems;
};

/** A total as one line a person reads, for example "Number of Record tags" or "Sum of Amount of Line items". */
export const describeTotal = (settings: TotalSettings, relationship: TotalRelationship | undefined): string => {
  const records = relationship?.recordName ?? (settings.relationship as string | undefined) ?? "the related records";
  const field = settings.field === undefined ? undefined : relationship?.fields.find((item) => item.key === settings.field)?.label ?? settings.field;
  const what = settings.operation === "count" ? `${queryTotalOperationLabels.count} of ${records}`
    : `${queryTotalOperationLabels[settings.operation]} of ${field ?? "a field"} of ${records}`;
  return settings.filter === undefined ? what : `${what}, of those that match its filter`;
};
