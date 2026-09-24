import "server-only";

export {
  protectedQueryCommandSchema,
  protectedQueryRowSchema,
  protectedQueryRefusalReasonCodes,
  protectedQueryRefusalSchema,
  protectedQueryPageSchema,
  protectedQueryResultSchema,
  type ProtectedQueryCommand,
  type ProtectedQueryRow,
  type ProtectedQueryRefusalReasonCode,
  type ProtectedQueryRefusal,
  type ProtectedQueryPage,
  type ProtectedQueryResult,
} from "./protected-query-contracts";

export {
  supportedRecordSystemFieldKeys,
  supportedRecordSystemFieldKeySchema,
  recordSystemValuesSchema,
  type SupportedRecordSystemFieldKey,
  type RecordSystemValues,
} from "./record-system-values";

export {
  createProtectedQueryService,
  type ProtectedQueryServiceDependencies,
} from "./protected-query-service";

export type { QueryContinuationKey } from "./continuation-token";

export {
  arrangementRowLimit,
  boardChoiceOptionLimit,
  arrangementCommandSchema,
  arrangementResultSchema,
  arrangementRefusalReasonCodes,
  type ArrangementCommand,
  type ArrangementDataset,
  type ArrangementField,
  type ArrangementDescriptor,
  type TableArrangementDescriptor,
  type BoardArrangementDescriptor,
  type CalendarArrangementDescriptor,
  type SummaryArrangementDescriptor,
  type AggregateDescriptor,
  type AggregateValue,
  type AggregateResult,
  type ArrangementRow,
  type TableGroup,
  type TableArrangementResult,
  type BoardArrangementResult,
  type CalendarItem,
  type CalendarArrangementResult,
  type SummaryGroup,
  type SummaryArrangementResult,
  type ArrangementRefusalReasonCode,
  type ArrangementRefusal,
  type ArrangementResult,
} from "./arrangement-contracts";

export { arrangeDataset } from "./arrangements";

export {
  createUsageProjectionService,
  usageProjectionCommandSchema,
  usageProjectionResultSchema,
  type UsageProjectionCommand,
  type UsageProjectionResult,
  type UsageProjectionServiceDependencies,
} from "./usage-projection";

export {
  organizationAccountReferenceChoiceCommandSchema,
  recordReferenceChoiceCommandSchema,
  referenceChoiceCommandSchema,
  referenceChoiceOptionSchema,
  referenceChoicePageSchema,
  referenceChoiceRefusalReasonCodes,
  referenceChoiceRefusalSchema,
  referenceChoiceResultSchema,
  referenceChoiceValueSchema,
  type OrganizationAccountReferenceChoiceCommand,
  type RecordReferenceChoiceCommand,
  type ReferenceChoiceCommand,
  type ReferenceChoiceOption,
  type ReferenceChoicePage,
  type ReferenceChoiceRefusal,
  type ReferenceChoiceRefusalReasonCode,
  type ReferenceChoiceResult,
  type ReferenceChoiceValue,
} from "./reference-choice-contracts";

export {
  createReferenceChoiceService,
  projectReferenceChoiceInputValues,
  resolveReferenceChoiceSelection,
  type ReferenceChoiceInputValues,
  type ReferenceChoiceServiceDependencies,
} from "./reference-choice-service";

export {
  createActivityHistoryService,
  activityHistoryCommandSchema,
  activityHistoryPageCommandSchema,
  activityHistoryAggregateCommandSchema,
  activityHistoryEntrySchema,
  activityHistoryRefusalReasonCodes,
  activityHistoryRefusalSchema,
  activityHistoryPageSchema,
  activityHistoryAggregateSchema,
  activityHistoryResultSchema,
  activityAggregateGroupSchema,
  type ActivityHistoryCommand,
  type ActivityHistoryEntry,
  type ActivityHistoryRefusalReasonCode,
  type ActivityHistoryRefusal,
  type ActivityHistoryPage,
  type ActivityHistoryAggregate,
  type ActivityHistoryResult,
  type ActivityAggregateGroup,
  type ActivityHistoryServiceDependencies,
} from "./activity-history";

export {
  decideQueryCache,
  queryCacheBypassReasons,
  queryCacheInputSchema,
  queryCacheKeyVersion,
  queryCacheMaxRecordDependencies,
  queryCacheMaxTtlSeconds,
  type QueryCacheBypassReason,
  type QueryCacheDecision,
  type QueryCacheInput,
} from "./cache-policy";

export {
  readThroughQueryCache,
  type QueryCacheAdapterOptions,
  type QueryCacheReadResult,
  type QueryCacheState,
  type SharedCacheStore,
} from "./shared-cache-adapter";

export const QueryService = Object.freeze({
  key: "query",
  boundary: "@vortex/query",
});
