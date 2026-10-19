"use client";

import type { ReactElement } from "react";
import type {
  ConditionalColumnFormatProjection,
  ConditionalFormatIcon,
  ConditionalFormatStyle,
  ConditionalFormatToken,
  VortexIconName,
} from "@vortex/platform/schema";
import { Badge } from "../../components/badge";
import { Icon } from "../../icons/icon";
import { cn } from "../../lib/utils";
import type { DisplayRow } from "../projected-data";
import type { GridColumn } from "../table-layout";
import type {
  GridCellDecorationToken,
  GridFeatureCellProps,
  GridFeatureColumnProps,
  GridFeatureContext,
  GridFeatureModule,
} from "./registry";

/** A token's background tint; every token is a semantic theme colour of the app's theme preset. */
const tintClasses: Readonly<Record<ConditionalFormatToken, string>> = {
  success: "bg-success/10",
  warning: "bg-warning/10",
  info: "bg-info/10",
  destructive: "bg-destructive/10",
  muted: "bg-muted",
};

/** A data bar's fill, a stronger tint of the token so the value stays readable over it. */
const barClasses: Readonly<Record<ConditionalFormatToken, string>> = {
  success: "bg-success/20",
  warning: "bg-warning/20",
  info: "bg-info/20",
  destructive: "bg-destructive/20",
  muted: "bg-muted-foreground/15",
};

const iconTextClasses: Readonly<Record<ConditionalFormatToken, string>> = {
  success: "text-success",
  warning: "text-warning",
  info: "text-info",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

const textTokens: Readonly<Record<ConditionalFormatToken, GridCellDecorationToken>> = {
  success: "text_success",
  warning: "text_warning",
  info: "text_info",
  destructive: "text_destructive",
  muted: "text_muted",
};

const iconNames: Readonly<Record<ConditionalFormatIcon, VortexIconName>> = {
  alert: "triangle-alert",
  check: "check",
  info: "info",
  clock: "clock",
  flag: "flag",
  star: "star",
  x: "close",
  arrow_up: "arrow-up",
  arrow_down: "arrow-down",
};

/** What an icon without a label is read out as, so its meaning never rests on the glyph alone. */
const iconWords: Readonly<Record<ConditionalFormatIcon, string>> = {
  alert: "Needs attention",
  check: "Done",
  info: "Note",
  clock: "Due",
  flag: "Flagged",
  star: "Starred",
  x: "Not done",
  arrow_up: "Up",
  arrow_down: "Down",
};

const keyed = <Value,>(
  record: Readonly<Record<string, Value>> | undefined,
  field: string,
): Value | undefined => {
  if (record === undefined) return undefined;
  const key = Object.keys(record).find(
    (candidate) => candidate.toLowerCase() === field.toLowerCase(),
  );
  return key === undefined ? undefined : record[key];
};

/**
 * The style a cell shows: the rule of its own cell, else the rule of its row. The server decided
 * both under the viewer's field policy; the browser only looks the style key up.
 */
const styleOf = (
  context: GridFeatureContext,
  row: DisplayRow,
  column: GridColumn,
): Readonly<{ style: ConditionalFormatStyle; own: boolean }> | undefined => {
  const styles = context.features.conditionalFormatting?.styles;
  if (styles === undefined || row.format === undefined) return undefined;
  const cellKey = keyed(row.format.cells, column.key);
  const cellStyle = cellKey === undefined ? undefined : styles[cellKey];
  if (cellStyle !== undefined) return { style: cellStyle, own: true };
  const rowStyle = row.format.row === undefined ? undefined : styles[row.format.row];
  return rowStyle === undefined ? undefined : { style: rowStyle, own: false };
};

const columnFormatOf = (
  context: GridFeatureContext,
  column: GridColumn,
): ConditionalColumnFormatProjection | undefined =>
  keyed(context.features.conditionalFormatting?.columns, column.key);

/** The tint step of a colour scale: the low, middle or high colour by the page's range. */
const scaleToken = (
  format: Extract<ConditionalColumnFormatProjection, { kind: "colour_scale" }>,
  measure: number,
): ConditionalFormatToken => format.tokens[measure < 1 / 3 ? 0 : measure < 2 / 3 ? 1 : 2];

/**
 * A formatted cell: the tint over the whole cell, the rule's icon (read out by its label or its
 * word) and badge, and a numeric column's data bar. A row's icon and badge show once, in its first
 * column. Inside the grid the wrapper reaches the cell's edges, so a row tint reads as one band.
 */
function ConditionalFormatCell({
  context,
  row,
  column,
  children,
}: GridFeatureCellProps): ReactElement {
  const styled = styleOf(context, row, column);
  const format = columnFormatOf(context, column);
  const measure = format === undefined ? undefined : keyed(row.format?.measures, column.key);
  if (styled === undefined && measure === undefined) return <>{children}</>;
  const style = styled?.style;
  const marked =
    style !== undefined && (styled?.own === true || context.columns[0]?.key === column.key);
  const tint =
    format?.kind === "colour_scale" && measure !== undefined
      ? tintClasses[scaleToken(format, measure)]
      : style?.tint === true
        ? tintClasses[style.token]
        : undefined;
  return (
    <span
      data-vortex-format={styled === undefined ? undefined : styled.own ? "cell" : "row"}
      className={cn(
        "relative flex min-w-0 flex-1 items-center gap-1.5 self-stretch",
        "[[data-grid-cell]_&]:-mx-2 [[data-grid-cell]_&]:px-2",
        tint,
      )}
    >
      {format?.kind === "data_bar" && measure !== undefined ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-y-1 left-0 rounded-sm",
            barClasses[format.token],
          )}
          style={{ width: `${Math.round(measure * 100)}%` }}
        />
      ) : null}
      {marked && style?.icon !== undefined ? (
        <span
          className={cn(
            "relative inline-flex shrink-0",
            style.text && iconTextClasses[style.token],
          )}
        >
          <Icon name={iconNames[style.icon]} className="size-3.5" />
          {style.badgeLabel === undefined ? (
            <span className="sr-only">{iconWords[style.icon]}: </span>
          ) : null}
        </span>
      ) : null}
      <span className="relative min-w-0 truncate">{children}</span>
      {marked && style?.badgeLabel !== undefined ? (
        <Badge variant="outline" className={cn("relative shrink-0", tintClasses[style.token])}>
          {style.badgeLabel}
        </Badge>
      ) : null}
    </span>
  );
}

/** A column drawn as bars or a scale says its range is this page's, not every record's. */
function ConditionalFormatHeading({
  context,
  column,
}: GridFeatureColumnProps): ReactElement | null {
  return columnFormatOf(context, column) === undefined ? null : (
    <span className="text-xs font-normal text-muted-foreground">on this page</span>
  );
}

export const gridFeature: GridFeatureModule = {
  cellDecoration: (context, row, column) => {
    const style = styleOf(context, row, column)?.style;
    if (style === undefined) return undefined;
    const tokens: GridCellDecorationToken[] = [
      ...(style.text ? [textTokens[style.token]] : []),
      ...(style.bold ? (["bold"] as const) : []),
      ...(style.strike ? (["strike"] as const) : []),
    ];
    return tokens.length === 0 ? undefined : tokens;
  },
  CellAdornment: ConditionalFormatCell,
  HeaderAdornment: ConditionalFormatHeading,
};
