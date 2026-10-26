import type { RecordsTableRowFormat } from "@vortex/platform/schema";
import type { DefinitionRenderErrorLocation } from "../definition-error";
import {
  fail,
  requireExactKeys,
  requireFieldKey,
  requireNonEmptyString,
  requireRecord,
} from "./payload-parse";

/*
 * The parser of the formatting a table's rows carry: the style keys and measures of one row. The
 * styles and column formats the table's features name are parsed with the platform's projection
 * schema. Only semantic tokens and the closed icon set are accepted, so a payload can never carry
 * a colour or markup of its own.
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
