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
  createProtectedQueryService,
  type ProtectedQueryServiceDependencies,
} from "./protected-query-service";

export type { QueryContinuationKey } from "./continuation-token";

export const QueryService = Object.freeze({
  key: "query",
  boundary: "@vortex/query",
});
