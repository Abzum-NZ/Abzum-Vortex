import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import { sourceNames } from "./composition-references";
import { uniqueKey } from "./application-structure-common";

type SourceModule = ApplicationSourceDocument["body"]["modules"][number];
type SourceQuery = SourceModule["queries"][number];

/**
 * A record type's default list query: the existing unfiltered one, otherwise the "All <records>"
 * query it would get, or undefined when its Module has no room for another query.
 */
export const studioDefaultRecordQuery = (
  source: ApplicationSourceDocument,
  module: SourceModule,
  record: SourceModule["record_types"][number],
  selected?: readonly string[],
): SourceQuery | undefined => {
  const existing = module.queries.find(
    (query) =>
      query.record_type === record.key &&
      query.inputs.length === 0 &&
      query.filter === null &&
      query.group_by.length === 0 &&
      query.aggregates.length === 0 &&
      (query.select.length === 0 || query.select.includes(record.title_field)),
  );
  if (existing !== undefined) return existing;
  if (module.queries.length >= 100) return undefined;
  const label = `All ${record.plural_name.toLowerCase()}`;
  const key = uniqueKey(label, "", new Set(module.queries.map((query) => query.key)), 40);
  return {
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
  } as SourceQuery;
};

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
  const query = studioDefaultRecordQuery(source, module, record, selected);
  if (query === undefined) throw new Error("STUDIO_RECORD_QUERY_LIMIT");
  const created = !module.queries.includes(query);
  if (created) module.queries.push(query);
  return {
    reference: `${module.key}:${query.key}`,
    select: query.select.length === 0 ? record.fields.map((field) => field.key) : query.select,
    created,
  };
};

/** A picker command becomes an ordinary query before any composition is stored. */
export const resolveStudioDataQuery = (
  source: ApplicationSourceDocument,
  reference: string | null,
): string | null =>
  reference?.startsWith("record:") === true
    ? ensureStudioRecordQuery(source, reference.slice("record:".length)).reference
    : reference;
