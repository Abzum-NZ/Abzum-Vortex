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
  recordReferenceChoiceCommandSchema,
  organizationAccountReferenceChoiceCommandSchema,
  referenceChoiceCommandSchema,
  referenceChoiceOptionSchema,
  referenceChoiceRefusalReasonCodes,
  referenceChoiceRefusalSchema,
  referenceChoicePageSchema,
  referenceChoiceResultSchema,
  type RecordReferenceChoiceCommand,
  type OrganizationAccountReferenceChoiceCommand,
  type ReferenceChoiceCommand,
  type ReferenceChoiceOption,
  type ReferenceChoiceRefusalReasonCode,
  type ReferenceChoiceRefusal,
  type ReferenceChoicePage,
  type ReferenceChoiceResult,
} from "./reference-choice-contracts";

export {
  createReferenceChoiceService,
  deriveRecordReferenceChoices,
  deriveAccountReferenceChoices,
  projectReferenceChoicesToControlValues,
  validateReferenceChoiceSubmission,
  type ChoiceOption,
  type ChoiceInputControlProjection,
  type ActiveAccountCandidate,
  type ReferenceChoiceServiceDependencies,
} from "./reference-choice-service";

export const QueryService = Object.freeze({
  key: "query",
  boundary: "@vortex/query",
});
