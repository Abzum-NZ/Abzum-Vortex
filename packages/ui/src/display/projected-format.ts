import {
  conditionalFormatIcons,
  conditionalFormatTokens,
  type ConditionalFormatStyle,
  type ConditionalFormattingProjection,
  type RecordsTableRowFormat,
} from "@vortex/platform/schema";
import type { DefinitionRenderErrorLocation } from "../definition-error";
import {
  fail,
  requireArray,
  requireExactKeys,
  requireFieldKey,
  requireNonEmptyString,
  requireRecord,
} from "./projected-data";

/*
 * The parsers of a Records table's formatting payload: the style keys and measures each row
 * carries and the styles and column formats the table's features name. Only semantic tokens and
 * the closed icon set are accepted, so a payload can never carry a colour or markup of its own.
 */

/** A row's formatting: style keys of the row and its cells, and measures between 0 and 1. */
export const parseRowFormat = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): RecordsTableRowFormat => {
  const record = requireRecord(value, "A row format must be an object", location);
  requireExactKeys(record, ["row", "cells", "measures"], location);
  const row =
    record.row === undefined
      ? undefined
      : requireNonEmptyString(record.row, "A row style key must be text", location);
  const keyed = <Value>(
    entry: unknown,
    read: (item: unknown) => Value,
  ): Readonly<Record<string, Value>> | undefined => {
    if (entry === undefined) return undefined;
    const items = requireRecord(entry, "Row format entries must be an object", location);
    return Object.freeze(
      Object.fromEntries(
        Object.entries(items).map(([key, item]) => [
          requireFieldKey(key, "A row format names a field", location),
          read(item),
        ]),
      ),
    );
  };
  const cells = keyed(record.cells, (item) =>
    requireNonEmptyString(item, "A cell style key must be text", location),
  );
  const measures = keyed(record.measures, (item) =>
    typeof item === "number" && item >= 0 && item <= 1
      ? item
      : fail("A measure lies between 0 and 1", location),
  );
  return Object.freeze({
    ...(row === undefined ? {} : { row }),
    ...(cells === undefined ? {} : { cells }),
    ...(measures === undefined ? {} : { measures }),
  });
};

const requireToken = (value: unknown, location: DefinitionRenderErrorLocation) =>
  conditionalFormatTokens.find((token) => token === value) ??
  fail("A format names an unknown colour", location);

const parseFormatStyle = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): ConditionalFormatStyle => {
  const record = requireRecord(value, "A format style must be an object", location);
  requireExactKeys(
    record,
    ["token", "tint", "text", "bold", "strike", "icon", "badgeLabel"],
    location,
  );
  const flag = (entry: unknown): boolean =>
    typeof entry === "boolean" ? entry : fail("A format switch must be yes or no", location);
  const icon =
    record.icon === undefined
      ? undefined
      : (conditionalFormatIcons.find((candidate) => candidate === record.icon) ??
        fail("A format names an unknown icon", location));
  const badgeLabel =
    record.badgeLabel === undefined
      ? undefined
      : requireNonEmptyString(record.badgeLabel, "A format label must be text", location);
  return Object.freeze({
    token: requireToken(record.token, location),
    tint: flag(record.tint),
    text: flag(record.text),
    bold: flag(record.bold),
    strike: flag(record.strike),
    ...(icon === undefined ? {} : { icon }),
    ...(badgeLabel === undefined ? {} : { badgeLabel }),
  });
};

/** The styles a board's cards name, keyed by rule: each is a closed style of semantic tokens. */
export const parseFormatStyles = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): Readonly<Record<string, ConditionalFormatStyle>> =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(requireRecord(value, "Projected format styles are invalid", location)).map(
        ([key, style]) => [key, parseFormatStyle(style, location)],
      ),
    ),
  );

/** The styles a page's rows name and its numeric columns' formats. */
export const parseConditionalFormatting = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): ConditionalFormattingProjection => {
  const record = requireRecord(value, "Projected formatting is invalid", location);
  requireExactKeys(record, ["styles", "columns"], location);
  const styles = requireRecord(record.styles, "Projected format styles are invalid", location);
  const columns = requireRecord(record.columns, "Projected column formats are invalid", location);
  return Object.freeze({
    styles: Object.freeze(
      Object.fromEntries(
        Object.entries(styles).map(([key, style]) => [key, parseFormatStyle(style, location)]),
      ),
    ),
    columns: Object.freeze(
      Object.fromEntries(
        Object.entries(columns).map(([key, column]) => {
          const format = requireRecord(column, "A column format must be an object", location);
          const field = requireFieldKey(key, "A column format names a field", location);
          if (format.kind === "data_bar") {
            requireExactKeys(format, ["kind", "token"], location);
            return [
              field,
              Object.freeze({
                kind: "data_bar" as const,
                token: requireToken(format.token, location),
              }),
            ];
          }
          requireExactKeys(format, ["kind", "tokens"], location);
          const tokens = requireArray(format.tokens, "A colour scale has three colours", location);
          if (format.kind !== "colour_scale" || tokens.length !== 3)
            fail("A column format is a data bar or a colour scale", location);
          return [
            field,
            Object.freeze({
              kind: "colour_scale" as const,
              tokens: Object.freeze([
                requireToken(tokens[0], location),
                requireToken(tokens[1], location),
                requireToken(tokens[2], location),
              ] as const),
            }),
          ];
        }),
      ),
    ),
  });
};
