"use client";

import { useId, useMemo, useState, type DragEvent, type ReactElement } from "react";
import {
  recordsTableSettingMaximumItems,
  conditionalColumnFormatFieldTypes,
  conditionalColumnFormatIssue,
  conditionalFormatRuleIssue,
  type ConditionNode,
  type ConditionalColumnFormat,
  type ConditionalFormatRule,
  type ConditionalFormatToken,
  type InlineQueryFilter,
  type ModuleField,
  type RecordsTableConditionalFormattingSettings,
  type RecordsTableFeatureState,
  type RecordsTableQueryFacts,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import { Button } from "../../components/button";
import { Label } from "../../components/label";
import { Switch } from "../../components/switch";
import { ToggleGroup, ToggleGroupItem } from "../../components/toggle-group";
import { Icon } from "../../icons/icon";
import { cn } from "../../lib/utils";
import { StudioConditionControls } from "../condition-controls";
import { createInitialStudioCondition, describeCondition } from "../condition-model";
import type { StudioConditionControlsContext } from "../condition-model";
import type { StudioQueryChoice } from "../contextual-palette";
import {
  ConditionalFormatStyleControls,
  ConditionalFormatStyleSwatch,
  ConditionalFormatTokenPicker,
  conditionalFormatConditionContext,
  type ConditionalFormatRuleChange,
} from "../conditional-format-rule-controls";
import { StudioInspectorActions } from "../studio-inspector-actions";
import { StudioReferencePicker } from "../studio-reference-picker";
import { readStudioQueryFilter, writeStudioQueryFilter } from "../studio-query-filter";

type Value = SourceBlockPropertyValueContract;
type GroupValue = Extract<Value, { kind: "group" }>;
type Properties = Readonly<Record<string, Value>>;

const text = (value: string): Value => ({ kind: "text", value });
const flag = (value: boolean): Value => ({ kind: "boolean", value });
const choice = (value: string): Value => ({ kind: "choice", value });
const propertiesOf = (value: Value | undefined): Properties =>
  value?.kind === "group" ? value.properties : {};
const itemsOf = (value: Value | undefined): readonly Value[] =>
  value?.kind === "list" ? value.items : [];

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
  board,
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
  /** The table is in Board mode: rules colour whole cards and there are no number columns. */
  board: boolean;
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

  // A board's rules read every field of its record type, so they are judged against those.
  const ruleFacts = board && facts.board !== undefined ? { fields: facts.board.fields } : facts;
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
  const context = useMemo(() => conditionalFormatConditionContext(shown), [shown]);
  const fieldIdOf = (reference: string): string | undefined =>
    shown.find((field) => `${recordType}.${field.key}` === reference)?.fieldId;
  const referenceOf = (fieldId: string): string | undefined => {
    const field = shown.find((candidate) => candidate.fieldId === fieldId);
    return field === undefined ? undefined : `${recordType}.${field.key}`;
  };
  const fieldLabel = (reference: string): string =>
    queryFields.find((field) => field.reference === reference)?.label ?? "A removed item";

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
  // A column format is found in the authored list by its field (one format per field), never by
  // its place among readable formats.
  const formatIndex = (field: string): number =>
    formatItems.findIndex((item) => {
      const held = propertiesOf(item)["field"];
      return held?.kind === "field_reference" && String(held.field) === field;
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
    const used = new Set(
      ruleItems.flatMap((item) => {
        const held = propertiesOf(item)["rule_id"];
        return held?.kind === "text" ? [held.value] : [];
      }),
    );
    let number = ruleItems.length + 1;
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
  const availableNumberFields = numberFields.filter(
    (field) => !columnFormats.some((format) => format.field === field.reference),
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
            disabled={
              disabled ||
              initial === undefined ||
              ruleItems.length >=
                recordsTableSettingMaximumItems("features", "conditional_formatting", "rules")
            }
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
              const issue = conditionalFormatRuleIssue(rule, ruleFacts);
              const switchId = `${idPrefix}-${ownId}-rule-${index}`;
              const reading = readStudioQueryFilter(rule.condition as InlineQueryFilter, fieldIdOf);
              const summary =
                reading.kind === "read" && reading.condition !== undefined
                  ? describeCondition(reading.condition, context)
                  : "A removed item";
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
                    "flex items-start gap-2 rounded-md py-2",
                    selected === rule.id && "bg-accent text-accent-foreground",
                    !rule.enabled && "opacity-60",
                  )}
                >
                  <Icon
                    name="grip-vertical"
                    className="mt-1 size-4 shrink-0 cursor-grab text-muted-foreground"
                  />
                  <ConditionalFormatStyleSwatch style={rule.style} />
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left text-sm"
                    aria-expanded={selected === rule.id}
                    onClick={() => setSelected(selected === rule.id ? undefined : rule.id)}
                  >
                    <span className="block truncate">{summary}</span>
                    <span className="block truncate text-sm">
                      {target}
                      {rule.stopIfTrue ? " · stops" : ""}
                    </span>
                    {issue === undefined ? null : (
                      <span role="alert" className="block text-sm text-destructive">
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
                      { label: "Show me where", onSelect: () => setSelected(rule.id) },
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
          position={rules.indexOf(selectedRule) + 1}
          context={context}
          fieldIdOf={fieldIdOf}
          referenceOf={referenceOf}
          queryFields={queryFields}
          board={board}
          disabled={disabled}
          onChange={(changes, remove) => writeRule(selectedRule.id, changes, remove)}
        />
      )}

      {/* A board has no number columns: the section shows there only to remove formats it holds. */}
      {board && columnFormats.length === 0 ? null : (
        <section aria-labelledby={`${ownId}-columns`} className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h4 id={`${ownId}-columns`} className="text-sm font-medium">
              Number columns
            </h4>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={
                disabled ||
                board ||
                availableNumberFields.length === 0 ||
                formatItems.length >=
                  recordsTableSettingMaximumItems(
                    "features",
                    "conditional_formatting",
                    "column_formats",
                  )
              }
              onClick={() =>
                write({
                  formats: [
                    ...formatItems,
                    {
                      kind: "group",
                      properties: {
                        field: {
                          kind: "field_reference",
                          field: availableNumberFields[0]!.reference as never,
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
          <p className="text-sm text-muted-foreground">
            Data bars and colour scales measure the rows on the page.
          </p>
          {columnFormats.map((format, index) => (
            <ColumnFormatEditor
              key={`${format.field}-${index}`}
              idPrefix={`${idPrefix}-${ownId}-column-${index}`}
              format={format}
              numberFields={numberFields.filter(
                (field) =>
                  field.reference === format.field ||
                  !columnFormats.some((held) => held.field === field.reference),
              )}
              issue={conditionalColumnFormatIssue(format, facts)}
              disabled={disabled}
              onChange={(next) =>
                write({
                  formats: formatItems.map((item, position) =>
                    position === formatIndex(format.field) ? next : item,
                  ),
                })
              }
              onRemove={() =>
                write({
                  formats: formatItems.filter(
                    (_, position) => position !== formatIndex(format.field),
                  ),
                })
              }
            />
          ))}
        </section>
      )}
    </div>
  );
}

/** One rule's condition, target and style. */
function RuleEditor({
  idPrefix,
  rule,
  position,
  context,
  fieldIdOf,
  referenceOf,
  queryFields,
  board,
  disabled,
  onChange,
}: Readonly<{
  idPrefix: string;
  rule: ConditionalFormatRule;
  /** The rule's place in the list, as the builder sees it. */
  position: number;
  context: StudioConditionControlsContext;
  fieldIdOf: (reference: string) => string | undefined;
  referenceOf: (fieldId: string) => string | undefined;
  queryFields: StudioQueryChoice["fields"];
  board: boolean;
  disabled: boolean;
  onChange: (changes: Properties, remove?: readonly string[]) => void;
}>): ReactElement {
  const reading = readStudioQueryFilter(rule.condition as InlineQueryFilter, fieldIdOf);
  const savedCondition = JSON.stringify(rule.condition);
  const [conditionDraft, setConditionDraft] = useState<
    Readonly<{ saved: string; value: ConditionNode | undefined }> | undefined
  >(undefined);
  const currentCondition =
    conditionDraft?.saved === savedCondition
      ? conditionDraft.value
      : reading.kind === "read"
        ? reading.condition
        : undefined;
  if (conditionDraft !== undefined && conditionDraft.saved !== savedCondition)
    setConditionDraft(undefined);
  const writeChange = (change: ConditionalFormatRuleChange): void => {
    const changes: Record<string, Value> = {};
    const remove: string[] = [];
    if (change.target !== undefined) {
      changes["target"] = choice(change.target.kind);
      if (change.target.kind === "cells")
        changes["fields"] = {
          kind: "list",
          items: change.target.fields.map((field) => ({
            kind: "field_reference",
            field: field as never,
          })),
        };
      else remove.push("fields");
    }
    if (change.style !== undefined) {
      const next = change.style;
      changes["token"] = choice(next.token);
      changes["tint"] = flag(next.tint);
      changes["text_colour"] = flag(next.text);
      changes["bold"] = flag(next.bold);
      changes["strike"] = flag(next.strike);
      changes["icon"] = choice(next.icon ?? "none");
      if (next.badgeLabel === undefined) remove.push("badge_label");
      else changes["badge_label"] = text(next.badgeLabel);
    }
    if (change.stopIfTrue !== undefined) changes["stop_if_true"] = flag(change.stopIfTrue);
    onChange(changes, remove);
  };
  return (
    <section
      aria-label={`Rule ${position}`}
      className="space-y-3"
      data-vortex-formatting-rule-editor={rule.id}
    >
      {reading.kind === "unreadable" ? (
        <p role="note" className="text-sm">
          A removed item is used by this condition. Choose another field or remove the rule.
        </p>
      ) : (
        <fieldset disabled={disabled} className="min-w-0">
          <StudioConditionControls
            label="Rule condition"
            context={context}
            {...(currentCondition === undefined ? {} : { value: currentCondition })}
            onChange={(next: ConditionNode | undefined, validation) => {
              // Keep unfinished typed input editable without saving an invalid rule.
              setConditionDraft({ saved: savedCondition, value: next });
              if (next === undefined || !validation.isValid) return;
              const written = writeStudioQueryFilter(next, referenceOf);
              if (written === undefined || written === null) return;
              onChange({ condition: { kind: "condition", condition: written as never } });
            }}
          />
        </fieldset>
      )}
      <ConditionalFormatStyleControls
        idPrefix={idPrefix}
        target={rule.target}
        style={rule.style}
        stopIfTrue={rule.stopIfTrue}
        cellOptions={queryFields.map((field) => ({ value: field.reference, label: field.label }))}
        wholeRowOnly={board}
        disabled={disabled}
        onChange={writeChange}
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
    <div className="space-y-2 py-2" data-vortex-column-format={format.field}>
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
        <ConditionalFormatTokenPicker
          label="Bar colour"
          value={format.token}
          disabled={disabled}
          onChange={(token) => onChange(asBar(token))}
        />
      ) : (
        (["Low", "Middle", "High"] as const).map((label, position) => (
          <div key={label} className="flex items-center justify-between gap-2">
            <span className="text-sm">{label}</span>
            <ConditionalFormatTokenPicker
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
        <p role="alert" className="text-sm text-destructive">
          {issue}
        </p>
      )}
    </div>
  );
}
