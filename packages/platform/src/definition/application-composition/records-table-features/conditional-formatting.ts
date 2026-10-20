import type { z } from "zod";
import type { JsonValue } from "../../../catalogue/common";
import type { sourceQualifiedConditionSchema } from "../../definition-source-common";
import type { ConditionNode } from "../../module-foundation-contracts";
import {
  conditionValueType,
  operatorAcceptsOperands,
  semanticTypeForLiteral,
  type OperandInfo,
} from "../../../rules/condition-types";
import type { ComponentSettingValue } from "../block-property-schema";
import {
  factsOf,
  factsValueType,
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  fieldList,
  settingField,
  settingGroup,
  settingItems,
  settingOptionalChoice,
  settingText,
  type RecordsTableFeatureCheck,
  type RecordsTableFeatureDefinition,
  type RecordsTableQueryFacts,
} from "./shared";

/** The semantic tokens a format may use; each is a theme colour every app theme preset defines. */
export const conditionalFormatTokens = [
  "success",
  "warning",
  "info",
  "destructive",
  "muted",
] as const;
export type ConditionalFormatToken = (typeof conditionalFormatTokens)[number];

/** The closed icons a rule may show beside a value, so a status never relies on colour alone. */
export const conditionalFormatIcons = [
  "alert",
  "check",
  "info",
  "clock",
  "flag",
  "star",
  "x",
  "arrow_up",
  "arrow_down",
] as const;
export type ConditionalFormatIcon = (typeof conditionalFormatIcons)[number];

/**
 * The relative dates a rule's condition may compare a date with, as condition parameters: each is
 * a calendar date counted in the organisation's time zone when the page is read. Weeks start on
 * Monday.
 */
export const conditionalFormattingDateParameters = [
  "today",
  "start_of_week",
  "end_of_week",
  "start_of_month",
  "end_of_month",
] as const;
export type ConditionalFormattingDateParameter =
  (typeof conditionalFormattingDateParameters)[number];

/** How a matching rule draws its target. Only semantic tokens; never a colour of its own. */
export type ConditionalFormatStyle = Readonly<{
  token: ConditionalFormatToken;
  /** A background tint of the token. */
  tint: boolean;
  /** The text in the token's colour. */
  text: boolean;
  bold: boolean;
  strike: boolean;
  icon?: ConditionalFormatIcon;
  /** A short label shown as a badge, and read out with the value. */
  badgeLabel?: string;
}>;

/**
 * A rule's condition as the table's settings spell it: the authored short form with qualified
 * fields in a draft, the canonical condition tree with field identities in a release.
 */
export type ConditionalFormatCondition =
  ConditionNode | z.infer<typeof sourceQualifiedConditionSchema>;

/**
 * One rule: a condition, its target (the whole row or chosen cells) and the style it gives. Rules
 * are ordered; per target the first matching rule wins, and a matching rule that stops ends the
 * row's rules.
 */
export type ConditionalFormatRule = Readonly<{
  id: string;
  enabled: boolean;
  condition: ConditionalFormatCondition;
  target: Readonly<{ kind: "row" }> | Readonly<{ kind: "cells"; fields: readonly string[] }>;
  style: ConditionalFormatStyle;
  stopIfTrue: boolean;
}>;

/**
 * A numeric column's format: a data bar of one token, or a three-point colour scale from low to
 * high. Both are measured over the rows of the page being read, never the whole filtered set.
 */
export type ConditionalColumnFormat =
  | Readonly<{ field: string; kind: "data_bar"; token: ConditionalFormatToken }>
  | Readonly<{
      field: string;
      kind: "colour_scale";
      tokens: readonly [ConditionalFormatToken, ConditionalFormatToken, ConditionalFormatToken];
    }>;

export type RecordsTableConditionalFormattingSettings = Readonly<{
  rules: readonly ConditionalFormatRule[];
  columnFormats: readonly ConditionalColumnFormat[];
}>;

/** The field types a data bar or colour scale measures. */
export const conditionalColumnFormatFieldTypes: readonly string[] = Object.freeze([
  "whole_number",
  "decimal_number",
  "money",
]);

const settingBoolean = (value: ComponentSettingValue | undefined): boolean | undefined =>
  value?.kind === "boolean" ? value.value : undefined;

const readStyle = (
  group: Readonly<Record<string, ComponentSettingValue>>,
): ConditionalFormatStyle | undefined => {
  const token = settingOptionalChoice(group["token"], conditionalFormatTokens);
  if (token === undefined) return undefined;
  const icon = settingOptionalChoice(group["icon"], conditionalFormatIcons);
  const badgeLabel = settingText(group["badge_label"]);
  return {
    token,
    tint: settingBoolean(group["tint"]) === true,
    text: settingBoolean(group["text_colour"]) === true,
    bold: settingBoolean(group["bold"]) === true,
    strike: settingBoolean(group["strike"]) === true,
    ...(icon === undefined ? {} : { icon }),
    ...(badgeLabel === undefined ? {} : { badgeLabel }),
  };
};

const readRule = (value: ComponentSettingValue): ConditionalFormatRule[] => {
  const group = settingGroup(value);
  if (group === undefined) return [];
  const id = settingText(group["rule_id"]);
  const condition = group["condition"];
  const style = readStyle(group);
  if (id === undefined || condition?.kind !== "condition" || style === undefined) return [];
  const targetKind = settingOptionalChoice(group["target"], ["row", "cells"] as const);
  return [
    {
      id,
      enabled: settingBoolean(group["enabled"]) !== false,
      condition: condition.condition,
      target:
        targetKind === "cells"
          ? { kind: "cells", fields: fieldList(group["fields"]) }
          : { kind: "row" },
      style,
      stopIfTrue: settingBoolean(group["stop_if_true"]) === true,
    },
  ];
};

const readColumnFormat = (value: ComponentSettingValue): ConditionalColumnFormat[] => {
  const group = settingGroup(value);
  const field = settingField(group?.["field"]);
  if (group === undefined || field === undefined) return [];
  const kind = settingOptionalChoice(group["kind"], ["data_bar", "colour_scale"] as const);
  if (kind === "data_bar") {
    const token = settingOptionalChoice(group["token"], conditionalFormatTokens);
    return token === undefined ? [] : [{ field, kind, token }];
  }
  if (kind !== "colour_scale") return [];
  const low = settingOptionalChoice(group["low_token"], conditionalFormatTokens);
  const mid = settingOptionalChoice(group["mid_token"], conditionalFormatTokens);
  const high = settingOptionalChoice(group["high_token"], conditionalFormatTokens);
  return low === undefined || mid === undefined || high === undefined
    ? []
    : [{ field, kind, tokens: [low, mid, high] }];
};

/** One operand of a comparison, read from either spelling of a condition. */
export type ConditionalFormatOperand =
  | Readonly<{ source: "field"; field: string }>
  | Readonly<{ source: "value"; value: JsonValue }>
  | Readonly<{ source: "parameter"; key: string }>;

/** One comparison of a condition, read from either spelling. */
export type ConditionalFormatComparison = Readonly<{
  operator: string;
  left: ConditionalFormatOperand;
  right?: ConditionalFormatOperand;
}>;

const plain = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

const operandOf = (value: unknown): ConditionalFormatOperand | undefined => {
  const operand = plain(value);
  if (operand["source"] === "field")
    return typeof operand["fieldId"] === "string"
      ? { source: "field", field: operand["fieldId"] }
      : typeof operand["field"] === "string"
        ? { source: "field", field: operand["field"] }
        : undefined;
  if (operand["source"] === "value" && "value" in operand)
    return { source: "value", value: operand["value"] as JsonValue };
  if (operand["source"] === "parameter") {
    const key = operand["key"] ?? operand["parameter"];
    return typeof key === "string" ? { source: "parameter", key } : undefined;
  }
  return undefined;
};

/**
 * The comparisons of a condition in either spelling: the canonical tree (`kind`, `fieldId`, `key`)
 * or the authored short form (`field` with a `value` or `parameter`, and `all`/`any`/`not`).
 */
export const conditionalFormatComparisons = (
  condition: ConditionalFormatCondition,
): readonly ConditionalFormatComparison[] => {
  const node = plain(condition);
  for (const branch of ["conditions", "all", "any"] as const)
    if (Array.isArray(node[branch]))
      return (node[branch] as ConditionalFormatCondition[]).flatMap(conditionalFormatComparisons);
  if (node["condition"] !== undefined && node["kind"] === "not")
    return conditionalFormatComparisons(node["condition"] as ConditionalFormatCondition);
  if (node["not"] !== undefined)
    return conditionalFormatComparisons(node["not"] as ConditionalFormatCondition);
  const operator = node["operator"];
  if (typeof operator !== "string") return [];
  const left =
    typeof node["field"] === "string"
      ? ({ source: "field", field: node["field"] } as const)
      : operandOf(node["left"]);
  if (left === undefined) return [];
  const right =
    typeof node["field"] === "string"
      ? "parameter" in node
        ? operandOf({ source: "parameter", key: node["parameter"] })
        : "value" in node
          ? operandOf({ source: "value", value: node["value"] })
          : undefined
      : operandOf(node["right"]);
  return [{ operator, left, ...(right === undefined ? {} : { right }) }];
};

/** Every field a rule reads: its condition's fields and the cells it targets. */
export const conditionalFormatRuleFields = (rule: ConditionalFormatRule): readonly string[] => [
  ...new Set([
    ...conditionalFormatComparisons(rule.condition).flatMap((comparison) =>
      [comparison.left, comparison.right].flatMap((operand) =>
        operand?.source === "field" ? [operand.field] : [],
      ),
    ),
    ...(rule.target.kind === "cells" ? rule.target.fields : []),
  ]),
];

const operatorWords: Readonly<Record<string, string>> = {
  greater_than: "is after",
  greater_than_or_equal: "is on or after",
  less_than: "is before",
  less_than_or_equal: "is on or before",
  equals: "is",
  not_equals: "is not",
};
const dateTypes = new Set(["date"]);

/** A field's business name, or the last part of its reference when the query does not offer it. */
const fieldName = (facts: RecordsTableQueryFacts, field: string): string =>
  factsOf(facts, field)?.label ?? field.split(/[.:]/).at(-1) ?? field;

/** A rule whose style colours a value conveys status, so it needs an icon or a label as well. */
const showsStatusByColour = (style: ConditionalFormatStyle): boolean => style.tint || style.text;

/**
 * What stops one rule from being published, as the sentence Studio shows beside it, or undefined
 * when the rule fits the bound query.
 */
export const conditionalFormatRuleIssue = (
  rule: ConditionalFormatRule,
  facts: RecordsTableQueryFacts,
): string | undefined => {
  for (const field of conditionalFormatRuleFields(rule))
    if (factsOf(facts, field) === undefined)
      return `${fieldName(facts, field)} is not in the bound query.`;
  if (rule.target.kind === "cells" && rule.target.fields.length === 0)
    return "Choose the cells this rule formats.";
  const comparisons = conditionalFormatComparisons(rule.condition);
  if (comparisons.length === 0) return "Build the rule's condition.";
  for (const comparison of comparisons) {
    if (!["contains", "not_contains"].includes(comparison.operator)) {
      for (const [operand, other] of [
        [comparison.left, comparison.right],
        [comparison.right, comparison.left],
      ] as const) {
        if (operand?.source !== "value" || operand.value === null || other?.source !== "field")
          continue;
        const field = factsOf(facts, other.field);
        if (field?.choiceValues === undefined) continue;
        const options = field.choiceValues;
        const values =
          ["in", "not_in"].includes(comparison.operator) && Array.isArray(operand.value)
            ? operand.value
            : [operand.value];
        if (values.some((value) => typeof value !== "string" || !options.includes(value)))
          return `Choose one of the options of ${field.label}; this value is not one of them.`;
      }
    }
    const left =
      comparison.left.source === "field" ? factsOf(facts, comparison.left.field) : undefined;
    const right = comparison.right;
    if (right?.source === "parameter") {
      const relative = (conditionalFormattingDateParameters as readonly string[]).includes(
        right.key,
      );
      if (!relative) return "A rule compares only with fields, values and relative dates.";
      if (left === undefined || !dateTypes.has(factsValueType(left)))
        return `'${operatorWords[comparison.operator] ?? "is"}' needs a date field.`;
    }
    const operandInfo = (operand: ConditionalFormatOperand): OperandInfo => {
      if (operand.source === "value")
        return {
          source: "value",
          semanticType: semanticTypeForLiteral(operand.value),
          literal: operand.value,
        };
      if (operand.source === "parameter")
        return {
          source: "reference",
          semanticType: (conditionalFormattingDateParameters as readonly string[]).includes(
            operand.key,
          )
            ? "date"
            : undefined,
        };
      const field = factsOf(facts, operand.field);
      return {
        source: "reference",
        semanticType: field === undefined ? undefined : conditionValueType(factsValueType(field)),
      };
    };
    if (
      !operatorAcceptsOperands(
        comparison.operator,
        operandInfo(comparison.left),
        right === undefined ? undefined : operandInfo(right),
      )
    ) {
      if (right?.source === "field" && left !== undefined)
        return `Compare ${left.label} with a field of the same type.`;
      return `Choose an operator and value that match ${left?.label ?? "the condition"}.`;
    }
  }
  if (
    showsStatusByColour(rule.style) &&
    rule.style.icon === undefined &&
    rule.style.badgeLabel === undefined
  )
    return "Add an icon or label so the meaning is not shown by colour alone.";
  return undefined;
};

/** What stops one numeric column format, or undefined when it fits the bound query. */
export const conditionalColumnFormatIssue = (
  format: ConditionalColumnFormat,
  facts: RecordsTableQueryFacts,
): string | undefined => {
  const field = factsOf(facts, format.field);
  if (field === undefined) return `${fieldName(facts, format.field)} is not in the bound query.`;
  return conditionalColumnFormatFieldTypes.includes(factsValueType(field))
    ? undefined
    : format.kind === "data_bar"
      ? "Data bars need a number or money column."
      : "Colour scales need a number or money column.";
};

const notPossible = (reason: string): RecordsTableFeatureCheck =>
  featureNotPossible("definition_records_table_conditional_formatting", reason);

export const recordsTableConditionalFormattingFeature: RecordsTableFeatureDefinition<RecordsTableConditionalFormattingSettings> =
  {
    key: "conditional_formatting",
    label: "Formatting",
    description: "Highlight rows and cells that match conditions",
    read: (group) => {
      if (featureEnabled(group) !== true) return { enabled: false };
      return {
        enabled: true,
        rules: (settingItems(group["rules"]) ?? []).flatMap(readRule),
        columnFormats: (settingItems(group["column_formats"]) ?? []).flatMap(readColumnFormat),
      };
    },
    // Every rule and column format must read fields of the bound query with comparisons that fit
    // their types, and a status shown by colour needs an icon or a label too. A feature that is off
    // needs at least one field to build a rule from.
    check: (state, facts) => {
      if (facts.fields.length === 0)
        return notPossible("Formatting needs at least one field in the bound query.");
      if (!state.enabled) return featureAvailable;
      if (state.rules.length === 0 && state.columnFormats.length === 0)
        return notPossible("Add a rule or a column format.");
      const ids = new Set<string>();
      for (const rule of state.rules) {
        if (ids.has(rule.id)) return notPossible("Each rule needs its own identity.");
        ids.add(rule.id);
        const issue = conditionalFormatRuleIssue(rule, facts);
        if (issue !== undefined) return notPossible(issue);
      }
      const formattedFields = new Set<string>();
      for (const format of state.columnFormats) {
        const field = format.field.toLowerCase();
        if (formattedFields.has(field))
          return notPossible(`Choose one number format for ${fieldName(facts, format.field)}.`);
        formattedFields.add(field);
        const issue = conditionalColumnFormatIssue(format, facts);
        if (issue !== undefined) return notPossible(issue);
      }
      return featureAvailable;
    },
  };
