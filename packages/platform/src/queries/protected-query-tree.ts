import "server-only";

import type { z } from "zod";
import type { RequestDatabaseTransaction } from "../db/index";
import {
  type JsonValue,
  type SelectedOrganizationScope,
  type IdentitySession,
  sameId,
} from "../schema";
import {
  type QueryContinuation,
  type QueryContinuationKey,
  decodeQueryContinuationToken,
  QueryContinuationTokenError,
  fingerprintQueryInputs,
  encodeQueryContinuationToken,
} from "./continuation-token";
import {
  type ProtectedQueryTreeLevelCommand,
  protectedQueryTreeLevelResultSchema,
} from "./protected-query-contracts";
import {
  type ResultRow,
  one,
  filterInputRefusal,
  readInputs,
  normalizeConditionFieldIdentifiers,
} from "./protected-query-helpers";
import { treeLevelPageReadSchema, type pageAnchorSchema } from "./protected-query-read-schemas";
import {
  parseQueryInputDeclarations,
  validateQueryInputValues,
  QueryInputRefusalError,
} from "./typed-input-validation";

const readTreeLevelPage = async (
  transaction: RequestDatabaseTransaction,
  command: ProtectedQueryTreeLevelCommand,
  releaseRevision: number,
  inputValues: Readonly<Record<string, JsonValue>>,
  after: QueryContinuation | undefined,
) => {
  const rows = await transaction.query<ResultRow>`
    select vortex_record.run_module_query(
      ${command.moduleRootId}::uuid,
      ${command.queryId}::uuid,
      ${releaseRevision}::bigint,
      ${JSON.stringify(inputValues)}::text::jsonb,
      ${JSON.stringify(command.requestedFieldIds)}::text::jsonb,
      ${command.pageSize}::integer,
      ${after === undefined ? null : JSON.stringify({ sort: after.sort, sortKey: after.sortKey, phase: after.phase, recordId: after.recordId })}::text::jsonb,
      ${JSON.stringify(command.requestedSystemFieldKeys)}::text::jsonb,
      ${JSON.stringify({
        sort: command.sort,
        filter: command.filter ?? null,
        search: command.search ?? null,
        sortableFieldIds: command.sortableFieldIds,
        filterableFieldIds: command.filterableFieldIds,
        searchableFieldIds: command.searchableFieldIds,
        tree: { fieldId: command.parentFieldId, parentRecordId: command.parentRecordId },
      })}::text::jsonb,
      ${command.pageDirection ?? "forward"}::text,
      ${null}::uuid[]
    ) as result
  `;
  return treeLevelPageReadSchema.parse(one(rows));
};

/**
 * Reads one page of one level of a tree: the roots, or the children of one parent. It is the
 * Query engine's own list read narrowed to that level, with the same keyset order, so a level
 * pages exactly as a flat table does; each row also says whether the reader may read a child of
 * it, worked out for the whole page at once. A level is never cached or shared, and its
 * continuation token binds the actor, the parent link, the parent and the whole read shape.
 */
export const treeLevelCommand = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  caller: IdentitySession,
  command: ProtectedQueryTreeLevelCommand,
  continuationKey: QueryContinuationKey,
): Promise<z.infer<typeof protectedQueryTreeLevelResultSchema>> => {
  const applicationRootId = scope.applicationRootId;
  if (applicationRootId === undefined) return { outcome: "refused", reasonCode: "request_invalid" };
  const filterRefusal = filterInputRefusal(command);
  if (filterRefusal !== undefined) return { outcome: "refused", reasonCode: filterRefusal };

  const sortable = new Set(command.sortableFieldIds.map((id) => id.toLowerCase()));
  if (command.sort.some((key) => !sortable.has(key.fieldId.toLowerCase())))
    return { outcome: "refused", reasonCode: "sort_invalid" };
  const direction = command.pageDirection ?? "forward";
  let after: QueryContinuation | undefined;
  if (command.continuationToken !== undefined) {
    try {
      after = decodeQueryContinuationToken(command.continuationToken, continuationKey);
    } catch (error) {
      if (error instanceof QueryContinuationTokenError)
        return { outcome: "refused", reasonCode: "cursor_invalid" };
      throw error;
    }
    if (
      !sameId(after.organizationId, scope.organizationId) ||
      !sameId(after.applicationRootId, applicationRootId) ||
      !sameId(after.organizationAccountId, scope.organizationAccountId) ||
      !sameId(after.moduleRootId, command.moduleRootId) ||
      !sameId(after.queryId, command.queryId) ||
      after.direction !== direction
    )
      return { outcome: "refused", reasonCode: "cursor_stale" };
  }

  const declared = await readInputs(transaction, command);
  if (declared.outcome === "refused")
    return { outcome: "refused", reasonCode: declared.reasonCode };
  if (after !== undefined && after.moduleReleaseRevision !== declared.moduleReleaseRevision)
    return { outcome: "refused", reasonCode: "cursor_stale" };
  const declarations = parseQueryInputDeclarations(declared.inputs);
  if (declarations === undefined) return { outcome: "refused", reasonCode: "descriptor_invalid" };

  let inputValues: Readonly<Record<string, JsonValue>>;
  try {
    inputValues = validateQueryInputValues(declarations, command.inputValues);
  } catch (error) {
    if (error instanceof QueryInputRefusalError)
      return { outcome: "refused", reasonCode: "input_invalid" };
    throw error;
  }

  const inputFingerprint = fingerprintQueryInputs({
    operation: "protected-tree-level",
    actorIdentityId: caller.identityId,
    inputValues,
    parentFieldId: command.parentFieldId.toLowerCase(),
    parentRecordId: command.parentRecordId?.toLowerCase() ?? null,
    filter: normalizeConditionFieldIdentifiers(command.filter ?? null),
    filterableFieldIds: command.filterableFieldIds.map((fieldId) => fieldId.toLowerCase()).sort(),
    requestedFieldIds: command.requestedFieldIds.map((fieldId) => fieldId.toLowerCase()).sort(),
    requestedSystemFieldKeys: [...command.requestedSystemFieldKeys].sort(),
    // A keyset position is independent of page size: each read can shrink to the remaining row budget.
    sort: command.sort.map((key) => ({ ...key, fieldId: key.fieldId.toLowerCase() })),
    search: command.search ?? null,
    sortableFieldIds: command.sortableFieldIds.map((id) => id.toLowerCase()).sort(),
    searchableFieldIds: command.searchableFieldIds.map((id) => id.toLowerCase()).sort(),
  });
  if (after !== undefined && after.inputFingerprint !== inputFingerprint)
    return { outcome: "refused", reasonCode: "cursor_stale" };

  const page = await readTreeLevelPage(
    transaction,
    command,
    declared.moduleReleaseRevision,
    inputValues,
    after,
  );
  if (page.outcome === "refused") return { outcome: "refused", reasonCode: page.reasonCode };
  if (
    page.moduleReleaseRevision !== declared.moduleReleaseRevision ||
    page.moduleReleaseVersion !== declared.moduleReleaseVersion
  )
    throw new Error("PROTECTED_QUERY_RESULT_INVALID");

  const requestedFieldIds = new Set(
    command.requestedFieldIds.map((fieldId) => fieldId.toLowerCase()),
  );
  const declaredSystemKeys = new Set<string>(command.requestedSystemFieldKeys);
  for (const row of page.rows) {
    const disclosedFieldIds = Object.keys(row.values).map((fieldId) => fieldId.toLowerCase());
    const disclosedSystemKeys = Object.keys(row.systemValues ?? {});
    if (
      new Set(disclosedFieldIds).size !== disclosedFieldIds.length ||
      disclosedFieldIds.some((fieldId) => !requestedFieldIds.has(fieldId)) ||
      disclosedSystemKeys.some((key) => !declaredSystemKeys.has(key)) ||
      declaredSystemKeys.size > 0 !== (row.systemValues !== undefined) ||
      declaredSystemKeys.size !== disclosedSystemKeys.length
    )
      throw new Error("PROTECTED_QUERY_RESULT_INVALID");
  }

  const seal = (anchor: z.infer<typeof pageAnchorSchema>, tokenDirection: "forward" | "backward") =>
    encodeQueryContinuationToken(
      {
        version: 1,
        direction: tokenDirection,
        organizationId: scope.organizationId,
        applicationRootId,
        organizationAccountId: scope.organizationAccountId,
        moduleRootId: command.moduleRootId,
        queryId: command.queryId,
        moduleReleaseRevision: page.moduleReleaseRevision,
        inputFingerprint,
        ...anchor,
      },
      continuationKey,
    );
  // SQL's next anchor follows the scan direction; opposite is the first returned row.
  const next =
    direction === "forward"
      ? page.next === null
        ? undefined
        : seal(page.next, "forward")
      : after === undefined || page.opposite === null
        ? undefined
        : seal(page.opposite, "forward");
  const previous =
    direction === "backward"
      ? page.next === null
        ? undefined
        : seal(page.next, "backward")
      : after === undefined || page.opposite === null
        ? undefined
        : seal(page.opposite, "backward");
  return protectedQueryTreeLevelResultSchema.parse({
    outcome: "completed",
    moduleRootId: command.moduleRootId,
    moduleReleaseVersion: page.moduleReleaseVersion,
    queryId: command.queryId,
    rows: page.rows,
    fieldBounds: page.fieldBounds,
    scanLimited: page.next !== null && page.rows.length < command.pageSize,
    ...(next === undefined ? {} : { nextContinuationToken: next }),
    ...(previous === undefined ? {} : { previousContinuationToken: previous }),
  });
};
