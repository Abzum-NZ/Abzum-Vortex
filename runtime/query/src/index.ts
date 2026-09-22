import "server-only";

export {
  protectedQueryScopeSchema,
  protectedQueryRequestSchema,
  protectedQueryRowSchema,
  protectedQueryRefusalReasonCodes,
  protectedQueryRefusalSchema,
  protectedQueryPageSchema,
  protectedQueryResultSchema,
  ProtectedQueryRefusalOutcome,
  type ProtectedQueryScope,
  type ProtectedQueryRequest,
  type ProtectedQueryRow,
  type ProtectedQueryRefusalReasonCode,
  type ProtectedQueryRefusal,
  type ProtectedQueryPage,
  type ProtectedQueryResult,
} from "./protected-query-contracts";

export type {
  ProtectedQueryFieldBounds,
  ProtectedQueryFieldBoundsResolver,
  ProtectedQueryCandidateRecord,
  ProtectedQueryCandidateSource,
} from "./protected-query-ports";

export {
  runProtectedQuery,
  type ProtectedQueryDependencies,
} from "./protected-query-service";

export {
  queryContinuationPositionSchema,
  encodeQueryContinuationToken,
  decodeQueryContinuationToken,
  createHmacQueryContinuationSigner,
  QueryContinuationTokenError,
  type QueryContinuationPosition,
  type QueryContinuationPositionInput,
  type QueryContinuationSigner,
} from "./continuation-token";

export {
  deriveFieldSemanticType,
  valueMatchesSemanticType,
  compareTypedValues,
  typedValuesEqual,
  QueryValueComparisonError,
  type QuerySemanticType,
} from "./field-semantics";

export {
  evaluateQueryCondition,
  queryConditionRefusalReasons,
  QueryConditionRefusalError,
  type QueryConditionContext,
  type QueryConditionRefusalReason,
} from "./condition-evaluator";

export {
  validateQueryInputValues,
  queryInputRefusalReasons,
  QueryInputRefusalError,
  type QueryInputRefusalReason,
} from "./typed-input-validation";

export const QueryService = Object.freeze({
  key: "query",
  boundary: "@vortex/query",
});
