import "server-only";

export {
  prepareRecordsExport,
  recordsCsvFormat,
  recordsXlsxFormat,
  type RecordsXlsxColumn,
  type RecordsExportCell,
  type RecordsExportPage,
  type RecordsExportFormat,
  type RecordsExportOutcome,
} from "./export-records";

export {
  protectedQueryCommandSchema,
  protectedQueryBoardColumnSchema,
  protectedQueryBoardSelectorSchema,
  protectedQueryBoardMembersCommandSchema,
  protectedQueryGroupedMembersCommandSchema,
  protectedQueryGroupedMembersResultSchema,
  protectedQueryTreeLevelCommandSchema,
  protectedQueryTreeRowSchema,
  protectedQueryTreeLevelResultSchema,
  protectedQueryRowSchema,
  protectedQueryPageRowSchema,
  protectedQueryRowCapabilitiesSchema,
  protectedQueryRefusalReasonCodes,
  protectedQueryPageSchema,
  protectedQueryResultSchema,
  protectedQuerySummaryCommandSchema,
  protectedQuerySummaryAggregateResultSchema,
  protectedQuerySummaryResultSchema,
  protectedQueryBoardSummaryCommandSchema,
  protectedQueryBoardSummaryColumnSchema,
  protectedQueryBoardSummaryUnassignedSchema,
  protectedQueryBoardSummaryResultSchema,
  type ProtectedQueryCommand,
  type ProtectedQueryBoardSelector,
  type ProtectedQueryBoardMembersCommand,
  type ProtectedQueryGroupedMembersCommand,
  type ProtectedQueryGroupedMembersResult,
  type ProtectedQueryTreeLevelCommand,
  type ProtectedQueryTreeLevelResult,
  type ProtectedQueryRow,
  type ProtectedQueryPageRow,
  type ProtectedQueryRefusalReasonCode,
  type ProtectedQueryFieldBounds,
  type ProtectedQueryPage,
  type ProtectedQueryResult,
  type ProtectedQuerySummaryCommand,
  type ProtectedQuerySummaryCompleted,
  type ProtectedQuerySummaryAggregateResult,
  type ProtectedQueryPivotResult,
  type ProtectedQuerySummaryResult,
  type ProtectedQueryBoardSummaryCommand,
  type ProtectedQueryBoardSummaryResult,
} from "./protected-query-contracts";

export {
  supportedRecordSystemFieldKeySchema,
  recordSystemValuesSchema,
} from "./record-system-values";

export { tableReadCandidatesPerRequest } from "./protected-query-table";

export {
  createProtectedQueryService,
  type ProtectedReadDecider,
  type ProtectedQueryServiceDependencies,
} from "./protected-query-service";

export {
  createViewerSafeRecordLinkReadService,
  type ViewerSafeRecordLinkReadService,
  viewerSafeRecordLinkTitleKey,
  viewerSafeRecordLinkTitleRecordLimit,
  viewerSafeRecordLinkTitleTypeLimit,
} from "./viewer-safe-record-link-read";

export type { QueryContinuationKey } from "./continuation-token";

export {
  arrangementRowLimit,
  arrangementCommandSchema,
  type ArrangementField,
  type TableArrangementDescriptor,
  type BoardArrangementDescriptor,
  type CalendarArrangementDescriptor,
  protectedBoardArrangementPageSchema,
  protectedBoardArrangementCommandSchema,
  protectedBoardArrangementResultSchema,
  type ProtectedBoardArrangementPage,
  type ProtectedBoardArrangementCommand,
  type ProtectedBoardArrangementResult,
  type AggregateDescriptor,
  type AggregateResult,
  type ArrangementRow,
  type TableArrangementResult,
  type BoardArrangementResult,
  type CalendarItem,
  type CalendarArrangementResult,
  type ArrangementRefusalReasonCode,
  type ArrangementRefusal,
  type ArrangementResult,
} from "./arrangement-contracts";

export { arrangeDataset, arrangeProtectedBoard } from "./arrangements";

export {
  createRecordChoiceReader,
  recordChoicePageSizes,
  titleText,
  type RecordChoice,
  type RecordChoiceAdmission,
  type RecordChoiceCommand,
} from "./record-choices";
