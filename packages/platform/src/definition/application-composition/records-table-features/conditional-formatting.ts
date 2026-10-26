import { projectionFieldKeySchema as fieldKeySchema } from "./shared";
import { z } from "zod";
import type { JsonValue } from "../../../catalogue/common";
import type { sourceQualifiedConditionSchema } from "../../definition-source-common";
import type { ConditionNode } from "../../module-foundation-contracts";
import {
  conditionValueType,
  operatorAcceptsOperands,
  semanticTypeForLiteral,
  type OperandInfo,
} from "../../../rules/condition-types";
import type { ModuleField } from "../../module-contracts";
import type { ComponentSettingValue } from "../block-property-schema";
import {
  factsOf,
  factsValueType,
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  optionalText,
  requiredBoolean,
  requiredChoice,
  requiredField,
  requiredFieldList,
  requiredGroup,
  requiredItems,
  requiredText,
  unreadable,
  type RecordsTableBoardFacts,
  type RecordsTableFeatureCheck,
  type RecordsTableFeatureDefinition,
  type RecordsTableFieldFacts,
  type GridFeatureRefusal,
  type GridFeatureSettingsDeclaration,
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
  icon?: ConditionalFormatIcon | undefined;
  /** A short label shown as a badge, and read out with the value. */
  badgeLabel?: string | undefined;
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

const readStyle = (
  group: Readonly<Record<string, ComponentSettingValue>>,
  at: string,
): ConditionalFormatStyle => {
  const token = requiredChoice(group["token"], conditionalFormatTokens, `${at}.token`);
  // The catalogue's "none" is the choice of no icon.
  const icon = requiredChoice(group["icon"], [...conditionalFormatIcons, "none"], `${at}.icon`);
  const badgeLabel = optionalText(group["badge_label"], `${at}.badge_label`);
  return {
    token,
    tint: requiredBoolean(group["tint"], `${at}.tint`),
    text: requiredBoolean(group["text_colour"], `${at}.text_colour`),
    bold: requiredBoolean(group["bold"], `${at}.bold`),
    strike: requiredBoolean(group["strike"], `${at}.strike`),
    ...(icon === "none" ? {} : { icon }),
    ...(badgeLabel === undefined ? {} : { badgeLabel }),
  };
};

const readRule = (value: ComponentSettingValue, at: string): ConditionalFormatRule => {
  const group = requiredGroup(value, at);
  const condition = group["condition"];
  if (condition?.kind !== "condition") return unreadable(`${at}.condition`);
  const target = requiredChoice(group["target"], ["row", "cells"] as const, `${at}.target`);
  return {
    id: requiredText(group["rule_id"], `${at}.rule_id`),
    enabled: requiredBoolean(group["enabled"], `${at}.enabled`),
    condition: condition.condition,
    target:
      target === "cells"
        ? { kind: "cells", fields: requiredFieldList(group["fields"], `${at}.fields`) }
        : { kind: "row" },
    style: readStyle(group, at),
    stopIfTrue: requiredBoolean(group["stop_if_true"], `${at}.stop_if_true`),
  };
};

const readColumnFormat = (value: ComponentSettingValue, at: string): ConditionalColumnFormat => {
  const group = requiredGroup(value, at);
  const field = requiredField(group["field"], `${at}.field`);
  const kind = requiredChoice(group["kind"], ["data_bar", "colour_scale"] as const, `${at}.kind`);
  if (kind === "data_bar")
    return {
      field,
      kind,
      token: requiredChoice(group["token"], conditionalFormatTokens, `${at}.token`),
    };
  return {
    field,
    kind,
    tokens: [
      requiredChoice(group["low_token"], conditionalFormatTokens, `${at}.low_token`),
      requiredChoice(group["mid_token"], conditionalFormatTokens, `${at}.mid_token`),
      requiredChoice(group["high_token"], conditionalFormatTokens, `${at}.high_token`),
    ],
  };
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

/**
 * The fields a rule is checked against: the bound query's fields at publication and in Studio, a
 * record type's fields when a person saves a personal rule.
 */
export type ConditionalFormatFacts = Readonly<{
  fields: readonly Pick<
    RecordsTableFieldFacts,
    "field" | "label" | "type" | "resultType" | "choiceValues"
  >[];
}>;

/** A record type's fields as a rule is checked against them: a person's rule is, as an authored one. */
export const conditionalFormatFactsOf = (
  fields: readonly ModuleField[],
): ConditionalFormatFacts => ({
  fields: fields.map((field) => {
    const settings = (field as { settings?: Readonly<Record<string, unknown>> }).settings ?? {};
    const options = settings["options"];
    return {
      field: String(field.fieldId),
      label: field.label,
      type: field.type,
      ...(typeof settings["resultType"] === "string" ? { resultType: settings["resultType"] } : {}),
      ...(field.type === "choice" && Array.isArray(options)
        ? { choiceValues: options.map((option: { value: string }) => String(option.value)) }
        : {}),
    };
  }),
});

/** A field's business name; a removed reference never exposes its internal key. */
const fieldName = (facts: ConditionalFormatFacts, field: string): string =>
  factsOf(facts, field)?.label ?? "A removed item";

/** A rule whose style colours a value conveys status, so it needs an icon or a label as well. */
const showsStatusByColour = (style: ConditionalFormatStyle): boolean => style.tint || style.text;

/**
 * What stops one rule from being published, as the sentence Studio shows beside it, or undefined
 * when the rule fits the bound query.
 */
export const conditionalFormatRuleIssue = (
  rule: ConditionalFormatRule,
  facts: ConditionalFormatFacts,
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
  facts: ConditionalFormatFacts,
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
  featureNotPossible(featureRefusal, reason);

/** The feature's setting group in the Table release, off by default. */
const featureSettings = {
  kind: "group",
  key: "conditional_formatting",
  label: "Formatting",
  help: "Highlight rows and cells that match conditions, and show number columns as data bars or colour scales",
  required: false,
  defaultValue: {
    kind: "group",
    properties: {
      enabled: {
        kind: "boolean",
        value: false,
      },
      rules: {
        kind: "list",
        items: [],
      },
      column_formats: {
        kind: "list",
        items: [],
      },
    },
  },
  properties: [
    {
      kind: "boolean",
      key: "enabled",
      label: "On",
      help: "Format rows and cells by rules",
      required: false,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
    {
      kind: "list",
      key: "rules",
      label: "Rules",
      help: "Ordered rules; for each row or cell the first matching rule wins",
      required: false,
      minimumItems: 0,
      maximumItems: 20,
      item: {
        kind: "group",
        key: "rule",
        label: "Rule",
        help: "One condition, what it formats and how",
        required: true,
        properties: [
          {
            kind: "text",
            key: "rule_id",
            label: "Rule identity",
            help: "Stable identity of the rule within the table",
            required: true,
            minLength: 1,
            maxLength: 40,
          },
          {
            kind: "boolean",
            key: "enabled",
            label: "On",
            help: "Apply this rule",
            required: false,
            defaultValue: {
              kind: "boolean",
              value: true,
            },
          },
          {
            kind: "condition",
            key: "condition",
            label: "Condition",
            help: "When the rule applies, over fields of the bound query",
            required: true,
          },
          {
            kind: "choice",
            key: "target",
            label: "Formats",
            help: "The whole row, or chosen cells",
            required: false,
            options: [
              {
                key: "row",
                label: "Whole row",
              },
              {
                key: "cells",
                label: "Chosen cells",
              },
            ],
            defaultValue: {
              kind: "choice",
              value: "row",
            },
          },
          {
            kind: "list",
            key: "fields",
            label: "Cells",
            help: "The columns whose cells the rule formats",
            required: false,
            minimumItems: 0,
            maximumItems: 50,
            showWhen: {
              property: "target",
              values: ["cells"],
            },
            item: {
              kind: "field_reference",
              key: "field",
              label: "Field",
              help: "Column of the table",
              required: true,
            },
          },
          {
            kind: "choice",
            key: "token",
            label: "Colour",
            help: "The semantic colour of the format",
            required: false,
            options: [
              {
                key: "success",
                label: "Success",
              },
              {
                key: "warning",
                label: "Warning",
              },
              {
                key: "info",
                label: "Information",
              },
              {
                key: "destructive",
                label: "Critical",
              },
              {
                key: "muted",
                label: "Muted",
              },
            ],
            defaultValue: {
              kind: "choice",
              value: "info",
            },
          },
          {
            kind: "boolean",
            key: "tint",
            label: "Background tint",
            help: "Tint the background in the colour",
            required: false,
            defaultValue: {
              kind: "boolean",
              value: true,
            },
          },
          {
            kind: "boolean",
            key: "text_colour",
            label: "Text colour",
            help: "Show the text in the colour",
            required: false,
            defaultValue: {
              kind: "boolean",
              value: false,
            },
          },
          {
            kind: "boolean",
            key: "bold",
            label: "Bold",
            help: "Show the text in bold",
            required: false,
            defaultValue: {
              kind: "boolean",
              value: false,
            },
          },
          {
            kind: "boolean",
            key: "strike",
            label: "Strike through",
            help: "Strike the text through",
            required: false,
            defaultValue: {
              kind: "boolean",
              value: false,
            },
          },
          {
            kind: "choice",
            key: "icon",
            label: "Icon",
            help: "An icon shown before the value, read out with it",
            required: false,
            options: [
              {
                key: "none",
                label: "None",
              },
              {
                key: "alert",
                label: "Alert",
              },
              {
                key: "check",
                label: "Check",
              },
              {
                key: "info",
                label: "Information",
              },
              {
                key: "clock",
                label: "Clock",
              },
              {
                key: "flag",
                label: "Flag",
              },
              {
                key: "star",
                label: "Star",
              },
              {
                key: "close",
                label: "Cross",
              },
              {
                key: "arrow_up",
                label: "Arrow up",
              },
              {
                key: "arrow_down",
                label: "Arrow down",
              },
            ],
            defaultValue: {
              kind: "choice",
              value: "none",
            },
          },
          {
            kind: "text",
            key: "badge_label",
            label: "Label",
            help: "A short label shown as a badge and read out with the value",
            required: false,
            minLength: 1,
            maxLength: 30,
          },
          {
            kind: "boolean",
            key: "stop_if_true",
            label: "Stop if true",
            help: "When this rule matches, later rules are not applied to the row",
            required: false,
            defaultValue: {
              kind: "boolean",
              value: false,
            },
          },
        ],
      },
      defaultValue: {
        kind: "list",
        items: [],
      },
    },
    {
      kind: "list",
      key: "column_formats",
      label: "Number columns",
      help: "Data bars or three-point colour scales, measured over the rows on the page",
      required: false,
      minimumItems: 0,
      maximumItems: 10,
      item: {
        kind: "group",
        key: "column_format",
        label: "Column format",
        help: "One number column drawn as a bar or a colour scale",
        required: true,
        properties: [
          {
            kind: "field_reference",
            key: "field",
            label: "Column",
            help: "A number or money column of the table",
            required: true,
          },
          {
            kind: "choice",
            key: "kind",
            label: "Format",
            help: "A data bar, or a colour scale from low to high",
            required: false,
            options: [
              {
                key: "data_bar",
                label: "Data bar",
              },
              {
                key: "colour_scale",
                label: "Colour scale",
              },
            ],
            defaultValue: {
              kind: "choice",
              value: "data_bar",
            },
          },
          {
            kind: "choice",
            key: "token",
            label: "Bar colour",
            help: "The colour of the bar",
            required: false,
            options: [
              {
                key: "success",
                label: "Success",
              },
              {
                key: "warning",
                label: "Warning",
              },
              {
                key: "info",
                label: "Information",
              },
              {
                key: "destructive",
                label: "Critical",
              },
              {
                key: "muted",
                label: "Muted",
              },
            ],
            defaultValue: {
              kind: "choice",
              value: "info",
            },
            showWhen: {
              property: "kind",
              values: ["data_bar"],
            },
          },
          {
            kind: "choice",
            key: "low_token",
            label: "Low colour",
            help: "The colour of the lowest value on the page",
            required: false,
            options: [
              {
                key: "success",
                label: "Success",
              },
              {
                key: "warning",
                label: "Warning",
              },
              {
                key: "info",
                label: "Information",
              },
              {
                key: "destructive",
                label: "Critical",
              },
              {
                key: "muted",
                label: "Muted",
              },
            ],
            defaultValue: {
              kind: "choice",
              value: "destructive",
            },
            showWhen: {
              property: "kind",
              values: ["colour_scale"],
            },
          },
          {
            kind: "choice",
            key: "mid_token",
            label: "Middle colour",
            help: "The colour of the middle value on the page",
            required: false,
            options: [
              {
                key: "success",
                label: "Success",
              },
              {
                key: "warning",
                label: "Warning",
              },
              {
                key: "info",
                label: "Information",
              },
              {
                key: "destructive",
                label: "Critical",
              },
              {
                key: "muted",
                label: "Muted",
              },
            ],
            defaultValue: {
              kind: "choice",
              value: "warning",
            },
            showWhen: {
              property: "kind",
              values: ["colour_scale"],
            },
          },
          {
            kind: "choice",
            key: "high_token",
            label: "High colour",
            help: "The colour of the highest value on the page",
            required: false,
            options: [
              {
                key: "success",
                label: "Success",
              },
              {
                key: "warning",
                label: "Warning",
              },
              {
                key: "info",
                label: "Information",
              },
              {
                key: "destructive",
                label: "Critical",
              },
              {
                key: "muted",
                label: "Muted",
              },
            ],
            defaultValue: {
              kind: "choice",
              value: "success",
            },
            showWhen: {
              property: "kind",
              values: ["colour_scale"],
            },
          },
        ],
      },
      defaultValue: {
        kind: "list",
        items: [],
      },
    },
  ],
} as const satisfies GridFeatureSettingsDeclaration;

/** The feature's refusals and their business sentences. */
const featureRefusal: GridFeatureRefusal = {
  code: "definition_records_table_conditional_formatting",
  order: 39,
  message: "Formatting needs rules over fields of the bound query.",
  guidance:
    "Build each rule's condition from fields of the bound query, give a status an icon or a label, or turn Formatting off.",
};

const textSchema = z.string().min(1);
/** The styles a rule names: a closed style of semantic tokens, never a colour or markup. */
const conditionalFormatStyleSchema = z
  .object({
    token: z.enum(conditionalFormatTokens),
    tint: z.boolean(),
    text: z.boolean(),
    bold: z.boolean(),
    strike: z.boolean(),
    icon: z.enum(conditionalFormatIcons).optional(),
    badgeLabel: textSchema.optional(),
  })
  .strict()
  .readonly();

/**
 * How one numeric column is drawn for this read: a data bar of one token, or a three-point colour
 * scale. Its measures (`RecordsTableRowFormat.measures`) are fractions of the page's own range.
 */
const columnFormatSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("data_bar"), token: z.enum(conditionalFormatTokens) })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("colour_scale"),
      tokens: z
        .tuple([
          z.enum(conditionalFormatTokens),
          z.enum(conditionalFormatTokens),
          z.enum(conditionalFormatTokens),
        ])
        .readonly(),
    })
    .strict()
    .readonly(),
]);

/** The styles of a board's cards, or of a table's rows, keyed by rule identity. */
export const conditionalFormatStylesSchema = z
  .record(z.string(), conditionalFormatStyleSchema)
  .readonly();

/**
 * The formatting one viewer sees on one read: the styles of the rules that matched a row of the
 * page (keyed by rule identity, the style key the rows carry) and the numeric columns drawn as bars
 * or scales. Nothing else of a rule travels: never its condition, never a value it read.
 */
const conditionalFormattingProjectionSchema = z
  .object({
    styles: conditionalFormatStylesSchema,
    columns: z.record(fieldKeySchema, columnFormatSchema).readonly(),
  })
  .strict()
  .readonly();
export type ConditionalFormattingProjection = z.output<
  typeof conditionalFormattingProjectionSchema
>;
export type ConditionalColumnFormatProjection = z.output<typeof columnFormatSchema>;

const projectionSchema = conditionalFormattingProjectionSchema;

export const recordsTableConditionalFormattingFeature: RecordsTableFeatureDefinition<
  RecordsTableConditionalFormattingSettings,
  "conditional_formatting"
> &
  Readonly<{ property: "conditionalFormatting"; projectionSchema: typeof projectionSchema }> = {
  key: "conditional_formatting",
  property: "conditionalFormatting",
  projectionSchema,
  settings: featureSettings,
  refusals: [featureRefusal],
  onBoard: "supported",
  label: "Formatting",
  description: "Highlight rows and cells that match conditions",
  read: (group) => {
    if (!featureEnabled(group)) return { enabled: false };
    return {
      enabled: true,
      rules: requiredItems(group["rules"], "rules").map((item, index) =>
        readRule(item, `rules[${index}]`),
      ),
      columnFormats: requiredItems(group["column_formats"], "column_formats").map((item, index) =>
        readColumnFormat(item, `column_formats[${index}]`),
      ),
    };
  },
  // Every rule and column format must read fields of the bound query with comparisons that fit
  // their types, and a status shown by colour needs an icon or a label too. A feature that is off
  // needs at least one field to build a rule from.
  // On a board a rule colours whole cards.
  boardCheck: (state, board) => (state.enabled ? boardFormattingProblem(state, board) : undefined),
  // The styles the rules matched on this read's rows; a feature that is off formats nothing.
  project: (state, { conditionalFormatting }) =>
    state.enabled && conditionalFormatting !== undefined ? conditionalFormatting : undefined,
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

/**
 * Why the formatting a board's cards would get cannot be applied, as one business sentence, or
 * undefined when it can. A card is one block, so a rule colours the whole card and a number format
 * (a bar or scale over a column of cells) has nothing to draw on; a rule reads any field of the
 * board's record type that the query selects, whether or not the card shows it.
 */
export const boardFormattingProblem = (
  settings: RecordsTableConditionalFormattingSettings,
  board: RecordsTableBoardFacts,
): Extract<RecordsTableFeatureCheck, { kind: "not_possible" }> | undefined => {
  const refuse = (reason: string): Extract<RecordsTableFeatureCheck, { kind: "not_possible" }> =>
    featureNotPossible(featureRefusal, reason) as Extract<
      RecordsTableFeatureCheck,
      { kind: "not_possible" }
    >;
  const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
  if (settings.rules.length === 0 && settings.columnFormats.length === 0)
    return refuse("Add a rule that colours the cards.");
  if (settings.columnFormats.length > 0)
    return refuse("Number formats need table columns: remove them to format the cards of a board.");
  const ids = new Set<string>();
  for (const rule of settings.rules) {
    if (ids.has(rule.id)) return refuse("Each rule needs its own identity.");
    ids.add(rule.id);
    if (rule.target.kind !== "row")
      return refuse("A board formats whole cards: choose the whole row for every rule.");
    const issue = conditionalFormatRuleIssue(rule, board);
    if (issue !== undefined) return refuse(issue.replace("the bound query", board.queryLabel));
    if (rule.enabled)
      for (const field of conditionalFormatRuleFields(rule))
        if (!board.selected.some((candidate) => same(candidate, field))) {
          const label =
            board.fields.find((candidate) => same(candidate.field, field))?.label ?? field;
          return refuse(
            `${label} is not selected by ${board.queryLabel}. Add it to the query to format these cards.`,
          );
        }
  }
  return undefined;
};
