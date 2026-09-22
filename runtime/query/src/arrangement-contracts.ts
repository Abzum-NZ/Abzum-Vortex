import "server-only";

import { z } from "zod";
import {
  builderKeySchema,
  calendarMappingSchema,
  currencyCodeV2Schema,
  dateValueV2Schema,
  exactDecimalTextV2Schema,
  fieldIdSchema,
  jsonValueSchema,
  moduleQueryAggregateSchema,
  moduleRootIdSchema,
  moneyValueV2Schema,
  queryIdSchema,
  recordIdSchema,
  stableDefinitionReleaseVersionSchema,
  type CalendarMapping,
  type ModuleQueryAggregate,
} from "@vortex/contracts";
import {
  protectedQueryRowSchema,
  type ProtectedQueryRow,
} from "./protected-query-contracts";

/**
 * Plan identity declared on every arrangement output, establishing its source
 * Module query and release.
 */
export const arrangementSourcePlanIdentitySchema = z
  .object({
    moduleRootId: moduleRootIdSchema,
    moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
    queryId: queryIdSchema,
  })
  .strict();
export type ArrangementSourcePlanIdentity = z.infer<
  typeof arrangementSourcePlanIdentitySchema
>;

/**
 * An authorized unpaged dataset produced from #572 protected query execution,
 * consumed by pure arrangement functions.
 */
export const arrangementDatasetSchema = z
  .object({
    plan: arrangementSourcePlanIdentitySchema,
    rows: z.array(protectedQueryRowSchema),
  })
  .strict();
export type ArrangementDataset = z.infer<typeof arrangementDatasetSchema>;

/**
 * Reason codes when an aggregate computation returns a typed refusal.
 */
export const aggregateRefusalReasonCodes = [
  "mixed_currency",
  "incompatible_type",
  "descriptor_invalid",
] as const;
export type AggregateRefusalReasonCode = (typeof aggregateRefusalReasonCodes)[number];

export const aggregateRefusalSchema = z
  .object({
    outcome: z.literal("refused"),
    reasonCode: z.enum(aggregateRefusalReasonCodes),
    currencies: z.array(currencyCodeV2Schema).optional(),
    message: z.string().optional(),
  })
  .strict();
export type AggregateRefusal = z.infer<typeof aggregateRefusalSchema>;

export const aggregateValueSchema = z.union([
  z.number().int(),
  exactDecimalTextV2Schema,
  moneyValueV2Schema,
  dateValueV2Schema,
  z.iso.datetime({ offset: true }),
  z.string(),
  z.null(),
]);
export type AggregateValue = z.infer<typeof aggregateValueSchema>;

export const aggregateSuccessSchema = z
  .object({
    outcome: z.literal("completed"),
    value: aggregateValueSchema,
  })
  .strict();
export type AggregateSuccess = z.infer<typeof aggregateSuccessSchema>;

export const aggregateComputationResultSchema = z.discriminatedUnion("outcome", [
  aggregateSuccessSchema,
  aggregateRefusalSchema,
]);
export type AggregateComputationResult = z.infer<
  typeof aggregateComputationResultSchema
>;

export const aggregateDescriptorSchema = z
  .object({
    operation: z.enum(["count", "sum", "minimum", "maximum", "average"]),
    fieldId: fieldIdSchema.optional(),
    alias: builderKeySchema,
    decimalPlaces: z.number().int().min(0).max(12).optional(),
  })
  .strict();
export type AggregateDescriptor = z.infer<typeof aggregateDescriptorSchema>;

/**
 * Reason codes when an arrangement transform returns a typed refusal.
 */
export const arrangementRefusalReasonCodes = [
  "descriptor_invalid",
  "choice_options_exceeded",
  "calendar_mapping_invalid",
  "mixed_currency",
] as const;
export type ArrangementRefusalReasonCode =
  (typeof arrangementRefusalReasonCodes)[number];

export const arrangementRefusalSchema = z
  .object({
    outcome: z.literal("refused"),
    reasonCode: z.enum(arrangementRefusalReasonCodes),
    message: z.string().optional(),
  })
  .strict();
export type ArrangementRefusal = z.infer<typeof arrangementRefusalSchema>;

// ============================================================================
// Table arrangement
// ============================================================================

export const tableGroupSchema = z
  .object({
    groupKey: z.string(),
    groupValues: z.record(fieldIdSchema, jsonValueSchema),
    rowCount: z.number().int().nonnegative(),
    rows: z.array(protectedQueryRowSchema),
    aggregates: z.record(builderKeySchema, aggregateComputationResultSchema),
  })
  .strict();
export type TableGroup = z.infer<typeof tableGroupSchema>;

export const flatTableArrangementResultSchema = z
  .object({
    outcome: z.literal("completed"),
    arrangement: z.literal("table"),
    plan: arrangementSourcePlanIdentitySchema,
    declaredFieldIds: z.array(fieldIdSchema),
    totalRowCount: z.number().int().nonnegative(),
    grouped: z.literal(false),
    rows: z.array(protectedQueryRowSchema),
    aggregates: z.record(builderKeySchema, aggregateComputationResultSchema),
  })
  .strict();
export type FlatTableArrangementResult = z.infer<
  typeof flatTableArrangementResultSchema
>;

export const groupedTableArrangementResultSchema = z
  .object({
    outcome: z.literal("completed"),
    arrangement: z.literal("table"),
    plan: arrangementSourcePlanIdentitySchema,
    declaredFieldIds: z.array(fieldIdSchema),
    totalRowCount: z.number().int().nonnegative(),
    grouped: z.literal(true),
    groupByFieldIds: z.array(fieldIdSchema).min(1).max(10),
    groups: z.array(tableGroupSchema),
    overallAggregates: z.record(builderKeySchema, aggregateComputationResultSchema),
  })
  .strict();
export type GroupedTableArrangementResult = z.infer<
  typeof groupedTableArrangementResultSchema
>;

export const tableArrangementResultSchema = z.discriminatedUnion("grouped", [
  flatTableArrangementResultSchema,
  groupedTableArrangementResultSchema,
]);
export type TableArrangementResult = z.infer<typeof tableArrangementResultSchema>;

export const tableArrangementDescriptorSchema = z
  .object({
    type: z.literal("table").default("table"),
    declaredFieldIds: z.array(fieldIdSchema).min(1).max(200),
    groupByFieldIds: z.array(fieldIdSchema).max(10).optional(),
    aggregates: z.array(aggregateDescriptorSchema).max(20).optional(),
  })
  .strict();
export type TableArrangementDescriptor = z.infer<
  typeof tableArrangementDescriptorSchema
>;

// ============================================================================
// Board arrangement
// ============================================================================

export const choiceOptionItemSchema = z
  .object({
    value: z.string().min(1).max(120),
    label: z.string().min(1).max(120).optional(),
  })
  .strict();

export const choiceOptionSchema = z.union([
  choiceOptionItemSchema,
  z
    .string()
    .min(1)
    .max(120)
    .transform((val) => ({ value: val, label: val })),
]);
export type ChoiceOption = z.infer<typeof choiceOptionSchema>;

export const boardColumnSchema = z
  .object({
    columnId: z.string(),
    label: z.string(),
    rowCount: z.number().int().nonnegative(),
    rows: z.array(protectedQueryRowSchema),
    aggregates: z.record(builderKeySchema, aggregateComputationResultSchema),
  })
  .strict();
export type BoardColumn = z.infer<typeof boardColumnSchema>;

export const boardArrangementResultSchema = z
  .object({
    outcome: z.literal("completed"),
    arrangement: z.literal("board"),
    plan: arrangementSourcePlanIdentitySchema,
    choiceFieldId: fieldIdSchema,
    declaredFieldIds: z.array(fieldIdSchema),
    totalRowCount: z.number().int().nonnegative(),
    columns: z.array(boardColumnSchema),
    overallAggregates: z.record(builderKeySchema, aggregateComputationResultSchema),
  })
  .strict();
export type BoardArrangementResult = z.infer<typeof boardArrangementResultSchema>;

export const boardArrangementDescriptorSchema = z
  .object({
    type: z.literal("board").default("board"),
    choiceFieldId: fieldIdSchema,
    choiceOptions: z.array(choiceOptionSchema).min(1).max(12),
    declaredFieldIds: z.array(fieldIdSchema).min(1).max(200),
    aggregates: z.array(aggregateDescriptorSchema).max(20).optional(),
    includeUnassignedColumn: z.boolean().optional(),
  })
  .strict();
export type BoardArrangementDescriptor = z.infer<
  typeof boardArrangementDescriptorSchema
>;

// ============================================================================
// Calendar arrangement
// ============================================================================

export const calendarItemSchema = z
  .object({
    recordId: recordIdSchema,
    start: z.string(),
    end: z.string().nullable(),
    values: z.record(fieldIdSchema, jsonValueSchema),
  })
  .strict();
export type CalendarItem = z.infer<typeof calendarItemSchema>;

export const calendarArrangementResultSchema = z
  .object({
    outcome: z.literal("completed"),
    arrangement: z.literal("calendar"),
    plan: arrangementSourcePlanIdentitySchema,
    calendarMapping: calendarMappingSchema,
    timeZone: z.string(),
    declaredFieldIds: z.array(fieldIdSchema),
    totalRowCount: z.number().int().nonnegative(),
    scheduledItemCount: z.number().int().nonnegative(),
    unscheduledRowCount: z.number().int().nonnegative(),
    items: z.array(calendarItemSchema),
    unscheduledRows: z.array(protectedQueryRowSchema),
  })
  .strict();
export type CalendarArrangementResult = z.infer<
  typeof calendarArrangementResultSchema
>;

export const calendarArrangementDescriptorSchema = z
  .object({
    type: z.literal("calendar").default("calendar"),
    calendarMapping: calendarMappingSchema,
    declaredFieldIds: z.array(fieldIdSchema).min(1).max(200),
    timeZone: z.string().min(1).max(64).optional(),
  })
  .strict();
export type CalendarArrangementDescriptor = z.infer<
  typeof calendarArrangementDescriptorSchema
>;

// ============================================================================
// Summary arrangement
// ============================================================================

export const summaryGroupSchema = z
  .object({
    groupKey: z.string(),
    groupValues: z.record(fieldIdSchema, jsonValueSchema),
    rowCount: z.number().int().nonnegative(),
    aggregates: z.record(builderKeySchema, aggregateComputationResultSchema),
  })
  .strict();
export type SummaryGroup = z.infer<typeof summaryGroupSchema>;

export const flatSummaryArrangementResultSchema = z
  .object({
    outcome: z.literal("completed"),
    arrangement: z.literal("summary"),
    plan: arrangementSourcePlanIdentitySchema,
    totalRowCount: z.number().int().nonnegative(),
    grouped: z.literal(false),
    aggregates: z.record(builderKeySchema, aggregateComputationResultSchema),
  })
  .strict();
export type FlatSummaryArrangementResult = z.infer<
  typeof flatSummaryArrangementResultSchema
>;

export const groupedSummaryArrangementResultSchema = z
  .object({
    outcome: z.literal("completed"),
    arrangement: z.literal("summary"),
    plan: arrangementSourcePlanIdentitySchema,
    totalRowCount: z.number().int().nonnegative(),
    grouped: z.literal(true),
    groupByFieldIds: z.array(fieldIdSchema).min(1).max(10),
    groups: z.array(summaryGroupSchema),
    aggregates: z.record(builderKeySchema, aggregateComputationResultSchema),
  })
  .strict();
export type GroupedSummaryArrangementResult = z.infer<
  typeof groupedSummaryArrangementResultSchema
>;

export const summaryArrangementResultSchema = z.discriminatedUnion("grouped", [
  flatSummaryArrangementResultSchema,
  groupedSummaryArrangementResultSchema,
]);
export type SummaryArrangementResult = z.infer<
  typeof summaryArrangementResultSchema
>;

export const summaryArrangementDescriptorSchema = z
  .object({
    type: z.literal("summary").default("summary"),
    aggregates: z.array(aggregateDescriptorSchema).min(1).max(20),
    groupByFieldIds: z.array(fieldIdSchema).max(10).optional(),
    declaredFieldIds: z.array(fieldIdSchema).max(200).optional(),
  })
  .strict();
export type SummaryArrangementDescriptor = z.infer<
  typeof summaryArrangementDescriptorSchema
>;

// ============================================================================
// Combined descriptors and results
// ============================================================================

export const arrangementDescriptorSchema = z.discriminatedUnion("type", [
  tableArrangementDescriptorSchema,
  boardArrangementDescriptorSchema,
  calendarArrangementDescriptorSchema,
  summaryArrangementDescriptorSchema,
]);
export type ArrangementDescriptor = z.infer<typeof arrangementDescriptorSchema>;

export const arrangementCompletedResultSchema = z.discriminatedUnion("arrangement", [
  flatTableArrangementResultSchema,
  groupedTableArrangementResultSchema,
  boardArrangementResultSchema,
  calendarArrangementResultSchema,
  flatSummaryArrangementResultSchema,
  groupedSummaryArrangementResultSchema,
]);
export type ArrangementCompletedResult = z.infer<
  typeof arrangementCompletedResultSchema
>;

export const arrangementResultSchema = z.union([
  flatTableArrangementResultSchema,
  groupedTableArrangementResultSchema,
  boardArrangementResultSchema,
  calendarArrangementResultSchema,
  flatSummaryArrangementResultSchema,
  groupedSummaryArrangementResultSchema,
  arrangementRefusalSchema,
]);
export type ArrangementResult = z.infer<typeof arrangementResultSchema>;

export const arrangementCommandSchema = z
  .object({
    dataset: arrangementDatasetSchema,
    descriptor: arrangementDescriptorSchema,
  })
  .strict();
export type ArrangementCommand = z.infer<typeof arrangementCommandSchema>;
