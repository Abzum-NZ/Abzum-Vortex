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
        (fieldIds) => new Set(fieldIds.map((fieldId) => fieldId.toLowerCase())).size === fieldIds.length,
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
     * The fields the bound component declares sortable, filterable and searchable. The service
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

/**
 * The record action kinds one list row can expose per row. Read is implied by the
 * row's own presence; create is not a per-existing-record action and is never listed.
 */
export const protectedQueryRowActionKinds = ["update", "delete", "restore"] as const;
export const protectedQueryRowActionKindSchema = z.enum(protectedQueryRowActionKinds);
export type ProtectedQueryRowActionKind = z.infer<typeof protectedQueryRowActionKindSchema>;

/** One row revision is a JavaScript-safe positive integer, exactly as a concurrency number is. */
const rowRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);

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
    revision: rowRevisionSchema.optional(),
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
    revision: rowRevisionSchema,
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

export const protectedQueryResultSchema = z.discriminatedUnion("outcome", [
  protectedQueryPageSchema,
  protectedQueryRefusalSchema,
]);
export type ProtectedQueryResult = z.infer<typeof protectedQueryResultSchema>;
