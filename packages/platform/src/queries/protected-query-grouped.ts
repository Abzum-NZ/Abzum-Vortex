import "server-only";

import type { z } from "zod";
import type { RequestDatabaseTransaction } from "../db/index";
import {
  type JsonValue,
  type SelectedOrganizationScope,
  type IdentitySession,
  sameId,
  fieldIdSchema,
  canonicalJson,
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
  type ProtectedQueryGroupedMembersCommand,
  protectedQueryGroupedMembersResultSchema,
} from "./protected-query-contracts";
import {
  type ResultRow,
  one,
  filterInputRefusal,
  readInputs,
  normalizeConditionFieldIdentifiers,
} from "./protected-query-helpers";
import { groupedMemberPageReadSchema, type pageAnchorSchema } from "./protected-query-read-schemas";
import {
  parseQueryInputDeclarations,
  validateQueryInputValues,
  QueryInputRefusalError,
} from "./typed-input-validation";

const readGroupedMemberPage = async (
  transaction: RequestDatabaseTransaction,
  command: ProtectedQueryGroupedMembersCommand,
  releaseRevision: number,
  inputValues: Readonly<Record<string, JsonValue>>,
  selector: ProtectedQueryGroupedMembersCommand["selector"],
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
        ...(command.groupingFieldId === undefined
          ? {}
          : { groupingFieldId: command.groupingFieldId }),
        groupMember: selector,
      })}::text::jsonb,
      ${command.pageDirection ?? "forward"}::text,
      ${null}::uuid
    ) as result
  `;
  return groupedMemberPageReadSchema.parse(one(rows));
};

export const groupedMembersCommand = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  caller: IdentitySession,
  command: ProtectedQueryGroupedMembersCommand,
  continuationKey: QueryContinuationKey,
): Promise<z.infer<typeof protectedQueryGroupedMembersResultSchema>> => {
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

  const selector = {
    values: command.selector.values
      .map((value) => ({ ...value, fieldId: fieldIdSchema.parse(value.fieldId.toLowerCase()) }))
      .sort((left, right) =>
        left.fieldId < right.fieldId ? -1 : left.fieldId > right.fieldId ? 1 : 0,
      ),
  };
  const inputFingerprint = fingerprintQueryInputs({
    operation: "protected-group-members",
    actorIdentityId: caller.identityId,
    inputValues,
    selector,
    filter: normalizeConditionFieldIdentifiers(command.filter ?? null),
    filterableFieldIds: command.filterableFieldIds.map((fieldId) => fieldId.toLowerCase()).sort(),
    requestedFieldIds: command.requestedFieldIds.map((fieldId) => fieldId.toLowerCase()).sort(),
    requestedSystemFieldKeys: [...command.requestedSystemFieldKeys].sort(),
    pageSize: command.pageSize,
    groupingFieldId: command.groupingFieldId?.toLowerCase() ?? null,
    sort: command.sort.map((key) => ({ ...key, fieldId: key.fieldId.toLowerCase() })),
    search: command.search ?? null,
    sortableFieldIds: command.sortableFieldIds.map((id) => id.toLowerCase()).sort(),
    searchableFieldIds: command.searchableFieldIds.map((id) => id.toLowerCase()).sort(),
  });
  if (after !== undefined && after.inputFingerprint !== inputFingerprint)
    return { outcome: "refused", reasonCode: "cursor_stale" };

  const page = await readGroupedMemberPage(
    transaction,
    command,
    declared.moduleReleaseRevision,
    inputValues,
    selector,
    after,
  );
  if (page.outcome === "refused") return { outcome: "refused", reasonCode: page.reasonCode };
  if (
    page.moduleReleaseRevision !== declared.moduleReleaseRevision ||
    page.moduleReleaseVersion !== declared.moduleReleaseVersion
  )
    throw new Error("PROTECTED_QUERY_RESULT_INVALID");

  const selectorIds = selector.values.map((value) => value.fieldId);
  const pageIds = page.groupByFieldIds.map((fieldId) => fieldId.toLowerCase());
  if (
    pageIds.length !== selectorIds.length ||
    new Set(pageIds).size !== pageIds.length ||
    selectorIds.some((fieldId) => !pageIds.includes(fieldId))
  )
    throw new Error("PROTECTED_QUERY_RESULT_INVALID");
  const expectedGroupValues = Object.fromEntries(
    selector.values.map(({ fieldId, value }) => [fieldId, value]),
  );
  if (canonicalJson(page.groupValues) !== canonicalJson(expectedGroupValues))
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

  const result = protectedQueryGroupedMembersResultSchema.parse({
    outcome: "completed",
    moduleRootId: command.moduleRootId,
    moduleReleaseVersion: page.moduleReleaseVersion,
    queryId: command.queryId,
    groupByFieldIds: page.groupByFieldIds,
    groupValues: page.groupValues,
    rows: page.rows,
  });
  // SQL's next anchor follows the scan direction; opposite is the first returned row.
  // Every token binds the actor, exact group, order, narrowing and visible projection.
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
  return protectedQueryGroupedMembersResultSchema.parse({
    ...result,
    ...(next === undefined ? {} : { nextContinuationToken: next }),
    ...(previous === undefined ? {} : { previousContinuationToken: previous }),
  });
};
