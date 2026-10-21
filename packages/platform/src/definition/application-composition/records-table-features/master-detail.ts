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

const code = "definition_records_table_master_detail" as const;

export const recordsTableMasterDetailFeature: RecordsTableFeatureDefinition<RecordsTableMasterDetailSettings> =
  {
    key: "master_detail",
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
    // A link from another record type to this one must exist; when on, the chosen link, the query
    // that reads its records, the columns that query selects, the page size and the query's input
    // bindings (one bound to This row) must all fit. Each refusal names the part that does not.
    check: (state, facts) => {
      const related = facts.relatedRecords;
      const noLink = featureNotPossible(
        code,
        `Related records need a link from another record type to ${facts.recordTypeLabel || "this record type"}.`,
      );
      if (facts.grouped) return featureNotPossible(code, "Rows that total records cannot expand.");
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
          code,
          `Choose a link from another record type to ${facts.recordTypeLabel || "this record type"}.`,
        );
      const query =
        state.childQuery === undefined
          ? undefined
          : related.queries.find((candidate) => same(candidate.query, state.childQuery!));
      if (query === undefined)
        return featureNotPossible(code, `Choose a query that reads ${link.childRecordTypeLabel}.`);
      if (!same(query.recordType, link.childRecordType) || query.grouped)
        return featureNotPossible(
          code,
          `${query.label} does not read ${link.childRecordTypeLabel}.`,
        );
      if (state.childColumns.length === 0)
        return featureNotPossible(
          code,
          `Choose the columns of ${link.childRecordTypeLabel} to show.`,
        );
      for (const column of state.childColumns)
        if (!query.fields.some((field) => same(field.field, column)))
          return featureNotPossible(code, `A chosen column is not in ${query.label}.`);
      if (
        new Set(state.childColumns.map((column) => column.toLowerCase())).size !==
        state.childColumns.length
      )
        return featureNotPossible(code, "Choose each related column once.");
      if (state.childPageSize === undefined)
        return featureNotPossible(code, "Choose how many related records to show at a time.");
      if (
        !Number.isInteger(state.childPageSize) ||
        state.childPageSize < 1 ||
        state.childPageSize > RECORDS_TABLE_RELATED_RECORDS_MAXIMUM_PAGE_SIZE
      )
        return featureNotPossible(
          code,
          `Show at most ${RECORDS_TABLE_RELATED_RECORDS_MAXIMUM_PAGE_SIZE} related records at a time.`,
        );
      // The child query's inputs bind through the one binding check, where This row is the row.
      const problem = checkQueryBindings(state.bindings, query.inputs, {
        ...related.page,
        blockLabel: query.label,
        rowFields: related.rowFields,
        rowRecordType: related.recordType,
      })[0];
      if (problem !== undefined) return featureNotPossible(code, problem.sentence);
      const boundToRow =
        state.bindings.kind === "read" &&
        state.bindings.bindings.some((binding) => binding.source.kind === "this_row");
      return boundToRow
        ? featureAvailable
        : featureNotPossible(code, `${query.label} needs an input bound to This row.`);
    },
  };
