import "server-only";

import type {
  ConditionNode,
  FieldDefinition,
  FieldId,
  JsonValue,
  RecordId,
} from "@vortex/contracts";
import { evaluateQueryCondition, QueryConditionRefusalError } from "./condition-evaluator";
import {
  decodeQueryContinuationToken,
  encodeQueryContinuationToken,
  QueryContinuationTokenError,
  type QueryContinuationSigner,
} from "./continuation-token";
import {
  compareTypedValues,
  deriveFieldSemanticType,
  QueryValueComparisonError,
} from "./field-semantics";
import {
  protectedQueryRequestSchema,
  ProtectedQueryRefusalOutcome,
  protectedQueryScopeSchema,
  type ProtectedQueryRefusalReasonCode,
  type ProtectedQueryRequest,
  type ProtectedQueryResult,
} from "./protected-query-contracts";
import type {
  ProtectedQueryCandidateRecord,
  ProtectedQueryCandidateSource,
  ProtectedQueryFieldBoundsResolver,
} from "./protected-query-ports";
import { QueryInputRefusalError, validateQueryInputValues } from "./typed-input-validation";

export interface ProtectedQueryDependencies {
  readonly fieldBounds: ProtectedQueryFieldBoundsResolver;
  readonly candidateSource: ProtectedQueryCandidateSource;
  readonly continuationSigner: QueryContinuationSigner;
  /** The descriptor's record type's own field definitions, from the same installed release. */
  readonly recordTypeFields: readonly FieldDefinition[];
}

const refuse = (reasonCode: ProtectedQueryRefusalReasonCode): never => {
  throw new ProtectedQueryRefusalOutcome(reasonCode);
};

const collectFieldReferences = (condition: ConditionNode, into: Set<string>): void => {
  if (condition.kind === "all" || condition.kind === "any") {
    condition.conditions.forEach((child) => collectFieldReferences(child, into));
    return;
  }
  if (condition.kind === "not") {
    collectFieldReferences(condition.condition, into);
    return;
  }
  const left = condition.left as { source: string; fieldId?: string };
  if (left.source === "field" && left.fieldId) into.add(left.fieldId);
  if (condition.right) {
    const right = condition.right as { source: string; fieldId?: string };
    if (right.source === "field" && right.fieldId) into.add(right.fieldId);
  }
};

/** A tiebreaker-inclusive sort key: one typed value per descriptor sort entry, plus the record id. */
const sortKeyFor = (
  candidate: ProtectedQueryCandidateRecord,
  sortFieldIds: readonly FieldId[],
): readonly JsonValue[] => [...sortFieldIds.map((fieldId) => candidate.values[fieldId] ?? null)];

const compareSortKeys = (
  left: readonly JsonValue[],
  right: readonly JsonValue[],
  leftRecordId: string,
  rightRecordId: string,
  sortFields: readonly Readonly<{ fieldId: FieldId; direction: "ascending" | "descending" }>[],
  fieldsById: ReadonlyMap<FieldId, FieldDefinition>,
): number => {
  for (let index = 0; index < sortFields.length; index += 1) {
    const sortField = sortFields[index]!;
    const field = fieldsById.get(sortField.fieldId);
    if (!field) refuse("sort_invalid");
    const type = deriveFieldSemanticType(field!);
    let comparison: number;
    try {
      comparison = compareTypedValues(left[index] ?? null, right[index] ?? null, type);
    } catch (error) {
      if (error instanceof QueryValueComparisonError) return refuse("sort_invalid");
      throw error;
    }
    if (comparison !== 0) return sortField.direction === "ascending" ? comparison : -comparison;
  }
  return leftRecordId.toLowerCase() < rightRecordId.toLowerCase()
    ? -1
    : leftRecordId.toLowerCase() > rightRecordId.toLowerCase()
      ? 1
      : 0;
};

const runProtectedQueryOrThrow = async (
  requestCandidate: ProtectedQueryRequest,
  dependencies: ProtectedQueryDependencies,
): Promise<ProtectedQueryResult> => {
  const parsedRequest = protectedQueryRequestSchema.safeParse(requestCandidate);
  if (!parsedRequest.success) refuse("scope_invalid");
  const request = parsedRequest.data!;

  const parsedScope = protectedQueryScopeSchema.safeParse(request.scope);
  if (!parsedScope.success) refuse("scope_invalid");
  const scope = parsedScope.data!;

  const descriptor = request.descriptor;
  const query = descriptor.query;
  if (query.recordType.state !== "resolved") refuse("descriptor_invalid");
  const recordType = { moduleRootId: query.recordType.moduleRootId, recordTypeId: query.recordType.recordTypeId };

  if (request.pageSize < 1 || request.pageSize > query.pageSize) refuse("page_size_invalid");
  if (query.relationshipHops > 0) refuse("relationship_invalid");

  let inputValues: Readonly<Record<string, JsonValue>>;
  try {
    inputValues = validateQueryInputValues(query.inputs, request.inputValues);
  } catch (error) {
    if (error instanceof QueryInputRefusalError) return refuse("input_invalid");
    throw error;
  }

  const bounds = await dependencies.fieldBounds.resolveReadableFieldBounds({ scope, recordType });

  if (!request.requestedFieldIds.every((fieldId) => query.selectedFieldIds.includes(fieldId)))
    refuse("field_unbounded");
  if (!request.requestedFieldIds.every((fieldId) => bounds.readableFieldIds.has(fieldId)))
    refuse("field_unbounded");

  const sortFieldIds = query.sort.map((entry) => entry.fieldId);
  if (!sortFieldIds.every((fieldId) => bounds.readableFieldIds.has(fieldId))) refuse("sort_invalid");

  const filterFieldIds = new Set<string>();
  if (query.filter) collectFieldReferences(query.filter, filterFieldIds);
  if (![...filterFieldIds].every((fieldId) => bounds.readableFieldIds.has(fieldId as FieldId)))
    refuse("filter_invalid");

  const referencedFieldIds = new Set<FieldId>([
    ...request.requestedFieldIds,
    ...sortFieldIds,
    ...([...filterFieldIds] as FieldId[]),
  ]);

  const fieldsById = new Map<FieldId, FieldDefinition>(
    dependencies.recordTypeFields.map((field) => [field.fieldId, field]),
  );
  for (const fieldId of referencedFieldIds) if (!fieldsById.has(fieldId)) refuse("descriptor_invalid");

  let cursor: { sortKey: readonly JsonValue[]; tiebreakerRecordId: string } | undefined;
  if (request.continuationToken !== undefined) {
    let position;
    try {
      position = decodeQueryContinuationToken(request.continuationToken, dependencies.continuationSigner);
    } catch (error) {
      if (error instanceof QueryContinuationTokenError) return refuse("cursor_invalid");
      throw error;
    }
    if (
      position.organizationId !== scope.organizationId ||
      position.applicationRootId !== scope.applicationRootId ||
      position.moduleRootId !== descriptor.moduleRootId ||
      position.moduleReleaseVersion !== descriptor.moduleReleaseVersion ||
      position.queryId !== query.queryId ||
      position.sortKey.length !== sortFieldIds.length
    )
      refuse("cursor_stale");
    cursor = { sortKey: position.sortKey, tiebreakerRecordId: position.tiebreakerRecordId };
  }

  const candidates = await dependencies.candidateSource.loadVisibleCandidates({
    scope,
    recordType,
    fieldIds: referencedFieldIds,
  });

  const filtered = query.filter
    ? candidates.filter((candidate) => {
        try {
          return evaluateQueryCondition(query.filter!, {
            fieldsById,
            fieldValues: candidate.values,
            parameterValues: inputValues,
          });
        } catch (error) {
          if (error instanceof QueryConditionRefusalError) return refuse("filter_invalid");
          throw error;
        }
      })
    : candidates;

  const sortFields = query.sort;
  const decorated = filtered.map((candidate) => ({
    candidate,
    sortKey: sortKeyFor(candidate, sortFieldIds),
  }));
  decorated.sort((left, right) =>
    compareSortKeys(
      left.sortKey,
      right.sortKey,
      left.candidate.recordId,
      right.candidate.recordId,
      sortFields,
      fieldsById,
    ),
  );

  const afterCursor = cursor
    ? decorated.filter(
        (entry) =>
          compareSortKeys(
            entry.sortKey,
            cursor!.sortKey,
            entry.candidate.recordId,
            cursor!.tiebreakerRecordId,
            sortFields,
            fieldsById,
          ) > 0,
      )
    : decorated;

  const page = afterCursor.slice(0, request.pageSize);
  const hasMore = afterCursor.length > page.length;

  const rows = page.map((entry) => ({
    recordId: entry.candidate.recordId as RecordId,
    values: Object.fromEntries(
      request.requestedFieldIds.map((fieldId) => [fieldId, entry.candidate.values[fieldId] ?? null]),
    ),
  }));

  const lastEntry = page.at(-1);
  const nextContinuationToken =
    hasMore && lastEntry
      ? encodeQueryContinuationToken(
          {
            organizationId: scope.organizationId,
            applicationRootId: scope.applicationRootId,
            moduleRootId: descriptor.moduleRootId,
            moduleReleaseVersion: descriptor.moduleReleaseVersion,
            queryId: query.queryId,
            sortKey: lastEntry.sortKey,
            tiebreakerRecordId: lastEntry.candidate.recordId,
          },
          dependencies.continuationSigner,
        )
      : undefined;

  return { outcome: "completed", rows, nextContinuationToken };
};

/**
 * Executes one protected Query request: resolves field bounds once, builds
 * only allowlisted predicates/order/projection from the published descriptor,
 * and refuses the whole request neutrally before any row is exposed. Never
 * accepts authored SQL, raw table/column names or a caller-selected database
 * target; row visibility and physical storage access are the injected
 * ports' responsibility (see protected-query-ports.ts).
 */
export const runProtectedQuery = async (
  request: ProtectedQueryRequest,
  dependencies: ProtectedQueryDependencies,
): Promise<ProtectedQueryResult> => {
  try {
    return await runProtectedQueryOrThrow(request, dependencies);
  } catch (error) {
    if (error instanceof ProtectedQueryRefusalOutcome)
      return { outcome: "refused", reasonCode: error.reasonCode };
    throw error;
  }
};
