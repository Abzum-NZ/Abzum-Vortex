import "server-only";

import { z } from "zod";
import {
  boardColumnReadLimit,
  builderKeySchema,
  conditionNodeSchema,
  fieldIdSchema,
  jsonValueSchema,
  moduleRootIdSchema,
  queryIdSchema,
  recordIdSchema,
  revisionSchema,
  stableDefinitionReleaseVersionSchema,
  moduleFieldValueSchemas,
  recordLinkValueSchema,
  sourceExactDecimalTextSchema,
} from "../schema";
import {
  recordSystemValuesSchema,
  supportedRecordSystemFieldKeySchema,
} from "./record-system-values";

/** A field identifier list is unique without regard to case, as the engine keys fields. */
const uniqueFieldIds = (fieldIds: readonly string[]): boolean =>
  new Set(fieldIds.map((fieldId) => fieldId.toLowerCase())).size === fieldIds.length;

/**
 * One viewer-chosen sort over a field the bound list component declares sortable. The engine
 * accepts it only when the installed record type also declares the field sortable and the reader
 * is guaranteed to see it, so a user sort never orders on a hidden or non-sortable value.
 */
export const protectedQuerySortSchema = z
  .object({ fieldId: fieldIdSchema, direction: z.enum(["ascending", "descending"]) })
  .strict();
export type ProtectedQuerySort = z.infer<typeof protectedQuerySortSchema>;

/**
 * One protected Query request. It names only the published Module query and the
 * caller's typed values: the organisation, Application and actor come from the
 * verified request, and the query declaration from the exact installed release.
 */
export const protectedQueryCommandSchema = z
  .object({
    moduleRootId: moduleRootIdSchema,
    queryId: queryIdSchema,
    inputValues: z.record(builderKeySchema, jsonValueSchema),
    requestedFieldIds: z
      .array(fieldIdSchema)
      .min(1)
      .max(200)
      .refine(
        (fieldIds) =>
          new Set(fieldIds.map((fieldId) => fieldId.toLowerCase())).size === fieldIds.length,
        { message: "Each requested field is named once" },
      ),
    /**
     * The supported Record system metadata fields this request declares. Only
     * these values may appear in a row's `systemValues`; an unsupported or
     * repeated key refuses the whole request, and an undeclared value can never
     * be mapped or inferred.
     */
    requestedSystemFieldKeys: z
      .array(supportedRecordSystemFieldKeySchema)
      .max(5)
      .refine((keys) => new Set(keys).size === keys.length, {
        message: "Each system field is declared once",
      })
      .default([]),
    /**
     * The viewer's chosen sort, from a list component's sort control. Empty uses the published
     * query's declared sort. Every named field must be one the component declares sortable and
     * the installed record type also declares sortable, or the whole request is refused.
     */
    sort: z
      .array(protectedQuerySortSchema)
      .max(20)
      .refine((sorts) => uniqueFieldIds(sorts.map((sort) => sort.fieldId)), {
        message: "Each sort field is named once",
      })
      .default([]),
    /**
     * The viewer's typed filter, from a list component's filter controls, ANDed with the published
     * query's declared filter so it can only narrow the result. Every field it reads must be one
     * the component declares filterable; anything else refuses the request.
     */
    filter: conditionNodeSchema.optional(),
    /** The viewer's search text, matched only over fields the installed record type marks searchable. */
    search: z.string().min(1).max(200).optional(),
    /**
     * The fields the bound component declares sortable, filterable and searchable. The server-side
     * caller builds them from the installed component's published contract (for a Records table,
     * runtime/page's buildRecordsTableQueryCommand) and never takes them from the browser. They
     * only narrow: whatever a caller supplies, no field the record type does not itself declare
     * sortable, filterable or searchable ever decides a result, and no row is returned through a
     * field the reader cannot see on it. The service
     * refuses a user sort or filter outside these sets; the engine additionally intersects every
     * accepted field with the installed record type's own sortable/filterable/search-priority
     * flags and the guaranteed-readable projection. An empty searchable set means the component
     * declares only a search box, so the engine searches every field the record type marks
     * searchable.
     */
    sortableFieldIds: z
      .array(fieldIdSchema)
      .max(200)
      .refine(uniqueFieldIds, { message: "Each sortable field is named once" })
      .default([]),
    filterableFieldIds: z
      .array(fieldIdSchema)
      .max(200)
      .refine(uniqueFieldIds, { message: "Each filterable field is named once" })
      .default([]),
    searchableFieldIds: z
      .array(fieldIdSchema)
      .max(200)
      .refine(uniqueFieldIds, { message: "Each searchable field is named once" })
      .default([]),
    pageSize: z.number().int().min(1).max(200),
    pageDirection: z.enum(["forward", "backward"]).optional(),
    continuationToken: z.string().min(1).max(65_536).optional(),
    /**
     * Narrows the installed query to these records (1 to 200 distinct ids, exactly `pageSize` of
     * them) under their ordinary viewer authority: only those readable now come back.
     */
    exactRecordIds: z
      .array(recordIdSchema)
      .min(1)
      .max(200)
      .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
        message: "Each exact record is named once",
      })
      .optional(),
  })
  .strict();
export type ProtectedQueryCommand = z.infer<typeof protectedQueryCommandSchema>;

/** One explicit, installed choice column or the unassigned member set. */
export const protectedQueryBoardColumnSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("option"), value: z.string().min(1).max(120) }).strict(),
  z.object({ kind: z.literal("unassigned") }).strict(),
]);
export type ProtectedQueryBoardColumn = z.infer<typeof protectedQueryBoardColumnSchema>;

/** A closed member selector over the choice field of a grouped installed Query. */
export const protectedQueryBoardSelectorSchema = z
  .object({
    choiceFieldId: fieldIdSchema,
    column: protectedQueryBoardColumnSchema,
  })
  .strict();
export type ProtectedQueryBoardSelector = z.infer<typeof protectedQueryBoardSelectorSchema>;

/** One uncached, record-identity-ordered page of readable members in a board column. */
export const protectedQueryBoardMembersCommandSchema = z
  .object({
    moduleRootId: moduleRootIdSchema,
    queryId: queryIdSchema,
    inputValues: z.record(builderKeySchema, jsonValueSchema),
    requestedFieldIds: z
      .array(fieldIdSchema)
      .min(1)
      .max(200)
      .refine(
        (fieldIds) =>
          new Set(fieldIds.map((fieldId) => fieldId.toLowerCase())).size === fieldIds.length,
        { message: "Each requested field is named once" },
      ),
    requestedSystemFieldKeys: z
      .array(supportedRecordSystemFieldKeySchema)
      .max(5)
      .refine((keys) => new Set(keys).size === keys.length, {
        message: "Each system field is declared once",
      })
      .default([]),
    filter: conditionNodeSchema.optional(),
    filterableFieldIds: z
      .array(fieldIdSchema)
      .max(200)
      .refine(uniqueFieldIds, { message: "Each filterable field is named once" })
      .default([]),
    selector: protectedQueryBoardSelectorSchema,
    pageSize: z.number().int().min(1).max(200),
    continuationToken: z.string().min(1).max(65_536).optional(),
  })
  .strict();
export type ProtectedQueryBoardMembersCommand = z.infer<
  typeof protectedQueryBoardMembersCommandSchema
>;

const safeWholeNumberGroupValueSchema = z.number().int().refine(Number.isSafeInteger);
const groupStringValueSchema = z.string();
const groupChoiceValueSchema = z.string().min(1).max(120);
/** The one group of links whose targets the reader cannot read: no identity or title of one is carried. */
const groupNotAvailableValueSchema = z.literal("not_available");
const groupTypedValue = <K extends string, T extends z.ZodType>(fieldType: K, value: T) =>
  z
    .object({ fieldId: fieldIdSchema, fieldType: z.literal(fieldType), value: value.nullable() })
    .strict();

/** One exact readable representation for an installed generic summary group key. */
export const protectedQueryGroupValueSchema = z.discriminatedUnion("fieldType", [
  groupTypedValue("text", groupStringValueSchema),
  groupTypedValue("whole_number", safeWholeNumberGroupValueSchema),
  groupTypedValue("decimal_number", sourceExactDecimalTextSchema),
  groupTypedValue("yes_no", z.boolean()),
  groupTypedValue("date", moduleFieldValueSchemas.date),
  groupTypedValue("date_time", moduleFieldValueSchemas.date_time),
  groupTypedValue("choice", groupChoiceValueSchema),
  groupTypedValue("reference_number", groupStringValueSchema),
  groupTypedValue("email_address", groupStringValueSchema),
  groupTypedValue("phone_number", groupStringValueSchema),
  groupTypedValue("web_address", groupStringValueSchema),
  groupTypedValue("link", z.union([recordLinkValueSchema, groupNotAvailableValueSchema])),
  groupTypedValue("link_to_one_of_several", recordLinkValueSchema),
]);
export type ProtectedQueryGroupValue = z.infer<typeof protectedQueryGroupValueSchema>;

/** Exact installed group identity; values keep the same representation used by summary JSONB. */
export const protectedQueryGroupSelectorSchema = z
  .object({
    values: z.array(protectedQueryGroupValueSchema).min(1).max(10),
  })
  .strict()
  .superRefine((selector, context) => {
    const normalizedIds = selector.values.map((value) => value.fieldId.toLowerCase());
    if (new Set(normalizedIds).size !== normalizedIds.length)
      context.addIssue({
        code: "custom",
        path: ["values"],
        message: "Each installed group field is named once",
      });
  });
export type ProtectedQueryGroupSelector = z.infer<typeof protectedQueryGroupSelectorSchema>;

/** A calendar bucket for a date dimension: an explicit unit and a named time zone. */
export const protectedQueryDateBucketSchema = z
  .object({
    unit: z.enum(["day", "week", "month", "quarter", "year"]),
    timeZone: z
      .string()
      .min(1)
      .max(100)
      .refine(
        (zone) => {
          try {
            // Calendar buckets use named zones from the database timezone catalogue.
            if (/^[+-]/.test(zone)) return false;
            new Intl.DateTimeFormat("en", { timeZone: zone });
            return true;
          } catch {
            return false;
          }
        },
        { message: "Choose a recognised time zone for date groups" },
      ),
  })
  .strict();
export type ProtectedQueryDateBucket = z.infer<typeof protectedQueryDateBucketSchema>;

/** One authored grid dimension. Date fields require an explicit calendar unit and time zone. */
export const protectedQueryGroupingSchema = z
  .object({
    fieldId: fieldIdSchema,
    limit: z.number().int().min(1).max(200),
    dateBucket: protectedQueryDateBucketSchema.optional(),
  })
  .strict();

/**
 * One authored pivot: a row and a column dimension crossed with one measure. Rows are paged
 * (`rowLimit`, at most 200) with the summary's keyset; the engine caps the column dimension.
 */
export const protectedQueryPivotSchema = z
  .object({
    rowFieldId: fieldIdSchema,
    rowDateBucket: protectedQueryDateBucketSchema.optional(),
    columnFieldId: fieldIdSchema,
    columnDateBucket: protectedQueryDateBucketSchema.optional(),
    measure: z.discriminatedUnion("operation", [
      z.object({ operation: z.literal("count") }).strict(),
      z
        .object({
          operation: z.enum(["sum", "average", "minimum", "maximum"]),
          fieldId: fieldIdSchema,
        })
        .strict(),
    ]),
    rowLimit: z.number().int().min(1).max(200),
  })
  .strict();
export type ProtectedQueryPivot = z.infer<typeof protectedQueryPivotSchema>;

/** One uncached, ordered, bidirectional page of currently readable members of a group. */
export const protectedQueryGroupedMembersCommandSchema = protectedQueryCommandSchema
  .omit({ exactRecordIds: true })
  .extend({
    selector: protectedQueryGroupSelectorSchema,
    /** A grid's authored dimension overrides the query's grouping defaults. */
    grouping: protectedQueryGroupingSchema.optional(),
  })
  .strict();
export type ProtectedQueryGroupedMembersCommand = z.infer<
  typeof protectedQueryGroupedMembersCommandSchema
>;

/**
 * The record action kinds one list row can expose per row. Read is implied by the
 * row's own presence; create is not a per-existing-record action and is never listed.
 */
export const protectedQueryRowActionKinds = ["update", "delete", "restore"] as const;
export const protectedQueryRowActionKindSchema = z.enum(protectedQueryRowActionKinds);
export type ProtectedQueryRowActionKind = z.infer<typeof protectedQueryRowActionKindSchema>;

/** One row revision is a JavaScript-safe positive integer, exactly as a concurrency number is. */

/**
 * The per-row capabilities the Query engine returns, always from the same exact per-row access
 * decision read_record applies and never looser: the field identities the viewer may change on
 * this row, and the record action kinds the viewer may take on it.
 */
export const protectedQueryRowCapabilitiesSchema = z
  .object({
    changeableFieldIds: z.array(fieldIdSchema).max(500),
    actions: z.array(protectedQueryRowActionKindSchema).max(protectedQueryRowActionKinds.length),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.actions).size !== value.actions.length)
      context.addIssue({
        code: "custom",
        path: ["actions"],
        message: "Each row action is reported once",
      });
    const changeable = value.changeableFieldIds.map((fieldId) => fieldId.toLowerCase());
    if (new Set(changeable).size !== changeable.length)
      context.addIssue({
        code: "custom",
        path: ["changeableFieldIds"],
        message: "Each changeable field is reported once",
      });
  });
export type ProtectedQueryRowCapabilities = z.infer<typeof protectedQueryRowCapabilitiesSchema>;

const protectedQueryRowFields = {
  recordId: recordIdSchema,
  /** Readable requested fields only; a withheld field is absent rather than blank. */
  values: z.record(fieldIdSchema, jsonValueSchema),
  /**
   * The declared supported system metadata values for this row, or absent when
   * the request declares none. Undeclared values never appear.
   */
  systemValues: recordSystemValuesSchema.optional(),
};

/**
 * One row of any query result. A list row additionally carries its revision and
 * capabilities; the fields stay optional here so an arrangement that reshapes rows
 * without them remains a valid query row.
 */
export const protectedQueryRowSchema = z
  .object({
    ...protectedQueryRowFields,
    revision: revisionSchema.optional(),
    capabilities: protectedQueryRowCapabilitiesSchema.optional(),
  })
  .strict();
export type ProtectedQueryRow = z.infer<typeof protectedQueryRowSchema>;

/**
 * One row of one list query page. The Query engine returns every page row with
 * its record revision and its per-row capabilities, so both are required here.
 */
export const protectedQueryPageRowSchema = z
  .object({
    ...protectedQueryRowFields,
    revision: revisionSchema,
    capabilities: protectedQueryRowCapabilitiesSchema,
  })
  .strict();
export type ProtectedQueryPageRow = z.infer<typeof protectedQueryPageRowSchema>;

export const protectedQueryRefusalReasonCodes = [
  "request_invalid",
  "query_unavailable",
  "read_forbidden",
  "descriptor_invalid",
  "input_invalid",
  "field_unbounded",
  "filter_invalid",
  /** The data source declares no column for a filtered or searched field. */
  "filter_field_not_declared",
  /** The filter cannot be applied exactly inside the data source's own scan. */
  "predicate_unsupported",
  "sort_invalid",
  "relationship_invalid",
  "page_size_invalid",
  "cursor_invalid",
  "cursor_stale",
  /** A database-backed summary or arrangement would exceed its bounded candidate scan. */
  "dataset_limit_exceeded",
  /** A pivot's column dimension holds more values than one pivot shows. */
  "pivot_columns_exceeded",
  /** A date bucket (its start or its exclusive end) falls outside the supported UTC years 0001 to 9999. */
  "value_out_of_range",
] as const;
export type ProtectedQueryRefusalReasonCode = (typeof protectedQueryRefusalReasonCodes)[number];

/** Every refusal is this one neutral shape; it is decided before any row is exposed. */
export const protectedQueryRefusalSchema = z
  .object({
    outcome: z.literal("refused"),
    reasonCode: z.enum(protectedQueryRefusalReasonCodes),
  })
  .strict();
export type ProtectedQueryRefusal = z.infer<typeof protectedQueryRefusalSchema>;

/**
 * The reader's current field bound, decided by the same read as the page and carried even by an
 * empty page: the record type's fields the reader is guaranteed to see on every record it may read
 * now, and whether any field the record type marks searchable is among them. A list offers (and
 * accepts) its filter, search and sort controls only within it; it is never taken from the browser.
 */
export const protectedQueryFieldBoundsSchema = z
  .object({
    readableFieldIds: z.array(fieldIdSchema).max(500),
    searchable: z.boolean(),
  })
  .strict();
export type ProtectedQueryFieldBounds = z.infer<typeof protectedQueryFieldBoundsSchema>;

export const protectedQueryPageSchema = z
  .object({
    outcome: z.literal("completed"),
    moduleRootId: moduleRootIdSchema,
    moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
    queryId: queryIdSchema,
    rows: z.array(protectedQueryPageRowSchema).max(200),
    fieldBounds: protectedQueryFieldBoundsSchema,
    /**
     * True when the request's scan budget ran out before the page filled: the rows are the matches
     * found so far and the continuation resumes after the last candidate examined.
     */
    scanLimited: z.boolean(),
    /** Opaque; present only when a later page may hold further permitted rows. */
    nextContinuationToken: z.string().optional(),
    previousContinuationToken: z.string().optional(),
  })
  .strict();
export type ProtectedQueryPage = z.infer<typeof protectedQueryPageSchema>;

export const protectedQueryGroupedMembersCompletedSchema = z
  .object({
    outcome: z.literal("completed"),
    moduleRootId: moduleRootIdSchema,
    moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
    queryId: queryIdSchema,
    groupByFieldIds: z.array(fieldIdSchema).min(1).max(10),
    groupValues: z.record(fieldIdSchema, jsonValueSchema),
    rows: z.array(protectedQueryPageRowSchema).max(200),
    /** The reader's field bound from this same read, as a plain page carries it. */
    fieldBounds: protectedQueryFieldBoundsSchema,
    nextContinuationToken: z.string().optional(),
    previousContinuationToken: z.string().optional(),
  })
  .strict()
  .superRefine((result, context) => {
    const normalizedIds = result.groupByFieldIds.map((fieldId) => fieldId.toLowerCase());
    if (normalizedIds.some((fieldId, index) => fieldId !== result.groupByFieldIds[index]))
      context.addIssue({
        code: "custom",
        path: ["groupByFieldIds"],
        message: "Installed group field identifiers use normalized lowercase spelling",
      });
    if (new Set(normalizedIds).size !== normalizedIds.length)
      context.addIssue({
        code: "custom",
        path: ["groupByFieldIds"],
        message: "Each installed group field is reported once",
      });
    const rawGroupValueIds = Object.keys(result.groupValues);
    const groupValueIds = rawGroupValueIds.map((fieldId) => fieldId.toLowerCase());
    if (
      new Set(groupValueIds).size !== groupValueIds.length ||
      groupValueIds.some((fieldId, index) => fieldId !== rawGroupValueIds[index]) ||
      normalizedIds.length !== groupValueIds.length ||
      normalizedIds.some((fieldId) => !groupValueIds.includes(fieldId))
    )
      context.addIssue({
        code: "custom",
        path: ["groupValues"],
        message: "Group values name every installed grouping field exactly once",
      });
    const rowIds = result.rows.map((row) => row.recordId.toLowerCase());
    if (new Set(rowIds).size !== rowIds.length)
      context.addIssue({
        code: "custom",
        path: ["rows"],
        message: "Each record is returned once per group page",
      });
  });
export type ProtectedQueryGroupedMembersCompleted = z.infer<
  typeof protectedQueryGroupedMembersCompletedSchema
>;

export const protectedQueryGroupedMembersResultSchema = z.discriminatedUnion("outcome", [
  protectedQueryGroupedMembersCompletedSchema,
  protectedQueryRefusalSchema,
]);
export type ProtectedQueryGroupedMembersResult = z.infer<
  typeof protectedQueryGroupedMembersResultSchema
>;

/**
 * One level of a tree over a record type's one-record link to itself: the children of one parent
 * record, or, with no parent, the roots (the records no readable parent holds). It takes the
 * Records table's own read shape, so the viewer's sort, filter and search apply at every level.
 */
export const protectedQueryTreeLevelCommandSchema = protectedQueryCommandSchema
  .omit({ exactRecordIds: true })
  .extend({
    /** The record type's link to itself that makes a record the child of another. */
    parentFieldId: fieldIdSchema,
    /** The parent whose children are read; null reads the roots. */
    parentRecordId: recordIdSchema.nullable(),
  })
  .strict();
export type ProtectedQueryTreeLevelCommand = z.infer<typeof protectedQueryTreeLevelCommandSchema>;

/** A tree row is a page row that also says whether the reader may read a child of it. */
export const protectedQueryTreeRowSchema = protectedQueryPageRowSchema
  .extend({ hasChildren: z.boolean() })
  .strict();
export type ProtectedQueryTreeRow = z.infer<typeof protectedQueryTreeRowSchema>;

export const protectedQueryTreeLevelCompletedSchema = z
  .object({
    outcome: z.literal("completed"),
    moduleRootId: moduleRootIdSchema,
    moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
    queryId: queryIdSchema,
    rows: z.array(protectedQueryTreeRowSchema).max(200),
    fieldBounds: protectedQueryFieldBoundsSchema,
    scanLimited: z.boolean(),
    nextContinuationToken: z.string().optional(),
    previousContinuationToken: z.string().optional(),
  })
  .strict();
export const protectedQueryTreeLevelResultSchema = z.discriminatedUnion("outcome", [
  protectedQueryTreeLevelCompletedSchema,
  protectedQueryRefusalSchema,
]);
export type ProtectedQueryTreeLevelResult = z.infer<typeof protectedQueryTreeLevelResultSchema>;

export const protectedQueryResultSchema = z.discriminatedUnion("outcome", [
  protectedQueryPageSchema,
  protectedQueryRefusalSchema,
]);
export type ProtectedQueryResult = z.infer<typeof protectedQueryResultSchema>;

/** One database-backed summary request over the installed Query's groups and aggregates, or a grid's authored dimension. */
export const protectedQuerySummaryCommandSchema = z
  .object({
    moduleRootId: moduleRootIdSchema,
    queryId: queryIdSchema,
    inputValues: z.record(builderKeySchema, jsonValueSchema),
    /** A grid's authored dimension overrides query grouping/totals defaults. */
    grouping: protectedQueryGroupingSchema.optional(),
    /** A pivot crosses two dimensions with one measure; it replaces the query's grouping. */
    pivot: protectedQueryPivotSchema.optional(),
    /** Last visible summary key; each page recomputes counts under current access. */
    groupAfter: z.string().min(1).max(4096).optional(),
    search: protectedQueryCommandSchema.shape.search,
    searchableFieldIds: protectedQueryCommandSchema.shape.searchableFieldIds,
    /** The viewer's typed filter narrows the installed Query filter. */
    filter: conditionNodeSchema.optional(),
    /** Built by the bound component from its installed filter controls. */
    filterableFieldIds: z
      .array(fieldIdSchema)
      .max(200)
      .refine(uniqueFieldIds, { message: "Each filterable field is named once" })
      .default([]),
  })
  .strict()
  .superRefine((command, context) => {
    if (
      command.groupAfter !== undefined &&
      command.grouping === undefined &&
      command.pivot === undefined
    )
      context.addIssue({
        code: "custom",
        path: ["groupAfter"],
        message: "Choose a grouping dimension before paging groups",
      });
    if (command.grouping !== undefined && command.pivot !== undefined)
      context.addIssue({
        code: "custom",
        path: ["pivot"],
        message: "A request is either grouped or pivoted",
      });
  });
export type ProtectedQuerySummaryCommand = z.infer<typeof protectedQuerySummaryCommandSchema>;

export const protectedQuerySummaryAggregateResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("completed"),
      value: jsonValueSchema,
      valueCount: z.number().int().nonnegative().max(100_000),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("refused"),
      reasonCode: z.enum(["mixed_currency", "read_forbidden"]),
    })
    .strict(),
]);

export const protectedQuerySummaryGroupSchema = z
  .object({
    groupKey: z.string(),
    groupValues: z.record(fieldIdSchema, jsonValueSchema),
    rowCount: z.number().int().nonnegative().max(100_000),
    aggregates: z.record(builderKeySchema, protectedQuerySummaryAggregateResultSchema),
  })
  .strict();

/** A pivot axis value: the canonical text of a choice or date bucket, or null for no value. */
const pivotAxisValueSchema = z.union([z.string(), z.null(), recordLinkValueSchema]);
const pivotMeasureSchema = z.record(builderKeySchema, protectedQuerySummaryAggregateResultSchema);

export const protectedQueryPivotResultSchema = z
  .object({
    rowFieldId: fieldIdSchema,
    columnFieldId: fieldIdSchema,
    /** Row groups in the whole filtered set, not only the page. */
    rowGroupCount: z.number().int().nonnegative().max(100_000),
    columns: z
      .array(
        z
          .object({
            value: pivotAxisValueSchema,
            rowCount: z.number().int().nonnegative().max(100_000),
            aggregates: pivotMeasureSchema,
          })
          .strict(),
      )
      .max(50),
    rows: z
      .array(
        z
          .object({
            key: z.string().min(1).max(4096),
            value: pivotAxisValueSchema,
            rowCount: z.number().int().nonnegative().max(100_000),
            aggregates: pivotMeasureSchema,
            cells: z
              .array(
                z
                  .object({
                    column: pivotAxisValueSchema,
                    rowCount: z.number().int().nonnegative().max(100_000),
                    aggregates: pivotMeasureSchema,
                  })
                  .strict(),
              )
              .max(50),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export type ProtectedQueryPivotResult = z.infer<typeof protectedQueryPivotResultSchema>;

export const protectedQuerySummaryCompletedSchema = z
  .object({
    outcome: z.literal("completed"),
    moduleRootId: moduleRootIdSchema,
    moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
    queryId: queryIdSchema,
    groupByFieldIds: z.array(fieldIdSchema).max(10),
    totalRowCount: z.number().int().nonnegative().max(100_000),
    groups: z.array(protectedQuerySummaryGroupSchema).max(100_000),
    /** Null when this is the last group page; totals still cover the full filtered set. */
    nextGroupKey: z.string().nullable().optional(),
    aggregates: z.record(builderKeySchema, protectedQuerySummaryAggregateResultSchema),
    /** Present only when the request pivoted: its cells, row totals and column totals. */
    pivot: protectedQueryPivotResultSchema.optional(),
    /** Present only for a grid's grouped read: the reader's field bound, as a plain page carries it. */
    fieldBounds: protectedQueryFieldBoundsSchema.optional(),
  })
  .strict();

export const protectedQuerySummaryResultSchema = z.discriminatedUnion("outcome", [
  protectedQuerySummaryCompletedSchema,
  protectedQueryRefusalSchema,
]);
export type ProtectedQuerySummaryCompleted = z.infer<typeof protectedQuerySummaryCompletedSchema>;
export type ProtectedQuerySummaryAggregateResult = z.infer<
  typeof protectedQuerySummaryAggregateResultSchema
>;
export type ProtectedQuerySummaryGroup = z.infer<typeof protectedQuerySummaryGroupSchema>;
export type ProtectedQuerySummaryResult = z.infer<typeof protectedQuerySummaryResultSchema>;

/** One installed choice column in an exact protected board summary. */
export const protectedQueryBoardSummaryColumnSchema = z
  .object({
    value: z.string().min(1).max(120),
    label: z
      .string()
      .min(1)
      .max(60)
      .refine((label) => label.trim().length > 0),
    rowCount: z.number().int().nonnegative().max(100_000).nullable(),
    aggregates: z.record(builderKeySchema, protectedQuerySummaryAggregateResultSchema),
  })
  .strict();

/** Readable members whose current choice is missing, withheld, null or not installed. */
export const protectedQueryBoardSummaryUnassignedSchema = z
  .object({
    rowCount: z.number().int().nonnegative().max(100_000).nullable(),
    aggregates: z.record(builderKeySchema, protectedQuerySummaryAggregateResultSchema),
  })
  .strict();

/** The only input to a board summary: the published Query and its one selected choice field. */
export const protectedQueryBoardSummaryCommandSchema = z
  .object({
    moduleRootId: moduleRootIdSchema,
    queryId: queryIdSchema,
    inputValues: z.record(builderKeySchema, jsonValueSchema),
    choiceFieldId: fieldIdSchema,
    columns: z
      .array(protectedQueryBoardSelectorSchema.shape.column)
      .min(1)
      .max(boardColumnReadLimit),
    /** The viewer's typed filter narrows the installed Query filter. */
    filter: conditionNodeSchema.optional(),
    /** Built by the bound component from its installed filter controls. */
    filterableFieldIds: z
      .array(fieldIdSchema)
      .max(200)
      .refine(uniqueFieldIds, { message: "Each filterable field is named once" })
      .default([]),
  })
  .strict();
export type ProtectedQueryBoardSummaryCommand = z.infer<
  typeof protectedQueryBoardSummaryCommandSchema
>;

export const protectedQueryBoardSummaryCompletedSchema = z
  .object({
    outcome: z.literal("completed"),
    moduleRootId: moduleRootIdSchema,
    moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
    queryId: queryIdSchema,
    choiceFieldId: fieldIdSchema,
    totalRowCount: z.number().int().nonnegative().max(100_000),
    columns: z.array(protectedQueryBoardSummaryColumnSchema).min(1).max(12),
    unassigned: protectedQueryBoardSummaryUnassignedSchema,
    aggregates: z.record(builderKeySchema, protectedQuerySummaryAggregateResultSchema),
  })
  .strict()
  .superRefine((summary, context) => {
    if (new Set(summary.columns.map((column) => column.value)).size !== summary.columns.length)
      context.addIssue({
        code: "custom",
        path: ["columns"],
        message: "Each installed choice value is reported once",
      });

    const aliases = Object.keys(summary.aggregates).sort();
    const buckets = [...summary.columns, summary.unassigned];
    const aggregateSets = buckets.map((bucket) => bucket.aggregates);
    for (const [index, aggregates] of aggregateSets.entries()) {
      const candidateAliases = Object.keys(aggregates).sort();
      if (
        (buckets[index]!.rowCount === null
          ? candidateAliases.length !== 0
          : aliases.length !== candidateAliases.length) ||
        (buckets[index]!.rowCount !== null &&
          aliases.some((alias, aliasIndex) => alias !== candidateAliases[aliasIndex]))
      )
        context.addIssue({
          code: "custom",
          path:
            index < summary.columns.length
              ? ["columns", index, "aggregates"]
              : ["unassigned", "aggregates"],
          message:
            "Every board bucket reports the same declared aggregate aliases as the global result",
        });
    }

    const partitionedRows =
      (summary.unassigned.rowCount ?? 0) +
      summary.columns.reduce((total, column) => total + (column.rowCount ?? 0), 0);
    if (partitionedRows !== summary.totalRowCount)
      context.addIssue({
        code: "custom",
        path: ["totalRowCount"],
        message: "Board bucket counts partition the total row count",
      });
  });

export const protectedQueryBoardSummaryResultSchema = z.discriminatedUnion("outcome", [
  protectedQueryBoardSummaryCompletedSchema,
  protectedQueryRefusalSchema,
]);
export type ProtectedQueryBoardSummaryColumn = z.infer<
  typeof protectedQueryBoardSummaryColumnSchema
>;
export type ProtectedQueryBoardSummaryUnassigned = z.infer<
  typeof protectedQueryBoardSummaryUnassignedSchema
>;
export type ProtectedQueryBoardSummaryCompleted = z.infer<
  typeof protectedQueryBoardSummaryCompletedSchema
>;
export type ProtectedQueryBoardSummaryResult = z.infer<
  typeof protectedQueryBoardSummaryResultSchema
>;
