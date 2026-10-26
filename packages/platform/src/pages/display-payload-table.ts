import { z } from "zod";
import { recordsTableSortDirections } from "../definition/application-composition/records-table-features/shared";
import { recordsTableTotalsSchema } from "../definition/application-composition/records-table-totals";
import {
  displayColumnSchema,
  displayColumnsSchema,
  displayFieldKeySchema,
  displayDetailFieldsSchema,
  isInternalAddress,
  displayTextSchema,
  refineUniqueKeys,
} from "./display-payload-parts";
import { displayRowsSchema } from "./display-payload-rows";
import { gridLayoutStateSchema } from "./grid-view-state";
import { namedActionAvailabilitySchema } from "./named-action-availability-schema";
import {
  recordsSelectionMaximumIds,
  recordsSelectionTokenSchema,
  recordsTableBulkRunSummarySchema,
} from "./records-selection";
import { recordsTableFeatureProjectionSchema } from "./records-table-feature-projection";
import { readRecordsTableFieldFilter, type RecordsTableFieldFilter } from "./records-table-filters";
import {
  RECORDS_TABLE_MAXIMUM_SEARCH_LENGTH,
  RECORDS_TABLE_MAXIMUM_SORT_KEYS,
} from "./records-table-state";

/*
 * The ready values of a Records table block. The server validates its page with these schemas;
 * the browser checks its envelope and renders it. The page runtime adds only the selection scope,
 * bulk run, export, action availability, held selection and requested sort it follows.
 */

const wholeCountSchema = z.number().int().nonnegative();
const continuationTokenSchema = displayTextSchema.pipe(z.string().max(65_536));

/** The order a table page was read in: one to twenty distinct fields, each ascending or descending. */
export const displayTableSortSchema = z
  .object({
    keys: z
      .array(
        z
          .object({ fieldId: displayFieldKeySchema, direction: z.enum(recordsTableSortDirections) })
          .strict()
          .readonly(),
      )
      .min(1)
      .max(RECORDS_TABLE_MAXIMUM_SORT_KEYS)
      .readonly(),
    /** True when the person chose this order; false when it is the authored default sort. */
    explicit: z.boolean(),
  })
  .strict()
  .readonly()
  .superRefine((sort, context) =>
    refineUniqueKeys(
      sort.keys,
      (key) => key.fieldId.toLowerCase(),
      context,
      "A sort names each field once",
      ["keys"],
    ),
  );

/** One field's typed filter in its canonical form, read by the one filter validator. */
const fieldFilterSchema = z
  .custom<RecordsTableFieldFilter>(
    (value) => readRecordsTableFieldFilter(value) !== undefined,
    "A table filter is not a valid typed filter",
  )
  .transform((value) => readRecordsTableFieldFilter(value)!);

/** One active filter: the filterable field and its typed filter. */
export const displayTableFilterSchema = z
  .object({ fieldId: displayFieldKeySchema, filter: fieldFilterSchema })
  .strict()
  .readonly();

/** Active filters, one per field. */
export const displayTableFiltersSchema = z
  .array(displayTableFilterSchema)
  .readonly()
  .superRefine((filters, context) =>
    refineUniqueKeys(
      filters,
      (filter) => filter.fieldId.toLowerCase(),
      context,
      "Filters name each field once",
    ),
  );

/** The viewer's search and filters one table page was read with; both empty when not narrowed. */
export const displayTableNarrowingSchema = z
  .object({
    search: displayTextSchema.pipe(z.string().max(RECORDS_TABLE_MAXIMUM_SEARCH_LENGTH)).nullable(),
    filters: displayTableFiltersSchema,
    /**
     * The titles of the records the link filters name, read under the viewer's access (record
     * identity to title); a record the viewer may not read is "Restricted record".
     */
    recordTitles: z.record(z.string(), displayTextSchema).readonly().exactOptional(),
  })
  .strict()
  .readonly();
export type DisplayTableNarrowing = z.output<typeof displayTableNarrowingSchema>;

/** One group of a grouped table: its key, its label and how many records it holds right now. */
export const displayTableGroupSchema = z
  .object({
    /** The canonical key of the group's value (see `recordsTableGroupKey`), never a display label. */
    key: displayTextSchema,
    label: displayTextSchema,
    count: wholeCountSchema,
    totals: recordsTableTotalsSchema.readonly().exactOptional(),
    /** The group of records that hold no value, or whose value the viewer cannot see. */
    unassigned: z.literal(true).exactOptional(),
  })
  .strict()
  .readonly();
export type DisplayTableGroup = z.output<typeof displayTableGroupSchema>;

/**
 * The groups a grouped table was read with. `ready` carries one bounded count per group, read with
 * the table's own filters, search and access; `too_many` says the filtered records are more than a
 * grouped read counts, so the table shows its records flat until the viewer narrows them.
 */
export const displayTableGroupsSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      fieldId: displayTextSchema,
      groups: z.array(displayTableGroupSchema).readonly(),
      /** The records the groups hold together, as the same read counted them. */
      total: wholeCountSchema,
      /** The key of the open group; absent while every group is closed. */
      expanded: displayTextSchema.exactOptional(),
      /**
       * Where this page of groups sits: `first` when no group page precedes it, and `next` the
       * opaque position that reads the following page (absent on the last page).
       */
      page: z
        .object({ first: z.boolean(), next: displayTextSchema.exactOptional() })
        .strict()
        .readonly(),
    })
    .strict()
    .readonly()
    .superRefine((groups, context) => {
      refineUniqueKeys(
        groups.groups,
        (group) => group.key,
        context,
        "Groups name each group once",
        ["groups"],
      );
      if (
        groups.expanded !== undefined &&
        !groups.groups.some((group) => group.key === groups.expanded)
      )
        context.addIssue({
          code: "custom",
          path: ["expanded"],
          message: "The open group must be one of the groups",
        });
    }),
  z
    .object({ status: z.literal("too_many") })
    .strict()
    .readonly(),
]);
export type DisplayTableGroups = z.output<typeof displayTableGroupsSchema>;

/**
 * How far a Records table selection reaches beyond the shown page, as the page runtime holds it:
 * the count of every matching record is being read, every matching record is selected (minus the
 * records the person unticked), or the matching records could not be counted.
 */
export const displayTableSelectionScopeSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("counting") })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("matching"), count: wholeCountSchema, excluded: wholeCountSchema })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("not_counted"),
      reason: z.enum(["too_many", "changed", "unavailable"]),
    })
    .strict()
    .readonly(),
]);
export type DisplayTableSelectionScope = z.output<typeof displayTableSelectionScopeSchema>;

/** One bulk run of a table, as the page runtime follows it: running, finished or failed. */
export const displayTableBulkRunSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("running"),
      label: displayTextSchema,
      total: wholeCountSchema.exactOptional(),
      processed: wholeCountSchema,
    })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal("finished"),
      label: displayTextSchema,
      selected: wholeCountSchema,
      summary: recordsTableBulkRunSummarySchema.readonly(),
    })
    .strict()
    .readonly(),
  z
    .object({ status: z.literal("failed"), label: displayTextSchema })
    .strict()
    .readonly(),
]);
export type DisplayTableBulkRun = z.output<typeof displayTableBulkRunSchema>;

/** What an export covers: the rows ticked on the page, the current view, or every matching record. */
export const displayTableExportScopeSchema = z.enum(["selected", "view", "matching"]);
export type DisplayTableExportScope = z.output<typeof displayTableExportScopeSchema>;

/**
 * One export of a table, as the page runtime follows it. `running` is a file being received (the
 * bytes so far); `finished` is a whole file the person has; `refused` is a message instead of a
 * file; `incomplete` is a file that stopped short, which is never saved; `cancelled` is the
 * person's own stop. The run ID stays the same through progress and outcome, including when
 * the page payload is parsed again.
 */
export const displayTableExportRunSchema = z.discriminatedUnion("status", [
  z
    .object({
      runId: displayTextSchema,
      status: z.literal("running"),
      scope: displayTableExportScopeSchema,
      expected: wholeCountSchema.exactOptional(),
      bytes: wholeCountSchema,
    })
    .strict()
    .readonly(),
  z
    .object({
      runId: displayTextSchema,
      status: z.literal("finished"),
      scope: displayTableExportScopeSchema,
      filename: displayTextSchema,
    })
    .strict()
    .readonly(),
  z
    .object({ runId: displayTextSchema, status: z.literal("refused"), message: displayTextSchema })
    .strict()
    .readonly(),
  z
    .object({ runId: displayTextSchema, status: z.literal("incomplete") })
    .strict()
    .readonly(),
  z
    .object({ runId: displayTextSchema, status: z.literal("cancelled") })
    .strict()
    .readonly(),
]);
export type DisplayTableExportRun = z.output<typeof displayTableExportRunSchema>;

/** The parts of a table payload the server reads; the page runtime adds the ones below. */
const tableReadShape = {
  kind: z.literal("table"),
  /** Declared sort fields readable on every record under this read's field policy. */
  sortableFields: z.array(displayFieldKeySchema).readonly(),
  columns: z.array(displayColumnSchema).readonly(),
  /**
   * The declared columns the read did not request, in declared order: their headings only, never a
   * value, so the person can show one again (which reads the page again with that column).
   */
  hiddenColumns: z.array(displayColumnSchema).readonly(),
  /** The person's layout of this grid: order, shown columns, widths and density. */
  layout: gridLayoutStateSchema,
  rows: displayRowsSchema,
  /**
   * Present when the table is grouped: the groups and their counts. The rows are then the open
   * group's members only, so a closed table carries none.
   */
  groups: displayTableGroupsSchema.exactOptional(),
  totals: recordsTableTotalsSchema.readonly().exactOptional(),
  /**
   * The grid features the server projected for this viewer and read; absent when every feature is
   * off. The table draws a feature only from this projection, never from its settings alone.
   */
  features: recordsTableFeatureProjectionSchema.exactOptional(),
  /**
   * The order the page was read in, when it is the viewer's sort or the authored default sort;
   * absent when the bound query's own order applies. A key may name a sorted field that is not a
   * visible column.
   */
  sort: displayTableSortSchema.exactOptional(),
  /**
   * The search and filters the page was read with; the table shows them in its controls and tells
   * a page that matched nothing apart from a table with no records.
   */
  narrowing: displayTableNarrowingSchema.exactOptional(),
  page: z.number().int().positive().exactOptional(),
  hasNextPage: z.boolean().exactOptional(),
  nextContinuationToken: continuationTokenSchema.exactOptional(),
  /** The read's scan budget ran out before the page filled: more records may match on the next page. */
  scanLimited: z.boolean().exactOptional(),
  hasPreviousPage: z.boolean().exactOptional(),
  previousContinuationToken: continuationTokenSchema.exactOptional(),
  /**
   * The sealed "every matching record" descriptor of this read, present only when bulk actions are
   * on: the browser hands it back to select every matching record without listing them.
   */
  selectionToken: recordsSelectionTokenSchema.exactOptional(),
};

/** The table payload rules that join its parts: columns, layout and paging agree. */
const refineTablePayload = (
  table: Readonly<{
    rows: readonly Readonly<{ title?: unknown }>[];
    columns: readonly Readonly<{ key: string }>[];
    hiddenColumns: readonly Readonly<{ key: string }>[];
    layout: z.output<typeof gridLayoutStateSchema>;
    page?: number;
    pageCount?: number;
    hasNextPage?: boolean;
    nextContinuationToken?: string;
    scanLimited?: boolean;
    hasPreviousPage?: boolean;
    previousContinuationToken?: string;
  }>,
  context: z.RefinementCtx,
): void => {
  const issue = (message: string, path: readonly PropertyKey[] = []) =>
    context.addIssue({ code: "custom", path: [...path], message });
  // Every table row carries its record type title; only launcher rows go without one.
  table.rows.forEach((row, index) => {
    if (row.title === undefined)
      issue("A projected table row requires its record type title", ["rows", index, "title"]);
  });
  // A column is either shown or hidden, never both.
  refineUniqueKeys(
    [...table.columns, ...table.hiddenColumns],
    (column) => column.key,
    context,
    "A column is either shown or hidden, once",
    ["columns"],
  );
  // The layout arranges exactly the declared columns the page carries, shown or hidden.
  const layoutKeys = new Set(table.layout.layout.columns.map((column) => column.fieldId));
  const carriedKeys = new Set(
    [...table.columns, ...table.hiddenColumns].map((column) => column.key.toLowerCase()),
  );
  if (layoutKeys.size !== carriedKeys.size || [...carriedKeys].some((key) => !layoutKeys.has(key)))
    issue("A table layout must arrange exactly the declared columns", ["layout"]);
  if (table.pageCount !== undefined && (table.page === undefined || table.page > table.pageCount))
    issue("Pagination requires a page within pageCount", ["pageCount"]);
  if (table.scanLimited === true && table.hasNextPage !== true)
    issue("A scan-limited page requires a next page", ["scanLimited"]);
  if (
    (table.hasNextPage === true) !== (table.nextContinuationToken !== undefined) ||
    ((table.hasNextPage !== undefined || table.nextContinuationToken !== undefined) &&
      table.page === undefined)
  )
    issue("Table continuation state is incomplete", ["nextContinuationToken"]);
  if ((table.hasPreviousPage === true) !== (table.previousContinuationToken !== undefined))
    issue("Table previous state is incomplete", ["previousContinuationToken"]);
};

/** The table page the server reads for one placement. */
export const tableReadValuesSchema = z
  .object(tableReadShape)
  .strict()
  .readonly()
  .superRefine(refineTablePayload);

/** The ready values a table block renders: the server's page plus what the page runtime follows. */
export const tablePayloadSchema = z
  .object({
    ...tableReadShape,
    pageCount: z.number().int().positive().exactOptional(),
    /**
     * The order the page address asks for while the page read in it is still on its way; the sort
     * controls show it and a next sort gesture builds on it. Absent once the rows read in that
     * order are shown, so `sort` alone names the order of the rows on screen.
     */
    requestedSort: displayTableSortSchema.exactOptional(),
    /** Held selections can name a previously drawn row beneath a closed branch. */
    selectedRecordIds: z
      .array(displayTextSchema)
      .max(recordsSelectionMaximumIds)
      .readonly()
      .superRefine((ids, context) =>
        refineUniqueKeys(ids, (id) => id, context, "Each selected record appears once"),
      )
      .exactOptional(),
    selectionScope: displayTableSelectionScopeSchema.exactOptional(),
    bulkRun: displayTableBulkRunSchema.exactOptional(),
    exportRun: displayTableExportRunSchema.exactOptional(),
    actionAvailability: z
      .union([namedActionAvailabilitySchema, z.literal("unavailable")])
      .exactOptional(),
  })
  .strict()
  .readonly()
  .superRefine(refineTablePayload);
export type DisplayTablePayload = z.output<typeof tablePayloadSchema>;

const statusOnly = <Status extends string>(status: Status) =>
  z
    .object({ status: z.literal(status) })
    .strict()
    .readonly();

/**
 * One page a table reads on demand, a tree level or the open group's members: the table's own
 * payload for those rows, or why there is none.
 */
export const tableLevelResultSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("ready"), values: tablePayloadSchema })
    .strict()
    .readonly(),
  statusOnly("empty"),
  statusOnly("refused"),
  statusOnly("error"),
]);
/** A tree level or a group's members as the page receives them. */
export type TableLevelReply = z.output<typeof tableLevelResultSchema>;

/** One related record of an expanded row: its own record page, when the viewer may open it. */
export const rowDetailRowSchema = z
  .object({
    recordId: displayTextSchema,
    href: z
      .string()
      .refine(isInternalAddress, "A related record's page must be in this application")
      .exactOptional(),
    fields: displayDetailFieldsSchema,
  })
  .strict()
  .readonly();

/**
 * One page of an expanded row's related records. A refusal and an error carry nothing, so the
 * panel cannot show records the read did not authorise; the cause stays in the server log.
 */
export const rowDetailResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      columns: displayColumnsSchema,
      rows: z.array(rowDetailRowSchema).readonly(),
      nextContinuationToken: displayTextSchema.exactOptional(),
    })
    .strict()
    .readonly(),
  statusOnly("empty"),
  statusOnly("refused"),
  statusOnly("error"),
]);
export type RowDetailResult = z.input<typeof rowDetailResultSchema>;
/** A related-records read as the page receives it. */
export type RowDetailReply = z.output<typeof rowDetailResultSchema>;
