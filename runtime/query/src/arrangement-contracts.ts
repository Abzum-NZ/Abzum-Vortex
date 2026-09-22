import "server-only";

import { z } from "zod";
import {
  builderKeySchema,
  calendarMappingSchema,
  exactDecimalTextV2Schema,
  fieldIdSchema,
  fieldTypeKeys,
  jsonValueSchema,
  moduleRootIdSchema,
  moneyValueV2Schema,
  queryIdSchema,
  recordIdSchema,
  stableDefinitionReleaseVersionSchema,
} from "@vortex/contracts";
import { protectedQueryRowSchema } from "./protected-query-contracts";

/**
 * Most rows one arrangement accepts. Rows, counts, groups and totals are all
 * computed from one complete authorised result, so a larger result is refused
 * rather than truncated into a partial total.
 */
export const arrangementRowLimit = 1_000;
export const boardChoiceOptionLimit = 12;

const uniqueIds = (ids: readonly string[]): boolean =>
  new Set(ids.map((id) => id.toLowerCase())).size === ids.length;

const declaredFieldIdsSchema = z
  .array(fieldIdSchema)
  .min(1)
  .max(200)
  .refine(uniqueIds, { message: "Each declared field is named once" });

const groupByFieldIdsSchema = z
  .array(fieldIdSchema)
  .max(10)
  .refine(uniqueIds, { message: "Each grouping field is named once" });

/** The installed Module query and release every arrangement output is derived from. */
export const arrangementSourcePlanSchema = z
  .object({
    moduleRootId: moduleRootIdSchema,
    moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
    queryId: queryIdSchema,
  })
  .strict();
export type ArrangementSourcePlan = z.infer<typeof arrangementSourcePlanSchema>;

/** A field the authorised plan selected, with its declared field type. */
export const arrangementFieldSchema = z
  .object({
    fieldId: fieldIdSchema,
    type: z.enum(fieldTypeKeys),
  })
  .strict();
export type ArrangementField = z.infer<typeof arrangementFieldSchema>;

/**
 * The complete, unpaged result of one authorised query plan: every permitted
 * row after organisation, record-visibility, field-bounds and filter checks,
 * in the plan's deterministic order, before any page is cut. Every row, count,
 * group and total of one arrangement is derived from this one value.
 */
export const arrangementDatasetSchema = z
  .object({
    plan: arrangementSourcePlanSchema,
    fields: z
      .array(arrangementFieldSchema)
      .min(1)
      .max(200)
      .refine((fields) => uniqueIds(fields.map((field) => field.fieldId)), {
        message: "Each field is described once",
      }),
    rows: z.array(protectedQueryRowSchema).max(arrangementRowLimit),
  })
  .strict();
export type ArrangementDataset = z.infer<typeof arrangementDatasetSchema>;

export const aggregateDescriptorSchema = z
  .object({
    operation: z.enum(["count", "sum", "minimum", "maximum", "average"]),
    fieldId: fieldIdSchema.optional(),
    alias: builderKeySchema,
    /** Averages round half away from zero to this many places; two when omitted. */
    decimalPlaces: z.number().int().min(0).max(12).optional(),
  })
  .strict();
export type AggregateDescriptor = z.infer<typeof aggregateDescriptorSchema>;

const aggregatesSchema = z
  .array(aggregateDescriptorSchema)
  .max(20)
  .refine((aggregates) => new Set(aggregates.map((aggregate) => aggregate.alias)).size === aggregates.length, {
    message: "Each aggregate alias is used once",
  });

/**
 * A computed value. Counts are whole numbers; sums and averages of whole and
 * decimal numbers are exact decimal text; money keeps its one currency; minimum
 * and maximum return the field's own value. `null` means no value was present.
 */
export const aggregateValueSchema = z.union([
  exactDecimalTextV2Schema,
  moneyValueV2Schema,
  z.number().int(),
  z.iso.date(),
  z.iso.datetime({ offset: true }),
  z.null(),
]);
export type AggregateValue = z.infer<typeof aggregateValueSchema>;

export const aggregateResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("completed"),
      value: aggregateValueSchema,
      /** Rows that held a value; missing and withheld values are not counted or totalled. */
      valueCount: z.number().int().nonnegative(),
    })
    .strict(),
  /** A money total over more than one currency is refused, never converted or split. */
  z.object({ outcome: z.literal("refused"), reasonCode: z.literal("mixed_currency") }).strict(),
]);
export type AggregateResult = z.infer<typeof aggregateResultSchema>;

const aggregateResultsSchema = z.record(builderKeySchema, aggregateResultSchema);

export const arrangementRowSchema = protectedQueryRowSchema;
export type ArrangementRow = z.infer<typeof arrangementRowSchema>;

// Descriptors

export const tableArrangementDescriptorSchema = z
  .object({
    type: z.literal("table"),
    declaredFieldIds: declaredFieldIdsSchema,
    groupByFieldIds: groupByFieldIdsSchema.default([]),
    aggregates: aggregatesSchema.default([]),
  })
  .strict();

export const boardChoiceOptionSchema = z
  .object({
    value: z.string().min(1).max(120),
    label: z.string().min(1).max(120),
  })
  .strict();

export const boardArrangementDescriptorSchema = z
  .object({
    type: z.literal("board"),
    declaredFieldIds: declaredFieldIdsSchema,
    /** A choice field; one column per declared option, in declared order. */
    choiceFieldId: fieldIdSchema,
    choiceOptions: z
      .array(boardChoiceOptionSchema)
      .min(1)
      .max(boardChoiceOptionLimit)
      .refine((options) => new Set(options.map((option) => option.value)).size === options.length, {
        message: "Each choice option is listed once",
      }),
    aggregates: aggregatesSchema.default([]),
  })
  .strict();

export const calendarArrangementDescriptorSchema = z
  .object({
    type: z.literal("calendar"),
    declaredFieldIds: declaredFieldIdsSchema,
    calendarMapping: calendarMappingSchema,
    /** IANA time zone for calendar-day durations and the stated report zone. */
    timeZone: z.string().min(1).max(64).default("UTC"),
  })
  .strict();

export const summaryArrangementDescriptorSchema = z
  .object({
    type: z.literal("summary"),
    /** Fields the summary may group or total; a summary emits no rows. */
    declaredFieldIds: declaredFieldIdsSchema,
    groupByFieldIds: groupByFieldIdsSchema.default([]),
    aggregates: aggregatesSchema.min(1),
  })
  .strict();

export const arrangementDescriptorSchema = z.discriminatedUnion("type", [
  tableArrangementDescriptorSchema,
  boardArrangementDescriptorSchema,
  calendarArrangementDescriptorSchema,
  summaryArrangementDescriptorSchema,
]);
export type ArrangementDescriptor = z.infer<typeof arrangementDescriptorSchema>;
export type TableArrangementDescriptor = z.infer<typeof tableArrangementDescriptorSchema>;
export type BoardArrangementDescriptor = z.infer<typeof boardArrangementDescriptorSchema>;
export type CalendarArrangementDescriptor = z.infer<typeof calendarArrangementDescriptorSchema>;
export type SummaryArrangementDescriptor = z.infer<typeof summaryArrangementDescriptorSchema>;

export const arrangementCommandSchema = z
  .object({
    dataset: arrangementDatasetSchema,
    descriptor: arrangementDescriptorSchema,
  })
  .strict();
export type ArrangementCommand = z.input<typeof arrangementCommandSchema>;

// Results

const groupValuesSchema = z.record(fieldIdSchema, jsonValueSchema);

export const tableGroupSchema = z
  .object({
    /** Stable identity of the grouping values, unique within the arrangement. */
    groupKey: z.string(),
    groupValues: groupValuesSchema,
    rowCount: z.number().int().nonnegative(),
    rows: z.array(arrangementRowSchema),
    aggregates: aggregateResultsSchema,
  })
  .strict();
export type TableGroup = z.infer<typeof tableGroupSchema>;

export const tableArrangementResultSchema = z
  .object({
    outcome: z.literal("completed"),
    arrangement: z.literal("table"),
    plan: arrangementSourcePlanSchema,
    declaredFieldIds: z.array(fieldIdSchema),
    groupByFieldIds: z.array(fieldIdSchema),
    totalRowCount: z.number().int().nonnegative(),
    /** Present exactly when the table is not grouped. */
    rows: z.array(arrangementRowSchema).nullable(),
    /** Present exactly when the table is grouped. */
    groups: z.array(tableGroupSchema).nullable(),
    aggregates: aggregateResultsSchema,
  })
  .strict();
export type TableArrangementResult = z.infer<typeof tableArrangementResultSchema>;

export const boardColumnSchema = z
  .object({
    rowCount: z.number().int().nonnegative(),
    rows: z.array(arrangementRowSchema),
    aggregates: aggregateResultsSchema,
  })
  .strict();

export const boardArrangementResultSchema = z
  .object({
    outcome: z.literal("completed"),
    arrangement: z.literal("board"),
    plan: arrangementSourcePlanSchema,
    declaredFieldIds: z.array(fieldIdSchema),
    choiceFieldId: fieldIdSchema,
    totalRowCount: z.number().int().nonnegative(),
    columns: z.array(boardColumnSchema.extend({ value: z.string(), label: z.string() }).strict()),
    /** Rows whose choice is empty, withheld or not a declared option. */
    unassigned: boardColumnSchema,
    aggregates: aggregateResultsSchema,
  })
  .strict();
export type BoardArrangementResult = z.infer<typeof boardArrangementResultSchema>;

export const calendarItemSchema = z
  .object({
    recordId: recordIdSchema,
    start: z.union([z.iso.date(), z.iso.datetime({ offset: true })]),
    end: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).nullable(),
    values: z.record(fieldIdSchema, jsonValueSchema),
  })
  .strict();
export type CalendarItem = z.infer<typeof calendarItemSchema>;

export const calendarArrangementResultSchema = z
  .object({
    outcome: z.literal("completed"),
    arrangement: z.literal("calendar"),
    plan: arrangementSourcePlanSchema,
    declaredFieldIds: z.array(fieldIdSchema),
    calendarMapping: calendarMappingSchema,
    timeZone: z.string(),
    totalRowCount: z.number().int().nonnegative(),
    /** Ordered by start, then end, then record. */
    items: z.array(calendarItemSchema),
    /** Rows without a start, or whose end or duration cannot place them; plan order. */
    unscheduledRows: z.array(arrangementRowSchema),
  })
  .strict();
export type CalendarArrangementResult = z.infer<typeof calendarArrangementResultSchema>;

export const summaryGroupSchema = tableGroupSchema.omit({ rows: true }).strict();
export type SummaryGroup = z.infer<typeof summaryGroupSchema>;

export const summaryArrangementResultSchema = z
  .object({
    outcome: z.literal("completed"),
    arrangement: z.literal("summary"),
    plan: arrangementSourcePlanSchema,
    groupByFieldIds: z.array(fieldIdSchema),
    totalRowCount: z.number().int().nonnegative(),
    /** Empty when the summary is not grouped. */
    groups: z.array(summaryGroupSchema),
    aggregates: aggregateResultsSchema,
  })
  .strict();
export type SummaryArrangementResult = z.infer<typeof summaryArrangementResultSchema>;

export const arrangementRefusalReasonCodes = [
  /** The command does not match the arrangement contract. */
  "request_invalid",
  /** A named field is not in the plan, or does not permit that use. */
  "descriptor_invalid",
  /** The plan result repeats a record or holds a value unlike its declared type. */
  "dataset_invalid",
  /** The complete result is larger than one arrangement accepts. */
  "dataset_limit_exceeded",
  /** The calendar time zone is not a known IANA zone. */
  "time_zone_invalid",
] as const;
export type ArrangementRefusalReasonCode = (typeof arrangementRefusalReasonCodes)[number];

/** One neutral refusal; it names no field value. */
export const arrangementRefusalSchema = z
  .object({
    outcome: z.literal("refused"),
    reasonCode: z.enum(arrangementRefusalReasonCodes),
  })
  .strict();
export type ArrangementRefusal = z.infer<typeof arrangementRefusalSchema>;

export const arrangementResultSchema = z.union([
  z.discriminatedUnion("arrangement", [
    tableArrangementResultSchema,
    boardArrangementResultSchema,
    calendarArrangementResultSchema,
    summaryArrangementResultSchema,
  ]),
  arrangementRefusalSchema,
]);
export type ArrangementResult = z.infer<typeof arrangementResultSchema>;
