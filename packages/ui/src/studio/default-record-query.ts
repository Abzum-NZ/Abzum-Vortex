import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import { sourceNames } from "./composition-references";
import { uniqueKey } from "./application-structure-common";

/** The one default list query, used by generated pages and a grid's record-type data choice. */
export const ensureStudioRecordQuery = (
  source: ApplicationSourceDocument,
  qualified: string,
  selected?: readonly string[],
): Readonly<{ reference: string; select: readonly string[]; created: boolean }> => {
  const separator = qualified.lastIndexOf(":");
  const module = source.body.modules.find((entry) => entry.key === qualified.slice(0, separator));
  const record = module?.record_types.find((entry) => entry.key === qualified.slice(separator + 1));
  if (module === undefined || record === undefined)
    throw new Error("STUDIO_RECORD_QUERY_TYPE_MISSING");
  const existing = module.queries.find(
    (query) =>
      query.record_type === record.key &&
      query.inputs.length === 0 &&
      query.filter === null &&
      query.group_by.length === 0 &&
      query.aggregates.length === 0 &&
      (query.select.length === 0 || query.select.includes(record.title_field)),
  );
  if (existing !== undefined)
    return {
      reference: `${module.key}:${existing.key}`,
      select:
        existing.select.length === 0 ? record.fields.map((field) => field.key) : existing.select,
      created: false,
    };
  if (module.queries.length >= 100) throw new Error("STUDIO_RECORD_QUERY_LIMIT");
  const label = `All ${record.plural_name.toLowerCase()}`;
  const key = uniqueKey(label, "", new Set(module.queries.map((query) => query.key)), 40);
  const query: (typeof module.queries)[number] = {
    id: uniqueKey(key, "qry_", sourceNames(source), 160),
    key,
    label,
    exposure: "private",
    record_type: record.key,
    inputs: [],
    select: [...(selected ?? record.fields.map((field) => field.key))],
    filter: null,
    group_by: [],
    aggregates: [],
    sort: [{ field: record.title_field, direction: "ascending" }],
    page_size: 40,
    relationship_hops: 0,
  } as (typeof module.queries)[number];
  module.queries.push(query);
  return { reference: `${module.key}:${key}`, select: query.select, created: true };
};

/** A picker command becomes an ordinary query before any composition is stored. */
export const resolveStudioDataQuery = (
  source: ApplicationSourceDocument,
  reference: string | null,
): string | null =>
  reference?.startsWith("record:") === true
    ? ensureStudioRecordQuery(source, reference.slice("record:".length)).reference
    : reference;
