"use client";

import { useId, useMemo, useState, type DragEvent, type ReactElement } from "react";
import {
  conditionalColumnFormatFieldTypes,
  conditionalColumnFormatIssue,
  conditionalFormatIcons,
  conditionalFormatRuleIssue,
  conditionalFormatTokens,
  conditionalFormattingDateParameters,
  type ConditionNode,
  type ConditionalColumnFormat,
  type ConditionalFormatIcon,
  type ConditionalFormatRule,
  type ConditionalFormatToken,
  type ConditionalFormattingDateParameter,
  type InlineQueryFilter,
  type ModuleField,
  type RecordsTableConditionalFormattingSettings,
  type RecordsTableFeatureState,
  type RecordsTableQueryFacts,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import { Badge } from "../../components/badge";
import { Button } from "../../components/button";
import { Input } from "../../components/input";
import { Label } from "../../components/label";
import { NativeSelect, NativeSelectOption } from "../../components/native-select";
import { Switch } from "../../components/switch";
import { ToggleGroup, ToggleGroupItem } from "../../components/toggle-group";
import { Icon } from "../../icons/icon";
import { cn } from "../../lib/utils";
import { StudioConditionControls } from "../condition-controls";
import { createInitialStudioCondition, describeCondition } from "../condition-model";
import type { StudioConditionControlsContext } from "../condition-model";
import type { StudioQueryChoice } from "../contextual-palette";
import { StudioInspectorActions } from "../studio-inspector-actions";
import { StudioReferencePicker } from "../studio-reference-picker";
import { readStudioQueryFilter, writeStudioQueryFilter } from "../studio-query-filter";

type Value = SourceBlockPropertyValueContract;
type GroupValue = Extract<Value, { kind: "group" }>;
type Properties = Readonly<Record<string, Value>>;

const tokenLabels: Readonly<Record<ConditionalFormatToken, string>> = {
  success: "Success",
  warning: "Warning",
  info: "Information",
  destructive: "Critical",
  muted: "Muted",
};
const tokenSwatches: Readonly<Record<ConditionalFormatToken, string>> = {
  success: "bg-success",
  warning: "bg-warning",
  info: "bg-info",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground",
};
const tokenTints: Readonly<Record<ConditionalFormatToken, string>> = {
  success: "bg-success/10",
  warning: "bg-warning/10",
  info: "bg-info/10",
  destructive: "bg-destructive/10",
  muted: "bg-muted",
};
const tokenTexts: Readonly<Record<ConditionalFormatToken, string>> = {
  success: "text-success",
  warning: "text-warning",
  info: "text-info",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};
const iconLabels: Readonly<Record<ConditionalFormatIcon, string>> = {
  alert: "Alert",
  check: "Check",
  info: "Information",
  clock: "Clock",
  flag: "Flag",
  star: "Star",
  x: "Cross",
  arrow_up: "Arrow up",
  arrow_down: "Arrow down",
};
const iconGlyphs = {
  alert: "triangle-alert",
  check: "check",
  info: "info",
  clock: "clock",
  flag: "flag",
  star: "star",
  x: "close",
  arrow_up: "arrow-up",
  arrow_down: "arrow-down",
} as const satisfies Readonly<Record<ConditionalFormatIcon, string>>;
const dateLabels: Readonly<Record<ConditionalFormattingDateParameter, string>> = {
  today: "Today",
  start_of_week: "Start of this week",
  end_of_week: "End of this week",
  start_of_month: "Start of this month",
  end_of_month: "End of this month",
};

const text = (value: string): Value => ({ kind: "text", value });
const flag = (value: boolean): Value => ({ kind: "boolean", value });
const choice = (value: string): Value => ({ kind: "choice", value });
const propertiesOf = (value: Value | undefined): Properties =>
  value?.kind === "group" ? value.properties : {};
const itemsOf = (value: Value | undefined): readonly Value[] =>
  value?.kind === "list" ? value.items : [];

/** A rule's style as the preview swatch draws it: the same token classes the grid uses. */
function StyleSwatch({ rule }: Readonly<{ rule: ConditionalFormatRule }>): ReactElement {
  const { style } = rule;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-6 min-w-10 shrink-0 items-center justify-center gap-1 rounded-sm border px-1.5 text-xs",
        style.tint && tokenTints[style.token],
        style.text && tokenTexts[style.token],
        style.bold && "font-semibold",
        style.strike && "line-through",
      )}
    >
      {style.icon === undefined ? null : <Icon name={iconGlyphs[style.icon]} className="size-3" />}
      Aa
    </span>
  );
}

/**
 * The Formatting feature's editor: an ordered rule list (drag, or Move up and Move down; a switch
 * per rule; a preview swatch) and the selected rule's editor, built with the one condition checker
 * over the fields of the bound query and the relative dates; then the number columns drawn as data
 * bars or colour scales. Each rule shows the publication check's own sentence. The canvas shows the
 * formatting live, read on the server from the builder's preview data.
 */
export function StudioConditionalFormattingEditor({
  idPrefix,
  value,
  state,
  query,
  facts,
  compiledFields,
  disabled,
  onChange,
}: Readonly<{
  idPrefix: string;
  /** The feature's authored group, switched on. */
  value: GroupValue;
  /** The same group as the registry reads it. */
  state: RecordsTableFeatureState<RecordsTableConditionalFormattingSettings>;
  query: StudioQueryChoice | undefined;
  facts: RecordsTableQueryFacts;
  /** The saved draft's compiled fields of the record type the query reads; undefined before a save. */
  compiledFields: readonly ModuleField[] | undefined;
  disabled: boolean;
  onChange: (next: GroupValue) => void;
}>): ReactElement {
  const ownId = useId();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [dragged, setDragged] = useState<number | undefined>(undefined);
  const properties = value.properties;
  const ruleItems = itemsOf(properties["rules"]);
  const formatItems = itemsOf(properties["column_formats"]);
  const rules = state.enabled ? state.rules : [];
  const columnFormats = state.enabled ? state.columnFormats : [];

  const recordType = query?.recordType;
  const queryFields = useMemo(() => query?.fields ?? [], [query]);
  // The condition controls work on the compiled fields; the settings name them by qualified field.
  const shown = useMemo(
    () =>
      (compiledFields ?? []).filter((field) =>
        queryFields.some((candidate) => candidate.reference === `${recordType}.${field.key}`),
      ),
    [compiledFields, queryFields, recordType],
  );
  const context = useMemo(
    (): StudioConditionControlsContext => ({
      allowedOperands: [
        ...shown.map((field) => ({
          operand: { source: "field" as const, fieldId: field.fieldId },
          field,
          label: field.label,
          role: "current_field" as const,
        })),
        ...conditionalFormattingDateParameters.map((key) => ({
          operand: { source: "parameter" as const, key },
          label: dateLabels[key],
          role: "host_context" as const,
        })),
      ],
      declaredFieldIds: shown.map((field) => String(field.fieldId)),
      parameterDeclarations: conditionalFormattingDateParameters.map((key) => ({
        key,
        type: "date" as const,
      })),
      allowLiteralValues: true,
    }),
    [shown],
  );
  const fieldIdOf = (reference: string): string | undefined =>
    shown.find((field) => `${recordType}.${field.key}` === reference)?.fieldId;
  const referenceOf = (fieldId: string): string | undefined => {
    const field = shown.find((candidate) => candidate.fieldId === fieldId);
    return field === undefined ? undefined : `${recordType}.${field.key}`;
  };
  const fieldLabel = (reference: string): string =>
    queryFields.find((field) => field.reference === reference)?.label ?? reference;

  const write = (next: Readonly<{ rules?: readonly Value[]; formats?: readonly Value[] }>): void =>
    onChange({
      kind: "group",
      properties: {
        ...properties,
        enabled: flag(true),
        ...(next.rules === undefined ? {} : { rules: { kind: "list", items: [...next.rules] } }),
        ...(next.formats === undefined
          ? {}
          : { column_formats: { kind: "list", items: [...next.formats] } }),
      },
    });
  // A rule is found in the authored list by its identity, never by its place among readable rules.
  const writeRule = (id: string, changes: Properties, remove: readonly string[] = []): void => {
    const index = ruleItems.findIndex((item) => {
      const held = propertiesOf(item)["rule_id"];
      return held?.kind === "text" && held.value === id;
    });
    if (index < 0) return;
    const current = propertiesOf(ruleItems[index]);
    const nextProperties = Object.fromEntries(
      Object.entries({ ...current, ...changes }).filter(([key]) => !remove.includes(key)),
    );
    write({
      rules: ruleItems.map((item, position) =>
        position === index ? { kind: "group", properties: nextProperties } : item,
      ),
    });
  };
  const rawIndex = (id: string | undefined): number =>
    ruleItems.findIndex((item) => {
      const held = propertiesOf(item)["rule_id"];
      return held?.kind === "text" && held.value === id;
    });
  const moveRule = (fromRule: number, toRule: number): void => {
    const from = rawIndex(rules[fromRule]?.id);
    const to = rawIndex(rules[toRule]?.id);
    if (from < 0 || to < 0 || from === to) return;
    const items = [...ruleItems];
    const [moved] = items.splice(from, 1);
    if (moved !== undefined) items.splice(to, 0, moved);
    write({ rules: items });
  };
  const initial = createInitialStudioCondition(context);
  const addRule = (): void => {
    const written =
      initial === undefined ? undefined : writeStudioQueryFilter(initial, referenceOf);
    if (written === undefined || written === null) return;
    const used = new Set(rules.map((rule) => rule.id));
    let number = rules.length + 1;
    while (used.has(`rule_${number}`)) number += 1;
    const id = `rule_${number}`;
    write({
      rules: [
        ...ruleItems,
        {
          kind: "group",
          properties: {
            rule_id: text(id),
            enabled: flag(true),
            condition: { kind: "condition", condition: written as never },
            target: choice("row"),
            token: choice("info"),
            tint: flag(true),
            icon: choice("info"),
          },
        },
      ],
    });
    setSelected(id);
  };
  const numberFields = queryFields.filter((field) =>
    conditionalColumnFormatFieldTypes.includes(field.resultType ?? field.type),
  );

  const selectedIndex = rules.findIndex((rule) => rule.id === selected);
  const selectedRule = selectedIndex < 0 ? undefined : rules[selectedIndex];

  return (
    <div className="space-y-4" data-vortex-formatting-editor="">
      <section aria-labelledby={`${ownId}-rules`} className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h4 id={`${ownId}-rules`} className="text-sm font-medium">
            Rules
          </h4>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || initial === undefined || ruleItems.length >= 20}
            onClick={addRule}
          >
            <Icon name="plus" />
            Add rule
          </Button>
        </div>
        {compiledFields === undefined ? (
          <p role="note" className="text-sm text-muted-foreground">
            Save the draft to build rules: their conditions work on the saved fields.
          </p>
        ) : null}
        {rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No rules yet. For each row or cell the first matching rule wins.
          </p>
        ) : (
          <ol aria-label="Formatting rules" className="space-y-1">
            {rules.map((rule, index) => {
              const issue = conditionalFormatRuleIssue(rule, facts);
              const switchId = `${idPrefix}-${ownId}-rule-${index}`;
              const reading = readStudioQueryFilter(rule.condition as InlineQueryFilter, fieldIdOf);
              const summary =
                reading.kind === "read" && reading.condition !== undefined
                  ? describeCondition(reading.condition, context)
                  : "Condition";
              const target =
                rule.target.kind === "row"
                  ? "Whole row"
                  : rule.target.fields.map(fieldLabel).join(", ") || "No cells";
              return (
                <li
                  key={rule.id}
                  draggable={!disabled}
                  onDragStart={(event: DragEvent<HTMLLIElement>) => {
                    setDragged(index);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(event: DragEvent<HTMLLIElement>) => {
                    if (dragged !== undefined) event.preventDefault();
                  }}
                  onDrop={(event: DragEvent<HTMLLIElement>) => {
                    event.preventDefault();
                    if (dragged !== undefined) moveRule(dragged, index);
                    setDragged(undefined);
                  }}
                  onDragEnd={() => setDragged(undefined)}
                  data-vortex-formatting-rule={rule.id}
                  className={cn(
                    "flex items-start gap-2 rounded-md border p-2",
                    selected === rule.id && "border-ring",
                    !rule.enabled && "opacity-60",
                  )}
                >
                  <Icon
                    name="grip-vertical"
                    className="mt-1 size-4 shrink-0 cursor-grab text-muted-foreground"
                  />
                  <StyleSwatch rule={rule} />
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left text-sm"
                    aria-expanded={selected === rule.id}
                    onClick={() => setSelected(selected === rule.id ? undefined : rule.id)}
                  >
                    <span className="block truncate">{summary}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {target}
                      {rule.stopIfTrue ? " · stops" : ""}
                    </span>
                    {issue === undefined ? null : (
                      <span role="alert" className="block text-xs text-destructive">
                        {issue}
                      </span>
                    )}
                  </button>
                  <Label htmlFor={switchId} className="sr-only">
                    Apply rule {index + 1}
                  </Label>
                  <Switch
                    id={switchId}
                    checked={rule.enabled}
                    disabled={disabled}
                    onCheckedChange={(on: boolean) => writeRule(rule.id, { enabled: flag(on) })}
                  />
                  <StudioInspectorActions
                    actions={[
                      {
                        label: "Move up",
                        disabled: disabled || index === 0,
                        onSelect: () => moveRule(index, index - 1),
                      },
                      {
                        label: "Move down",
                        disabled: disabled || index === rules.length - 1,
                        onSelect: () => moveRule(index, index + 1),
                      },
                      {
                        label: "Delete rule",
                        destructive: true,
                        disabled,
                        onSelect: () =>
                          write({
                            rules: ruleItems.filter(
                              (_, position) => position !== rawIndex(rule.id),
                            ),
                          }),
                      },
                    ]}
                  />
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {selectedRule === undefined ? null : (
        <RuleEditor
          key={selectedRule.id}
          idPrefix={`${idPrefix}-${ownId}-editor`}
          rule={selectedRule}
          context={context}
          fieldIdOf={fieldIdOf}
          referenceOf={referenceOf}
          queryFields={queryFields}
          disabled={disabled}
          onChange={(changes, remove) => writeRule(selectedRule.id, changes, remove)}
        />
      )}

      <section aria-labelledby={`${ownId}-columns`} className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h4 id={`${ownId}-columns`} className="text-sm font-medium">
            Number columns
          </h4>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || numberFields.length === 0 || formatItems.length >= 10}
            onClick={() =>
              write({
                formats: [
                  ...formatItems,
                  {
                    kind: "group",
                    properties: {
                      field: {
                        kind: "field_reference",
                        field: numberFields[0]!.reference as never,
                      },
                      kind: choice("data_bar"),
                      token: choice("info"),
                    },
                  },
                ],
              })
            }
          >
            <Icon name="plus" />
            Add
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Data bars and colour scales measure the rows on the page.
        </p>
        {columnFormats.map((format, index) => (
          <ColumnFormatEditor
            key={`${format.field}-${index}`}
            idPrefix={`${idPrefix}-${ownId}-column-${index}`}
            format={format}
            numberFields={numberFields}
            issue={conditionalColumnFormatIssue(format, facts)}
            disabled={disabled}
            onChange={(next) =>
              write({
                formats: formatItems.map((item, position) => (position === index ? next : item)),
              })
            }
            onRemove={() =>
              write({ formats: formatItems.filter((_, position) => position !== index) })
            }
          />
        ))}
      </section>
    </div>
  );
}

function TokenPicker({
  label,
  value,
  disabled,
  onChange,
}: Readonly<{
  label: string;
  value: ConditionalFormatToken;
  disabled: boolean;
  onChange: (token: ConditionalFormatToken) => void;
}>): ReactElement {
  return (
    <ToggleGroup
      aria-label={label}
      variant="outline"
      size="sm"
      value={[value]}
      disabled={disabled}
      onValueChange={(next) => {
        const token = conditionalFormatTokens.find((candidate) => candidate === next[0]);
        if (token !== undefined) onChange(token);
      }}
    >
      {conditionalFormatTokens.map((token) => (
        <ToggleGroupItem key={token} value={token} aria-label={tokenLabels[token]}>
          <span aria-hidden className={cn("size-3 rounded-full", tokenSwatches[token])} />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function SwitchRow({
  id,
  label,
  checked,
  disabled,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}>): ReactElement {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

/** One rule's condition, target and style. */
function RuleEditor({
  idPrefix,
  rule,
  context,
  fieldIdOf,
  referenceOf,
  queryFields,
  disabled,
  onChange,
}: Readonly<{
  idPrefix: string;
  rule: ConditionalFormatRule;
  context: StudioConditionControlsContext;
  fieldIdOf: (reference: string) => string | undefined;
  referenceOf: (fieldId: string) => string | undefined;
  queryFields: StudioQueryChoice["fields"];
  disabled: boolean;
  onChange: (changes: Properties, remove?: readonly string[]) => void;
}>): ReactElement {
  const reading = readStudioQueryFilter(rule.condition as InlineQueryFilter, fieldIdOf);
  const { style } = rule;
  const cells = rule.target.kind === "cells" ? rule.target.fields : [];
  const [cellChoice, setCellChoice] = useState("");
  return (
    <section
      aria-label={`Rule ${rule.id}`}
      className="space-y-3 rounded-md border bg-muted/30 p-3"
      data-vortex-formatting-rule-editor={rule.id}
    >
      {reading.kind === "unreadable" ? (
        <p role="note" className="text-sm">
          {reading.reason} The condition stays as it is.
        </p>
      ) : (
        <fieldset disabled={disabled} className="min-w-0">
          <StudioConditionControls
            label="Rule condition"
            context={context}
            {...(reading.condition === undefined ? {} : { value: reading.condition })}
            onChange={(next: ConditionNode | undefined, validation) => {
              if (next === undefined || !validation.isValid) return;
              const written = writeStudioQueryFilter(next, referenceOf);
              if (written === undefined || written === null) return;
              onChange({ condition: { kind: "condition", condition: written as never } });
            }}
          />
        </fieldset>
      )}
      <div className="space-y-1">
        <Label className="text-sm">Formats</Label>
        <ToggleGroup
          aria-label="Formats"
          variant="outline"
          size="sm"
          className="w-full"
          value={[rule.target.kind]}
          disabled={disabled}
          onValueChange={(next) => {
            if (next[0] === "row") onChange({ target: choice("row") }, ["fields"]);
            else if (next[0] === "cells")
              onChange({ target: choice("cells"), fields: { kind: "list", items: [] } });
          }}
        >
          <ToggleGroupItem value="row" className="flex-1">
            Whole row
          </ToggleGroupItem>
          <ToggleGroupItem value="cells" className="flex-1">
            Chosen cells
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {rule.target.kind === "cells" ? (
        <div className="space-y-1">
          <div className="flex flex-wrap gap-1">
            {cells.map((field) => (
              <Badge key={field} variant="outline" className="gap-1">
                {queryFields.find((candidate) => candidate.reference === field)?.label ?? field}
                <button
                  type="button"
                  aria-label={`Remove ${field}`}
                  disabled={disabled}
                  onClick={() =>
                    onChange({
                      fields: {
                        kind: "list",
                        items: cells
                          .filter((candidate) => candidate !== field)
                          .map((candidate) => ({
                            kind: "field_reference",
                            field: candidate as never,
                          })),
                      },
                    })
                  }
                >
                  <Icon name="close" className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
          <StudioReferencePicker
            aria-label="Add a cell"
            value={cellChoice}
            unset="Add a cell"
            disabled={disabled}
            options={queryFields
              .filter((field) => !cells.includes(field.reference))
              .map((field) => ({ value: field.reference, label: field.label }))}
            onChange={(reference) => {
              setCellChoice("");
              if (reference === "") return;
              onChange({
                fields: {
                  kind: "list",
                  items: [...cells, reference].map((field) => ({
                    kind: "field_reference",
                    field: field as never,
                  })),
                },
              });
            }}
          />
        </div>
      ) : null}
      <div className="space-y-1">
        <Label className="text-sm">Colour</Label>
        <TokenPicker
          label="Colour"
          value={style.token}
          disabled={disabled}
          onChange={(token) => onChange({ token: choice(token) })}
        />
      </div>
      <SwitchRow
        id={`${idPrefix}-tint`}
        label="Background tint"
        checked={style.tint}
        disabled={disabled}
        onChange={(on) => onChange({ tint: flag(on) })}
      />
      <SwitchRow
        id={`${idPrefix}-text`}
        label="Text colour"
        checked={style.text}
        disabled={disabled}
        onChange={(on) => onChange({ text_colour: flag(on) })}
      />
      <SwitchRow
        id={`${idPrefix}-bold`}
        label="Bold"
        checked={style.bold}
        disabled={disabled}
        onChange={(on) => onChange({ bold: flag(on) })}
      />
      <SwitchRow
        id={`${idPrefix}-strike`}
        label="Strike through"
        checked={style.strike}
        disabled={disabled}
        onChange={(on) => onChange({ strike: flag(on) })}
      />
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-icon`} className="text-sm">
            Icon
          </Label>
          <NativeSelect
            id={`${idPrefix}-icon`}
            size="sm"
            className="w-full"
            value={style.icon ?? "none"}
            disabled={disabled}
            onChange={(event) => onChange({ icon: choice(event.target.value) })}
          >
            <NativeSelectOption value="none">None</NativeSelectOption>
            {conditionalFormatIcons.map((icon) => (
              <NativeSelectOption key={icon} value={icon}>
                {iconLabels[icon]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-badge`} className="text-sm">
            Label
          </Label>
          <Input
            id={`${idPrefix}-badge`}
            className="h-8"
            maxLength={30}
            defaultValue={style.badgeLabel ?? ""}
            disabled={disabled}
            onBlur={(event) => {
              const label = event.target.value.trim();
              if (label === (style.badgeLabel ?? "")) return;
              if (label === "") onChange({}, ["badge_label"]);
              else onChange({ badge_label: text(label) });
            }}
          />
        </div>
      </div>
      <SwitchRow
        id={`${idPrefix}-stop`}
        label="Stop if true"
        checked={rule.stopIfTrue}
        disabled={disabled}
        onChange={(on) => onChange({ stop_if_true: flag(on) })}
      />
    </section>
  );
}

/** One number column drawn as a data bar or a three-point colour scale. */
function ColumnFormatEditor({
  idPrefix,
  format,
  numberFields,
  issue,
  disabled,
  onChange,
  onRemove,
}: Readonly<{
  idPrefix: string;
  format: ConditionalColumnFormat;
  numberFields: StudioQueryChoice["fields"];
  issue: string | undefined;
  disabled: boolean;
  onChange: (next: Value) => void;
  onRemove: () => void;
}>): ReactElement {
  const base: Properties = {
    field: { kind: "field_reference", field: format.field as never },
  };
  const asBar = (token: ConditionalFormatToken): Value => ({
    kind: "group",
    properties: { ...base, kind: choice("data_bar"), token: choice(token) },
  });
  const asScale = (
    tokens: readonly [ConditionalFormatToken, ConditionalFormatToken, ConditionalFormatToken],
  ): Value => ({
    kind: "group",
    properties: {
      ...base,
      kind: choice("colour_scale"),
      low_token: choice(tokens[0]),
      mid_token: choice(tokens[1]),
      high_token: choice(tokens[2]),
    },
  });
  const current = (): Value =>
    format.kind === "data_bar" ? asBar(format.token) : asScale(format.tokens);
  return (
    <div className="space-y-2 rounded-md border p-2" data-vortex-column-format={format.field}>
      <div className="flex items-center gap-2">
        <StudioReferencePicker
          id={`${idPrefix}-field`}
          aria-label="Number column"
          value={format.field}
          disabled={disabled}
          options={numberFields.map((field) => ({ value: field.reference, label: field.label }))}
          onChange={(reference) => {
            const next = current();
            if (next.kind === "group")
              onChange({
                kind: "group",
                properties: {
                  ...next.properties,
                  field: { kind: "field_reference", field: reference as never },
                },
              });
          }}
        />
        <StudioInspectorActions
          actions={[{ label: "Remove", destructive: true, disabled, onSelect: onRemove }]}
        />
      </div>
      <ToggleGroup
        aria-label="Format"
        variant="outline"
        size="sm"
        className="w-full"
        value={[format.kind]}
        disabled={disabled}
        onValueChange={(next) => {
          if (next[0] === "data_bar") onChange(asBar("info"));
          else if (next[0] === "colour_scale")
            onChange(asScale(["destructive", "warning", "success"]));
        }}
      >
        <ToggleGroupItem value="data_bar" className="flex-1">
          Data bar
        </ToggleGroupItem>
        <ToggleGroupItem value="colour_scale" className="flex-1">
          Colour scale
        </ToggleGroupItem>
      </ToggleGroup>
      {format.kind === "data_bar" ? (
        <TokenPicker
          label="Bar colour"
          value={format.token}
          disabled={disabled}
          onChange={(token) => onChange(asBar(token))}
        />
      ) : (
        (["Low", "Middle", "High"] as const).map((label, position) => (
          <div key={label} className="flex items-center justify-between gap-2">
            <span className="text-sm">{label}</span>
            <TokenPicker
              label={`${label} colour`}
              value={format.tokens[position]!}
              disabled={disabled}
              onChange={(token) => {
                const tokens = [...format.tokens] as [
                  ConditionalFormatToken,
                  ConditionalFormatToken,
                  ConditionalFormatToken,
                ];
                tokens[position] = token;
                onChange(asScale(tokens));
              }}
            />
          </div>
        ))
      )}
      {issue === undefined ? null : (
        <p role="alert" className="text-xs text-destructive">
          {issue}
        </p>
      )}
    </div>
  );
}
