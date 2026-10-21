"use client";

import { useState, type ReactElement } from "react";
import {
  conditionalFormatIcons,
  conditionalFormatTokens,
  conditionalFormattingDateParameters,
  type ConditionalFormatIcon,
  type ConditionalFormatRule,
  type ConditionalFormatStyle,
  type ConditionalFormatToken,
  type ConditionalFormattingDateParameter,
  type ModuleField,
} from "@vortex/platform/schema";
import { Badge } from "../components/badge";
import { Input } from "../components/input";
import { Label } from "../components/label";
import { NativeSelect, NativeSelectOption } from "../components/native-select";
import { Switch } from "../components/switch";
import { ToggleGroup, ToggleGroupItem } from "../components/toggle-group";
import { Icon } from "../icons/icon";
import { cn } from "../lib/utils";
import type { StudioConditionControlsContext } from "./condition-model";
import { StudioReferencePicker } from "./studio-reference-picker";

/**
 * The controls of one conditional-format rule that the Studio Formatting editor and a person's
 * Formatting dialog share: the style, the target and the labels and swatches that draw them. A
 * rule's condition is edited with the one condition controls; this file never holds a rule format
 * of its own, only the authored `ConditionalFormatRule` parts.
 */

export const conditionalFormatTokenLabels: Readonly<Record<ConditionalFormatToken, string>> = {
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
  destructive: "text-[color:color-mix(in_oklab,var(--destructive)_75%,var(--foreground))]",
  muted: "text-[color:color-mix(in_oklab,var(--muted-foreground)_85%,var(--foreground))]",
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

/** The relative dates a rule may compare a date with, as condition operands the controls offer. */
export const conditionalFormatDateOperands: StudioConditionControlsContext["allowedOperands"] =
  conditionalFormattingDateParameters.map((key) => ({
    operand: { source: "parameter" as const, key },
    label: dateLabels[key],
    role: "host_context" as const,
  }));

/**
 * What the condition controls offer a rule on the given fields: the fields themselves, the
 * relative dates, and fixed values. Studio passes the bound query's fields; a running grid passes
 * the fields the person may read.
 */
export const conditionalFormatConditionContext = (
  fields: readonly ModuleField[],
): StudioConditionControlsContext => ({
  allowedOperands: [
    ...fields.map((field) => ({
      operand: { source: "field" as const, fieldId: field.fieldId },
      field,
      label: field.label,
      role: "current_field" as const,
    })),
    ...conditionalFormatDateOperands,
  ],
  declaredFieldIds: fields.map((field) => String(field.fieldId)),
  parameterDeclarations: conditionalFormattingDateParameters.map((key) => ({
    key,
    type: "date" as const,
  })),
  allowLiteralValues: true,
});

/** A rule's style as the preview swatch draws it: the same token classes the grid uses. */
export function ConditionalFormatStyleSwatch({
  style,
}: Readonly<{ style: ConditionalFormatStyle }>): ReactElement {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-6 min-w-10 shrink-0 items-center justify-center gap-1 rounded-md border px-1.5 text-xs",
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

export function ConditionalFormatTokenPicker({
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
        <ToggleGroupItem key={token} value={token} aria-label={conditionalFormatTokenLabels[token]}>
          <span aria-hidden className={cn("size-3 rounded-full", tokenSwatches[token])} />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function ConditionalFormatSwitchRow({
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

/** What one edit of the target and style controls changes of a rule. */
export type ConditionalFormatRuleChange = Readonly<{
  target?: Readonly<{ kind: "row" }> | Readonly<{ kind: "cells"; fields: string[] }>;
  /** The whole next style. */
  style?: ConditionalFormatStyle;
  stopIfTrue?: boolean;
}>;

/**
 * A rule's target (the whole row or chosen cells), its colour, tint, text, weight, strike, icon,
 * label and stop switch. `cellOptions` are the cells a rule may target, spelled however the caller
 * identifies a field (a qualified reference in Studio, a field identity in a running grid). A
 * `wholeRowOnly` caller (a board, whose cards have no cells) is offered the target choice only while
 * a rule still targets cells, so it can be switched back to the whole row.
 */
export function ConditionalFormatStyleControls({
  idPrefix,
  target,
  style,
  stopIfTrue,
  cellOptions,
  wholeRowOnly = false,
  disabled,
  onChange,
}: Readonly<{
  idPrefix: string;
  target: ConditionalFormatRule["target"];
  style: ConditionalFormatStyle;
  stopIfTrue: boolean;
  cellOptions: readonly Readonly<{ value: string; label: string }>[];
  wholeRowOnly?: boolean;
  disabled: boolean;
  onChange: (change: ConditionalFormatRuleChange) => void;
}>): ReactElement {
  const cells = target.kind === "cells" ? target.fields : [];
  const [cellChoice, setCellChoice] = useState("");
  const cellLabel = (field: string): string =>
    cellOptions.find((candidate) => candidate.value === field)?.label ?? field;
  const withStyle = (changes: Partial<ConditionalFormatStyle>): void =>
    onChange({ style: { ...style, ...changes } });
  return (
    <>
      {wholeRowOnly && target.kind === "row" ? null : (
        <div className="space-y-1">
          <Label className="text-sm">Formats</Label>
          <ToggleGroup
            aria-label="Formats"
            variant="outline"
            size="sm"
            className="w-full"
            value={[target.kind]}
            disabled={disabled}
            onValueChange={(next) => {
              if (next[0] === "row") onChange({ target: { kind: "row" } });
              else if (next[0] === "cells") onChange({ target: { kind: "cells", fields: [] } });
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
      )}
      {target.kind === "cells" ? (
        <div className="space-y-1">
          <div className="flex flex-wrap gap-1">
            {cells.map((field) => (
              <Badge key={field} variant="outline" className="gap-1">
                {cellLabel(field)}
                <button
                  type="button"
                  aria-label={`Remove ${cellLabel(field)}`}
                  disabled={disabled}
                  onClick={() =>
                    onChange({
                      target: {
                        kind: "cells",
                        fields: cells.filter((candidate) => candidate !== field),
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
            options={cellOptions.filter((option) => !cells.includes(option.value))}
            onChange={(reference) => {
              setCellChoice("");
              if (reference === "") return;
              onChange({ target: { kind: "cells", fields: [...cells, reference] } });
            }}
          />
        </div>
      ) : null}
      <div className="space-y-1">
        <Label className="text-sm">Colour</Label>
        <ConditionalFormatTokenPicker
          label="Colour"
          value={style.token}
          disabled={disabled}
          onChange={(token) => withStyle({ token })}
        />
      </div>
      <ConditionalFormatSwitchRow
        id={`${idPrefix}-tint`}
        label="Background tint"
        checked={style.tint}
        disabled={disabled}
        onChange={(on) => withStyle({ tint: on })}
      />
      <ConditionalFormatSwitchRow
        id={`${idPrefix}-text`}
        label="Text colour"
        checked={style.text}
        disabled={disabled}
        onChange={(on) => withStyle({ text: on })}
      />
      <ConditionalFormatSwitchRow
        id={`${idPrefix}-bold`}
        label="Bold"
        checked={style.bold}
        disabled={disabled}
        onChange={(on) => withStyle({ bold: on })}
      />
      <ConditionalFormatSwitchRow
        id={`${idPrefix}-strike`}
        label="Strike through"
        checked={style.strike}
        disabled={disabled}
        onChange={(on) => withStyle({ strike: on })}
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
            onChange={(event) => {
              const icon = conditionalFormatIcons.find(
                (candidate) => candidate === event.target.value,
              );
              withStyle({ icon });
            }}
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
              withStyle({ badgeLabel: label === "" ? undefined : label });
            }}
          />
        </div>
      </div>
      <ConditionalFormatSwitchRow
        id={`${idPrefix}-stop`}
        label="Stop if true"
        checked={stopIfTrue}
        disabled={disabled}
        onChange={(on) => onChange({ stopIfTrue: on })}
      />
    </>
  );
}
