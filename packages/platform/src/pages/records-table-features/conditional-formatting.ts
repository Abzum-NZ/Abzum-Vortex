import {
  conditionalFormatRuleFields,
  conditionalFormattingDateParameters,
  type ConditionNode,
  type ConditionalFormatStyle,
  type ConditionalFormatToken,
  type ConditionalFormattingDateParameter,
  type JsonValue,
  type ModuleField,
  type RecordsTableContract,
} from "../../schema";
import {
  evaluateTypedCondition,
  TypedConditionEvaluationError,
  type TypedConditionParameterDeclaration,
} from "../../rules/index";
import type { ProtectedQueryRow } from "../../queries/protected-query-contracts";
import { relativeAnchorDate } from "../query-binding-resolver";

/**
 * How one numeric column is drawn for this read: a data bar of one token, or a three-point colour
 * scale. Its measures (`RecordsTableRowFormat.measures`) are fractions of the page's own range.
 */
export type ConditionalColumnFormatProjection =
  | Readonly<{ kind: "data_bar"; token: ConditionalFormatToken }>
  | Readonly<{
      kind: "colour_scale";
      tokens: readonly [ConditionalFormatToken, ConditionalFormatToken, ConditionalFormatToken];
    }>;

/**
 * The formatting one viewer sees on one read: the styles of the rules that matched a row of the
 * page (keyed by rule identity, the style key the rows carry) and the numeric columns drawn as bars
 * or scales. Nothing else of a rule travels: never its condition, never a value it read.
 */
export type ConditionalFormattingProjection = Readonly<{
  styles: Readonly<Record<string, ConditionalFormatStyle>>;
  columns: Readonly<Record<string, ConditionalColumnFormatProjection>>;
}>;

/**
 * One row's formatting: the style key of the whole row, the style key of each formatted cell (a
 * cell's own rule wins over the row's) and each numeric column's position in the page's range,
 * from 0 to 1.
 */
export type RecordsTableRowFormat = Readonly<{
  row?: string;
  cells?: Readonly<Record<string, string>>;
  measures?: Readonly<Record<string, number>>;
}>;

/** What the server knows to evaluate the rules of one read; supplied only when the feature is on. */
export type ConditionalFormattingContext = Readonly<{
  /** The fields of the record type the bound query reads, as the installed release declares them. */
  recordFields: readonly ModuleField[];
  /** The relative dates in the organisation's time zone; undefined when it could not be read. */
  relativeDates: Readonly<Record<ConditionalFormattingDateParameter, string>> | undefined;
}>;

const lower = (value: string): string => value.toLowerCase();

const dateParameterSet: ReadonlySet<string> = new Set(conditionalFormattingDateParameters);

/** The calendar dates a rule's relative-date parameters name, counted in the time zone at `now`. */
export const conditionalFormattingRelativeDates = (
  now: Date,
  timeZone: string,
): Readonly<Record<ConditionalFormattingDateParameter, string>> => {
  const startOfWeek = relativeAnchorDate(now, timeZone, "start_of_week");
  return {
    today: relativeAnchorDate(now, timeZone, "today").toString(),
    start_of_week: startOfWeek.toString(),
    end_of_week: startOfWeek.add({ days: 6 }).toString(),
    start_of_month: relativeAnchorDate(now, timeZone, "start_of_month").toString(),
    end_of_month: relativeAnchorDate(now, timeZone, "end_of_month").toString(),
  };
};

/** The fields the enabled rules and column formats read that the read does not already request. */
export const conditionalFormattingFieldIds = (
  contract: RecordsTableContract,
): readonly string[] => {
  const feature = contract.features.conditionalFormatting;
  if (!feature.enabled) return [];
  return [
    ...new Set(
      [
        ...feature.rules.filter((rule) => rule.enabled).flatMap(conditionalFormatRuleFields),
        ...feature.columnFormats.map((format) => format.field),
      ].map(lower),
    ),
  ];
};

const parameterKeys = (condition: ConditionNode): readonly string[] => {
  if ("conditions" in condition) return condition.conditions.flatMap(parameterKeys);
  if (condition.kind === "not") return parameterKeys(condition.condition);
  return [condition.left, condition.right].flatMap((operand) =>
    operand?.source === "parameter" ? [operand.key] : [],
  );
};

/** Whether any enabled rule compares a date with a relative date, so the time zone is needed. */
export const conditionalFormattingUsesRelativeDates = (contract: RecordsTableContract): boolean => {
  const feature = contract.features.conditionalFormatting;
  return (
    feature.enabled &&
    feature.rules.some(
      (rule) => rule.enabled && parameterKeys(rule.condition as ConditionNode).length > 0,
    )
  );
};

/** The release's condition tree with field identities spelled as the Query engine keys row values. */
const lowerFields = (condition: ConditionNode): ConditionNode => {
  if ("conditions" in condition)
    return { kind: condition.kind, conditions: condition.conditions.map(lowerFields) };
  if (condition.kind === "not") return { kind: "not", condition: lowerFields(condition.condition) };
  const operand = (value: typeof condition.left): typeof condition.left =>
    value.source === "field"
      ? { source: "field", fieldId: lower(String(value.fieldId)) as typeof value.fieldId }
      : value;
  return {
    ...condition,
    left: operand(condition.left),
    ...(condition.right === undefined ? {} : { right: operand(condition.right) }),
  };
};

/** A number, decimal text or money amount as a plain number for measuring; undefined otherwise. */
const measureOf = (
  value: JsonValue | undefined,
): Readonly<{ n: number; c?: string }> | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? { n: value } : undefined;
  if (typeof value === "string") {
    const n = Number(value);
    return value.trim() !== "" && Number.isFinite(n) ? { n } : undefined;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const amount = value["amount"];
    const currency = value["currency"];
    const n = typeof amount === "string" ? Number(amount) : Number.NaN;
    return Number.isFinite(n) && typeof currency === "string" ? { n, c: currency } : undefined;
  }
  return undefined;
};

const rounded = (fraction: number): number => Math.round(fraction * 1000) / 1000;

/**
 * Evaluates the table's formatting rules for the rows of one page, with the one typed condition
 * evaluator, and measures its numeric columns over the same rows. A rule reads only values the
 * Query engine returned under the viewer's field policy: on a row that withholds any field the rule
 * reads, the rule is skipped, so styling never reveals a value the viewer cannot see. Rules apply
 * in order; per target (the row, each cell) the first matching rule wins, and a matching rule that
 * stops ends the row's rules. Only visible columns are formatted. Returns undefined when nothing on
 * the page is formatted, so an unformatted page carries no formatting at all.
 */
export const evaluateConditionalFormatting = (
  contract: RecordsTableContract,
  visibleFieldIds: readonly string[],
  rows: readonly ProtectedQueryRow[],
  context: ConditionalFormattingContext,
):
  | Readonly<{
      projection: ConditionalFormattingProjection;
      rows: ReadonlyMap<string, RecordsTableRowFormat>;
    }>
  | undefined => {
  const feature = contract.features.conditionalFormatting;
  if (!feature.enabled || rows.length === 0) return undefined;
  const visible = new Set(visibleFieldIds.map(lower));
  const fieldsById = new Map(
    context.recordFields.map((field) => [lower(String(field.fieldId)), field] as const),
  );

  // Each rule is prepared once: its condition over lower-cased identities, the fields it reads as
  // the evaluator declares them, and its relative dates. A rule that names a field the release
  // does not declare, or a relative date the server could not count, is skipped for every row.
  const prepared = feature.rules.flatMap((rule) => {
    if (!rule.enabled) return [];
    const condition = lowerFields(rule.condition as ConditionNode);
    const reads = conditionalFormatRuleFields({ ...rule, condition, target: { kind: "row" } });
    const fields = reads.map((fieldId) => fieldsById.get(fieldId));
    if (fields.some((field) => field === undefined)) {
      console.error(
        `[records-table] formatting rule skipped code=RULE_FIELD_UNDECLARED rule=${rule.id}`,
      );
      return [];
    }
    const keys = [...new Set(parameterKeys(condition))];
    if (keys.some((key) => !dateParameterSet.has(key))) return [];
    if (keys.length > 0 && context.relativeDates === undefined) return [];
    const parameterDeclarations: TypedConditionParameterDeclaration[] = keys.map((key) => ({
      key,
      type: "date",
    }));
    const parameterValues = Object.fromEntries(
      keys.map((key) => [key, context.relativeDates?.[key as ConditionalFormattingDateParameter]]),
    );
    const sourceRecordFields = (fields as ModuleField[]).map((field) => ({
      ...field,
      fieldId: lower(String(field.fieldId)) as ModuleField["fieldId"],
    }));
    const cells =
      rule.target.kind === "cells"
        ? [...new Set(rule.target.fields.map(lower))].filter((fieldId) => visible.has(fieldId))
        : [];
    if (rule.target.kind === "cells" && cells.length === 0) return [];
    return [
      {
        rule,
        condition,
        reads,
        sourceRecordFields,
        parameterDeclarations,
        parameterValues,
        cells,
      },
    ];
  });

  const used = new Set<string>();
  const refusedRules = new Set<string>();
  const formats = new Map<
    string,
    { row?: string; cells?: Record<string, string>; measures?: Record<string, number> }
  >();
  for (const row of rows) {
    const values: Readonly<Record<string, JsonValue>> = Object.fromEntries(
      Object.entries(row.values).map(([key, value]) => [lower(key), value]),
    );
    let rowStyle: string | undefined;
    const cellStyles: Record<string, string> = {};
    for (const entry of prepared) {
      // A field the engine withheld on this row skips the rule here: nothing is inferred.
      if (entry.reads.some((fieldId) => !Object.hasOwn(values, fieldId))) continue;
      let matched: boolean;
      try {
        matched = evaluateTypedCondition({
          condition: entry.condition,
          sourceRecordFields: entry.sourceRecordFields,
          declaredFieldIds: entry.reads,
          parameterDeclarations: entry.parameterDeclarations,
          fieldValues: Object.fromEntries(entry.reads.map((fieldId) => [fieldId, values[fieldId]])),
          parameterValues: entry.parameterValues,
        });
      } catch (error) {
        if (!(error instanceof TypedConditionEvaluationError)) throw error;
        // A comparison the evaluator refuses on this row's values (two currencies, for one) does
        // not match; the cause is logged once per rule and read.
        if (!refusedRules.has(entry.rule.id)) {
          refusedRules.add(entry.rule.id);
          console.error(
            `[records-table] formatting rule refused code=RULE_EVALUATION_REFUSED rule=${entry.rule.id} reason=${error.reason}`,
          );
        }
        matched = false;
      }
      if (!matched) continue;
      if (entry.rule.target.kind === "row") {
        if (rowStyle === undefined) {
          rowStyle = entry.rule.id;
          used.add(entry.rule.id);
        }
      } else
        for (const fieldId of entry.cells)
          if (cellStyles[fieldId] === undefined) {
            cellStyles[fieldId] = entry.rule.id;
            used.add(entry.rule.id);
          }
      if (entry.rule.stopIfTrue) break;
    }
    if (rowStyle !== undefined || Object.keys(cellStyles).length > 0)
      formats.set(row.recordId, {
        ...(rowStyle === undefined ? {} : { row: rowStyle }),
        ...(Object.keys(cellStyles).length === 0 ? {} : { cells: cellStyles }),
      });
  }

  // Numeric columns: each visible column's range over this page's readable values. A column
  // whose amounts are in more than one currency has no single range and is not drawn.
  const columns: Record<string, ConditionalColumnFormatProjection> = {};
  for (const format of feature.columnFormats) {
    const fieldId = lower(format.field);
    if (!visible.has(fieldId) || columns[fieldId] !== undefined) continue;
    const measured = rows.flatMap((row) => {
      const value = Object.entries(row.values).find(([key]) => lower(key) === fieldId)?.[1];
      const measure = measureOf(value);
      return measure === undefined ? [] : [{ recordId: row.recordId, ...measure }];
    });
    if (measured.length === 0 || new Set(measured.map((entry) => entry.c)).size > 1) continue;
    const numbers = measured.map((entry) => entry.n);
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    const low = format.kind === "data_bar" ? Math.min(0, min) : min;
    const high = format.kind === "data_bar" ? Math.max(0, max) : max;
    for (const entry of measured) {
      const fraction =
        high === low ? (format.kind === "data_bar" ? 1 : 0.5) : (entry.n - low) / (high - low);
      const held = formats.get(entry.recordId) ?? {};
      formats.set(entry.recordId, {
        ...held,
        measures: { ...held.measures, [fieldId]: rounded(fraction) },
      });
    }
    columns[fieldId] =
      format.kind === "data_bar"
        ? { kind: "data_bar", token: format.token }
        : { kind: "colour_scale", tokens: format.tokens };
  }

  if (formats.size === 0) return undefined;
  const styles = Object.fromEntries(
    feature.rules.filter((rule) => used.has(rule.id)).map((rule) => [rule.id, rule.style]),
  );
  return { projection: { styles, columns }, rows: formats };
};
