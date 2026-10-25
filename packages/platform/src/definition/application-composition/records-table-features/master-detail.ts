import { z } from "zod";
import type { ComponentSettingValue } from "../block-property-schema";
import { checkQueryBindings } from "../query-binding-check";
import { readQueryBindings, type QueryBindingsRead } from "../query-bindings";
import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  optionalNumber,
  requiredFieldList,
  unreadable,
  type RecordsTableFeatureDefinition,
  type GridFeatureRefusal,
  type GridFeatureSettingsDeclaration,
} from "./shared";

/** The largest page of related records one expanded row reads at a time. */
export const RECORDS_TABLE_RELATED_RECORDS_MAXIMUM_PAGE_SIZE = 40;

/**
 * Master/detail: a row expands to the records of another record type that link to it, read through
 * a query of that record type whose input is bound to This row. `relationship` is the link from the
 * child record type to the table's record type, `childQuery` the query that reads the child records,
 * `childColumns` the fields of that query each related record shows and `childPageSize` how many it
 * reads at a time. Each part is absent until the builder names it, which the check refuses.
 */
export type RecordsTableMasterDetailSettings = Readonly<{
  relationship?: string;
  childQuery?: string;
  childColumns: readonly string[];
  childPageSize?: number;
  /** The child query's input bindings, through the one binding contract every data block uses. */
  bindings: QueryBindingsRead;
}>;

const settingRelationship = (
  value: ComponentSettingValue | undefined,
  path: string,
): string | undefined => {
  if (value === undefined) return undefined;
  if (value.kind !== "relationship_reference") return unreadable(path);
  return "relationshipId" in value ? String(value.relationshipId) : String(value.relationship);
};

const settingQuery = (
  value: ComponentSettingValue | undefined,
  path: string,
): string | undefined => {
  if (value === undefined) return undefined;
  if (value.kind !== "query_reference") return unreadable(path);
  return "queryId" in value ? String(value.queryId) : String(value.query);
};

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** The feature's setting group in the Table release, off by default. */
const featureSettings = {
  kind: "group",
  key: "master_detail",
  label: "Related records",
  help: "Expand a row to the records of another record type that link to it",
  required: false,
  defaultValue: {
    kind: "group",
    properties: {
      enabled: {
        kind: "boolean",
        value: false,
      },
      child_columns: {
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
      help: "Let people expand a row to its related records",
      required: false,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
    {
      kind: "relationship_reference",
      key: "relationship",
      label: "Link",
      help: "The link from the related record type to this table's record type",
      required: false,
    },
    {
      kind: "query_reference",
      key: "child_query",
      label: "Related records query",
      help: "The query that reads the related records; one input is bound to This row",
      required: false,
    },
    {
      shared: "query_parameters",
    },
    {
      kind: "list",
      key: "child_columns",
      label: "Related columns",
      help: "Fields of the related records query each related record shows",
      required: false,
      minimumItems: 0,
      maximumItems: 12,
      item: {
        kind: "field_reference",
        key: "field",
        label: "Field",
        help: "Field of the related records query",
        required: true,
      },
      defaultValue: {
        kind: "list",
        items: [],
      },
    },
    {
      kind: "number",
      key: "child_page_size",
      label: "Related records at a time",
      help: "How many related records an expanded row reads at a time, at most 40",
      required: false,
      integer: true,
      minimum: 1,
      maximum: 40,
    },
  ],
} as const satisfies GridFeatureSettingsDeclaration;

/** The feature's refusals and their business sentences. */
const featureRefusal: GridFeatureRefusal = {
  code: "definition_records_table_master_detail",
  order: 39,
  message: "Related records need a link from another record type to this table's records.",
  guidance:
    "Choose a link to this record type, a query of the linked records with an input bound to This row, and its columns, or turn Related records off.",
};

const positiveSchema = z.number().int().min(1);
const projectionSchema = z.object({ pageSize: positiveSchema }).strict().readonly();

export const recordsTableMasterDetailFeature: RecordsTableFeatureDefinition<
  RecordsTableMasterDetailSettings,
  "master_detail"
> &
  Readonly<{ property: "masterDetail"; projectionSchema: typeof projectionSchema }> = {
  key: "master_detail",
  property: "masterDetail",
  projectionSchema,
  settings: featureSettings,
  refusals: [featureRefusal],
  onBoard: "unsupported",
  label: "Related records",
  description: "Expand a row to the records linked to it",
  read: (group) => {
    if (!featureEnabled(group)) return { enabled: false };
    const relationship = settingRelationship(group["relationship"], "relationship");
    const childQuery = settingQuery(group["child_query"], "child_query");
    const childPageSize = optionalNumber(group["child_page_size"], "child_page_size");
    return {
      enabled: true,
      ...(relationship === undefined ? {} : { relationship }),
      ...(childQuery === undefined ? {} : { childQuery }),
      childColumns: requiredFieldList(group["child_columns"], "child_columns"),
      ...(childPageSize === undefined ? {} : { childPageSize }),
      bindings: readQueryBindings(group),
    };
  },
  // Every expanded row is read again under the viewer's current access: the projection only says
  // rows expand; a viewer who cannot read the related records sees the panel's neutral refusal.
  project: (state) =>
    state.enabled && state.childPageSize !== undefined
      ? { pageSize: state.childPageSize }
      : undefined,
  // A link from another record type to this one must exist; when on, the chosen link, the query
  // that reads its records, the columns that query selects, the page size and the query's input
  // bindings (one bound to This row) must all fit. Each refusal names the part that does not.
  check: (state, facts) => {
    const related = facts.relatedRecords;
    const noLink = featureNotPossible(
      featureRefusal,
      `Related records need a link from another record type to ${facts.recordTypeLabel || "this record type"}.`,
    );
    if (facts.grouped)
      return featureNotPossible(featureRefusal, "Rows that total records cannot expand.");
    const readable = related.links.filter((link) =>
      related.queries.some(
        (query) => !query.grouped && same(query.recordType, link.childRecordType),
      ),
    );
    if (!state.enabled) return readable.length === 0 ? noLink : featureAvailable;
    if (related.links.length === 0) return noLink;
    const link =
      state.relationship === undefined
        ? undefined
        : related.links.find((candidate) => same(candidate.relationship, state.relationship!));
    if (link === undefined)
      return featureNotPossible(
        featureRefusal,
        `Choose a link from another record type to ${facts.recordTypeLabel || "this record type"}.`,
      );
    const query =
      state.childQuery === undefined
        ? undefined
        : related.queries.find((candidate) => same(candidate.query, state.childQuery!));
    if (query === undefined)
      return featureNotPossible(
        featureRefusal,
        `Choose a query that reads ${link.childRecordTypeLabel}.`,
      );
    if (!same(query.recordType, link.childRecordType) || query.grouped)
      return featureNotPossible(
        featureRefusal,
        `${query.label} does not read ${link.childRecordTypeLabel}.`,
      );
    if (state.childPageSize !== undefined && state.childPageSize > query.maximumPageSize)
      return featureNotPossible(
        featureRefusal,
        `${query.label} allows at most ${query.maximumPageSize} related records at a time.`,
      );
    if (state.childColumns.length === 0)
      return featureNotPossible(
        featureRefusal,
        `Choose the columns of ${link.childRecordTypeLabel} to show.`,
      );
    for (const column of state.childColumns)
      if (!query.fields.some((field) => same(field.field, column)))
        return featureNotPossible(featureRefusal, `A chosen column is not in ${query.label}.`);
    if (
      new Set(state.childColumns.map((column) => column.toLowerCase())).size !==
      state.childColumns.length
    )
      return featureNotPossible(featureRefusal, "Choose each related column once.");
    if (state.childPageSize === undefined)
      return featureNotPossible(
        featureRefusal,
        "Choose how many related records to show at a time.",
      );
    if (
      !Number.isInteger(state.childPageSize) ||
      state.childPageSize < 1 ||
      state.childPageSize > RECORDS_TABLE_RELATED_RECORDS_MAXIMUM_PAGE_SIZE
    )
      return featureNotPossible(
        featureRefusal,
        `Show at most ${RECORDS_TABLE_RELATED_RECORDS_MAXIMUM_PAGE_SIZE} related records at a time.`,
      );
    // The child query's inputs bind through the one binding check, where This row is the row.
    const problem = checkQueryBindings(state.bindings, query.inputs, {
      ...related.page,
      blockLabel: query.label,
      rowFields: related.rowFields,
      rowRecordType: related.recordType,
    })[0];
    if (problem !== undefined) return featureNotPossible(featureRefusal, problem.sentence);
    const boundToRow =
      state.bindings.kind === "read" &&
      state.bindings.bindings.some((binding) => binding.source.kind === "this_row");
    return boundToRow
      ? featureAvailable
      : featureNotPossible(featureRefusal, `${query.label} needs an input bound to This row.`);
  },
};
