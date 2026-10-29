import { flowFormulaSchema, flowFormulaUsesNow } from "../workflows/flow-values";
import {
  calculationFormulaDependencies,
  checkCalculationFormula,
  calculationReadTimeSupported,
} from "./module-calculation-formula";
import type { ApplicationSourceDocument } from "./application-source-contracts";
import { queryTotalAccepts, queryTotalOperationLabels } from "./module-query-totals";
import { typedFieldValueType } from "./validation/field-types";

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
export type CalculationResultType = CalculationSettings["result_type"];
export type TotalSettings = Extract<SourceField, { type: "total" }>["settings"];
export type TotalOperation = TotalSettings["operation"];

/** A field a formula or total may name, in its authored form. */
export type FormulaField = Readonly<{
  key: string;
  label: string;
  type: string;
  settings: unknown;
  filterable?: boolean;
}>;

export const calculationResultTypeLabels = {
  text: "Text",
  whole_number: "Whole number",
  decimal_number: "Decimal number",
  money: "Money",
  yes_no: "Yes or no",
  date: "Date",
  date_time: "Date and time",
} as const satisfies Record<CalculationResultType, string>;

/** The value type a field holds, with a calculation or total read as its result. */
const valueType = (field: FormulaField | undefined): string | undefined =>
  field === undefined
    ? undefined
    : typedFieldValueType({ type: field.type, settings: field.settings as never });

/** Fields a joined text can take: text and choice values, including text calculations. */
export const joinTextAccepts = (field: FormulaField): boolean =>
  ["text", "choice"].includes(valueType(field) ?? "");
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
export const calculationDependencies = calculationFormulaDependencies;

const calculationOf = (field: FormulaField | undefined): CalculationSettings | undefined =>
  field?.type === "calculation" ? (field.settings as CalculationSettings) : undefined;

/**
 * The calculations among the fields that are worked out each time a record is read: a deadline,
 * one declared so, and one that reads such a calculation, as publication classifies them. A stored
 * value never depends on one.
 */
export const readTimeCalculations = (
  fields: ReadonlyMap<string, FormulaField>,
): ReadonlySet<string> => {
  const known = new Map<string, boolean>();
  const readTime = (key: string, visiting: ReadonlySet<string>): boolean => {
    const cached = known.get(key);
    if (cached !== undefined) return cached;
    const settings = calculationOf(fields.get(key));
    if (settings === undefined || visiting.has(key)) return false;
    const next = new Set(visiting).add(key);
    const result =
      flowFormulaUsesNow(settings.expression) ||
      settings.evaluation === "read_time" ||
      calculationDependencies(settings.expression).some((dependency) => readTime(dependency, next));
    known.set(key, result);
    return result;
  };
  return new Set([...fields.keys()].filter((key) => readTime(key, new Set())));
};

/** The fields a formula reads that are worked out each time they're read, which makes it read-time too. */
const readTimeDependencies = (
  expression: CalculationExpression,
  fields: ReadonlyMap<string, FormulaField>,
): FormulaField[] => {
  const readTime = readTimeCalculations(fields);
  return [...new Set(calculationDependencies(expression))]
    .filter((key) => readTime.has(key))
    .map((key) => fields.get(key)!);
};

/** Whether a calculation is worked out each time it is read whatever is chosen: a deadline, or a formula that reads such a field. */
export const calculationForcedReadTime = (
  expression: CalculationExpression,
  fields: ReadonlyMap<string, FormulaField>,
): boolean => flowFormulaUsesNow(expression) || readTimeDependencies(expression, fields).length > 0;

/**
 * A calculation's settings with its result kept to what its formula can give: the result type is
 * offered only among those, decimal places are kept exactly when the result needs them, and when
 * it is worked out is always written down: each time it is read when it must be, otherwise the
 * choice made, when the record is saved by default.
 */
export const settledCalculation = (
  settings: CalculationSettings,
  fields: ReadonlyMap<string, FormulaField>,
): CalculationSettings => {
  const choices = calculationResultChoices(settings.expression, fields);
  const result_type =
    choices.length === 0 || choices.includes(settings.result_type)
      ? settings.result_type
      : choices[0]!;
  const precise = result_type === "decimal_number" || result_type === "money";
  const { decimal_places: places, evaluation, ...rest } = settings;
  return {
    ...rest,
    result_type,
    evaluation: calculationForcedReadTime(settings.expression, fields)
      ? "read_time"
      : (evaluation ?? "stored"),
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

/** Results allowed by the actual formula and its local record references. */
export const calculationResultChoices = (
  expression: CalculationExpression,
  fields: ReadonlyMap<string, FormulaField>,
): readonly CalculationResultType[] => {
  const result = checkCalculationFormula(expression, (key) => valueType(fields.get(key)), "source");
  if (result === "whole_number" || result === "decimal_number")
    return ["whole_number", "decimal_number"];
  return result !== undefined && result in calculationResultTypeLabels
    ? [result as CalculationResultType]
    : [];
};

export const calculationProblems = (
  settings: CalculationSettings,
  fields: ReadonlyMap<string, FormulaField>,
  ownKey: string | undefined,
): string[] => {
  const problems: string[] = [];
  const parsed = flowFormulaSchema.safeParse(settings.expression);
  if (!parsed.success) return parsed.error.issues.map((issue) => `Formula: ${issue.message}.`);
  const choices = calculationResultChoices(parsed.data, fields);
  if (!choices.includes(settings.result_type))
    problems.push("Formula: choose compatible fields and operands for its result type.");
  if (
    (settings.evaluation === "read_time" || calculationForcedReadTime(parsed.data, fields)) &&
    !calculationReadTimeSupported(parsed.data)
  )
    problems.push(
      "Formula: only a deadline over local fields can currently be worked out at read time.",
    );
  const dependencies = calculationDependencies(parsed.data);
  if (dependencies.length === 0)
    problems.push("Formula: read at least one field of this record type.");
  for (const dependency of dependencies)
    if (!fields.has(dependency))
      problems.push(`Formula: choose an existing field instead of ${dependency}.`);
  const reachesOwn = (key: string, visited: ReadonlySet<string>): boolean => {
    if (key === ownKey) return true;
    if (visited.has(key)) return false;
    const calculation = calculationOf(fields.get(key));
    return (
      calculation !== undefined &&
      calculationDependencies(calculation.expression).some((child) =>
        reachesOwn(child, new Set([...visited, key])),
      )
    );
  };
  if (ownKey !== undefined && dependencies.some((key) => reachesOwn(key, new Set())))
    problems.push("Formula: these calculations read each other in a circle.");
  if (
    ["decimal_number", "money"].includes(settings.result_type) &&
    settings.decimal_places === undefined
  )
    problems.push("Decimal places: enter the result precision.");
  if (!decimalPlacesValid(settings.decimal_places))
    problems.push("Decimal places: enter a whole number from 0 to 12.");
  if (settings.evaluation === "stored" && calculationForcedReadTime(parsed.data, fields))
    problems.push(
      "When it is worked out: a formula using the current time or a read-time field must be read-time.",
    );
  return problems;
};

/** The type of value a total takes of a field: a calculation's or a total's result, otherwise the field's own type. */
const totalledType = (field: FormulaField): string =>
  field.type === "calculation" || field.type === "total"
    ? String((field.settings as { result_type?: unknown }).result_type)
    : field.type;

/** The result a total produces from its operation and field: one rule, so the editor never asks for it. */
export const totalResultType = (
  operation: TotalOperation,
  field: FormulaField | undefined,
): CalculationResultType | undefined => {
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
  reference: string;
  label: string;
  recordName: string;
  fields: readonly FormulaField[];
  readTime: ReadonlySet<string>;
}>;

/** Whether a total's operation can be taken of a field of its related records: the query totals' rule, on the value it holds. */
export const totalFieldAccepts = (
  operation: TotalOperation,
  field: FormulaField,
  relationship: TotalRelationship,
): boolean =>
  operation !== "count" &&
  !relationship.readTime.has(field.key) &&
  queryTotalAccepts(operation, totalledType(field));

/** The fields of the related records a total's filter may compare: those people can filter by, and not worked out when read. */
export const totalFilterKeys = (relationship: TotalRelationship): ReadonlySet<string> =>
  new Set(
    relationship.fields
      .filter((field) => field.filterable === true && !relationship.readTime.has(field.key))
      .map((field) => field.key),
  );

/**
 * The links of the module's own record types that point at one record type, as totals name them.
 * A link from another module's record type is never offered: that module already depends on this
 * one through the link, so a total over it would make the two modules depend on each other.
 */
export const totalRelationships = (
  source: ApplicationSourceDocument,
  moduleKey: string,
  recordKey: string,
): readonly TotalRelationship[] => {
  const reaches = (reference: string | undefined) =>
    reference === recordKey || reference === `${moduleKey}:${recordKey}`;
  const module = source.body.modules.find((item) => item.key === moduleKey);
  return (module?.record_types ?? []).flatMap((record) =>
    record.relationships
      .filter(
        (relationship) =>
          reaches(relationship.to_record_type) ||
          (relationship.to_record_types ?? []).some(reaches),
      )
      .map((relationship) => {
        const from = record.fields.find((field) => field.key === relationship.from_field);
        const fields = record.fields.map(({ key, label, type, settings, filterable }) => ({
          key,
          label,
          type,
          settings,
          filterable,
        }));
        return {
          reference: `${moduleKey}:${record.key}.${relationship.key}`,
          label: `${record.plural_name} by ${from?.label ?? relationship.key}`,
          recordName: record.plural_name,
          fields,
          readTime: readTimeCalculations(new Map(fields.map((field) => [field.key, field]))),
        };
      }),
  );
};

/** Why a total's settings can't be applied, in the words of the total editor. */
export const totalProblems = (
  settings: TotalSettings,
  relationship: TotalRelationship | undefined,
): string[] => {
  if (relationship === undefined)
    return [
      (settings.relationship as string | undefined) === undefined
        ? "Related records: choose the link whose records are totalled."
        : `Related records: ${settings.relationship} is not a link to this record type from its own module.`,
    ];
  const problems: string[] = [];
  const field =
    settings.field === undefined
      ? undefined
      : relationship.fields.find((item) => item.key === settings.field);
  if (settings.operation === "count") {
    if (settings.field !== undefined)
      problems.push("Field: a number of records counts records, not a field.");
  } else if (settings.field === undefined)
    problems.push(
      `Field: choose the field of ${relationship.recordName} to take the ${queryTotalOperationLabels[settings.operation].toLowerCase()} of.`,
    );
  else if (field === undefined)
    problems.push(
      `Field: ${settings.field} is not a field of ${relationship.recordName} any more.`,
    );
  else if (relationship.readTime.has(field.key))
    problems.push(
      `Field: ${field.label} is worked out each time it is read, so a total can't take it.`,
    );
  else if (!totalFieldAccepts(settings.operation, field, relationship))
    problems.push(
      `Field: the ${queryTotalOperationLabels[settings.operation].toLowerCase()} can't be taken of ${field.label}.`,
    );
  if (
    settings.currency !== undefined &&
    (settings.operation !== "sum" || field === undefined || totalledType(field) !== "money")
  )
    problems.push("Currency: only a sum of money has a currency.");
  if (settings.operation === "average" && settings.decimal_places === undefined)
    problems.push("Decimal places: enter how many decimal places the average keeps.");
  if (!decimalPlacesValid(settings.decimal_places))
    problems.push("Decimal places: enter a whole number from 0 to 12.");
  const filterable = totalFilterKeys(relationship);
  for (const key of new Set(conditionFieldKeys(settings.filter))) {
    if (filterable.has(key)) continue;
    const label = relationship.fields.find((item) => item.key === key)?.label ?? key;
    problems.push(
      relationship.readTime.has(key)
        ? `Filter: ${label} is worked out each time it is read, so a total can't filter by it.`
        : `Filter: people can't filter by ${label}. Tick "People can filter by it" on that field first.`,
    );
  }
  return problems;
};

/** A total as one line a person reads, for example "Number of Record tags" or "Sum of Amount of Line items". */
export const describeTotal = (
  settings: TotalSettings,
  relationship: TotalRelationship | undefined,
): string => {
  const records =
    relationship?.recordName ??
    (settings.relationship as string | undefined) ??
    "the related records";
  const field =
    settings.field === undefined
      ? undefined
      : (relationship?.fields.find((item) => item.key === settings.field)?.label ?? settings.field);
  const what =
    settings.operation === "count"
      ? `${queryTotalOperationLabels.count} of ${records}`
      : `${queryTotalOperationLabels[settings.operation]} of ${field ?? "a field"} of ${records}`;
  return settings.filter === undefined ? what : `${what}, of those that match its filter`;
};
