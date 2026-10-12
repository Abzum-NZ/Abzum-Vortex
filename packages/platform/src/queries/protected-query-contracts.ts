import "server-only";

import { z } from "zod";
import {
  builderKeySchema,
  conditionNodeSchema,
  fieldIdSchema,
  jsonValueSchema,
  moduleRootIdSchema,
  queryIdSchema,
  recordIdSchema,
  revisionSchema,
  stableDefinitionReleaseVersionSchema,
  moduleFieldValueV2Schemas,
  personLinkValueV2Schema,
  recordLinkValueV2Schema,
  sourceExactDecimalTextV2Schema,
} from "@vortex/contracts";
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
    continuationToken: z.string().min(1).max(65_536).optional(),
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
const groupTypedValue = <K extends string, T extends z.ZodType>(fieldType: K, value: T) =>
  z
    .object({ fieldId: fieldIdSchema, fieldType: z.literal(fieldType), value: value.nullable() })
    .strict();

/** One exact readable representation for an installed generic summary group key. */
export const protectedQueryGroupValueSchema = z.discriminatedUnion("fieldType", [
  groupTypedValue("text", groupStringValueSchema),
  groupTypedValue("whole_number", safeWholeNumberGroupValueSchema),
  groupTypedValue("decimal_number", sourceExactDecimalTextV2Schema),
  groupTypedValue("yes_no", z.boolean()),
  groupTypedValue("date", moduleFieldValueV2Schemas.date),
  groupTypedValue("date_time", moduleFieldValueV2Schemas.date_time),
  groupTypedValue("choice", groupChoiceValueSchema),
  groupTypedValue("reference_number", groupStringValueSchema),
  groupTypedValue("email_address", groupStringValueSchema),
  groupTypedValue("phone_number", groupStringValueSchema),
  groupTypedValue("web_address", groupStringValueSchema),
  groupTypedValue("link", recordLinkValueV2Schema),
  groupTypedValue("link_to_one_of_several", recordLinkValueV2Schema),
  groupTypedValue("link_to_person", personLinkValueV2Schema),
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

/** One uncached, record-identity-ordered page of currently readable members in a generic group. */
export const protectedQueryGroupedMembersCommandSchema = z
  .object({
    moduleRootId: moduleRootIdSchema,
    queryId: queryIdSchema,
    inputValues: z.record(builderKeySchema, jsonValueSchema),
    requestedFieldIds: z
      .array(fieldIdSchema)
      .min(1)
      .max(200)
      .refine(uniqueFieldIds, { message: "Each requested field is named once" }),
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
    pageSize: z.number().int().min(1).max(200),
    selector: protectedQueryGroupSelectorSchema,
    continuationToken: z.string().min(1).max(65_536).optional(),
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
  "descriptor_invalid",
  "input_invalid",
  "field_unbounded",
  "filter_invalid",
  "sort_invalid",
  "relationship_invalid",
  "page_size_invalid",
  "cursor_invalid",
  "cursor_stale",
  /** A database-backed summary would exceed its bounded candidate scan. */
  "dataset_limit_exceeded",
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

export const protectedQueryPageSchema = z
  .object({
    outcome: z.literal("completed"),
    moduleRootId: moduleRootIdSchema,
    moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
    queryId: queryIdSchema,
    rows: z.array(protectedQueryPageRowSchema).max(200),
    /** Opaque; present only when a later page may hold further permitted rows. */
    nextContinuationToken: z.string().optional(),
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
    nextContinuationToken: z.string().optional(),
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

export const protectedQueryResultSchema = z.discriminatedUnion("outcome", [
  protectedQueryPageSchema,
  protectedQueryRefusalSchema,
]);
export type ProtectedQueryResult = z.infer<typeof protectedQueryResultSchema>;

/** One database-backed summary request over the installed Query's own groups and aggregates. */
export const protectedQuerySummaryCommandSchema = z
  .object({
    moduleRootId: moduleRootIdSchema,
    queryId: queryIdSchema,
    inputValues: z.record(builderKeySchema, jsonValueSchema),
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
export type ProtectedQuerySummaryCommand = z.infer<typeof protectedQuerySummaryCommandSchema>;

export const protectedQuerySummaryAggregateResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("completed"),
      value: jsonValueSchema,
      valueCount: z.number().int().nonnegative().max(100_000),
    })
    .strict(),
  z.object({ outcome: z.literal("refused"), reasonCode: z.literal("mixed_currency") }).strict(),
]);

export const protectedQuerySummaryGroupSchema = z
  .object({
    groupKey: z.string(),
    groupValues: z.record(fieldIdSchema, jsonValueSchema),
    rowCount: z.number().int().nonnegative().max(100_000),
    aggregates: z.record(builderKeySchema, protectedQuerySummaryAggregateResultSchema),
  })
  .strict();

export const protectedQuerySummaryCompletedSchema = z
  .object({
    outcome: z.literal("completed"),
    moduleRootId: moduleRootIdSchema,
    moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
    queryId: queryIdSchema,
    groupByFieldIds: z.array(fieldIdSchema).max(10),
    totalRowCount: z.number().int().nonnegative().max(100_000),
    groups: z.array(protectedQuerySummaryGroupSchema).max(100_000),
    aggregates: z.record(builderKeySchema, protectedQuerySummaryAggregateResultSchema),
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
    label: z.string().min(1).max(60).refine((label) => label.trim().length > 0),
    rowCount: z.number().int().nonnegative().max(100_000),
    aggregates: z.record(builderKeySchema, protectedQuerySummaryAggregateResultSchema),
  })
  .strict();

/** Readable members whose current choice is missing, withheld, null or not installed. */
export const protectedQueryBoardSummaryUnassignedSchema = z
  .object({
    rowCount: z.number().int().nonnegative().max(100_000),
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
    const aggregateSets = [
      ...summary.columns.map((column) => column.aggregates),
      summary.unassigned.aggregates,
    ];
    for (const [index, aggregates] of aggregateSets.entries()) {
      const candidateAliases = Object.keys(aggregates).sort();
      if (
        aliases.length !== candidateAliases.length ||
        aliases.some((alias, aliasIndex) => alias !== candidateAliases[aliasIndex])
      )
        context.addIssue({
          code: "custom",
          path: index < summary.columns.length ? ["columns", index, "aggregates"] : ["unassigned", "aggregates"],
          message: "Every board bucket reports the same declared aggregate aliases as the global result",
        });
    }

    const partitionedRows =
      summary.unassigned.rowCount +
      summary.columns.reduce((total, column) => total + column.rowCount, 0);
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
