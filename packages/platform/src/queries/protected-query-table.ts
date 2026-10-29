import "server-only";

import { z } from "zod";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import type { SelectedOrganizationScope } from "../access/identity-access";
import type { JsonValue } from "../catalogue/common";
import { sameId } from "../catalogue/runtime-primitives";
import { recordIdSchema } from "../catalogue/identifiers";
import {
  type QueryContinuation,
  type QueryContinuationKey,
  decodeQueryContinuationToken,
  QueryContinuationTokenError,
  fingerprintQueryInputs,
  encodeQueryContinuationToken,
} from "./continuation-token";
import type {
  ProtectedQueryCommand,
  ProtectedQueryRefusalReasonCode,
  ProtectedQueryResult,
  ProtectedQueryPage,
} from "./protected-query-contracts";
import { protectedQueryRefusalReasonCodes } from "./protected-query-contracts";
import {
  conditionFieldIds,
  type ResultRow,
  one,
  refuseWithCause,
  sqlArray,
  admitQueryInputs,
} from "./protected-query-helpers";
import { pageAnchorSchema, pageReadSchema } from "./protected-query-read-schemas";

/**
 * One table read makes at most this many database reads, each examining at most
 * `tableReadCandidatesPerCall` candidates (the `scan_limit` of module_query_scan_internal), so one request
 * examines at most `tableReadCandidatesPerRequest` candidates.
 */
const tableReadCallsPerRequest = 4;
const tableReadCandidatesPerCall = 500;
export const tableReadCandidatesPerRequest = tableReadCallsPerRequest * tableReadCandidatesPerCall;

/**
 * The user-facing sort, filter and search a request carries, plus the component-declared
 * sortable, filterable and searchable field sets. It is passed as one value so the engine can
 * validate every choice against the installed record type's own field flags and the
 * guaranteed-readable projection.
 */
const userQueryInputs = (command: ProtectedQueryCommand): Readonly<Record<string, unknown>> => ({
  sort: command.sort,
  filter: command.filter ?? null,
  search: command.search ?? null,
  sortableFieldIds: command.sortableFieldIds,
  filterableFieldIds: command.filterableFieldIds,
  searchableFieldIds: command.searchableFieldIds,
});

/**
 * Whether the caller's user sort and filter stay inside the component-declared allow-lists it
 * also supplied. The engine still intersects each accepted field with the installed record type's
 * own flags, so this only fails a choice the component itself did not declare. Returns the neutral
 * refusal for the offending input, or undefined when every choice is declared.
 */
const userInputRefusal = (
  command: ProtectedQueryCommand,
): ProtectedQueryRefusalReasonCode | undefined => {
  const sortable = new Set(command.sortableFieldIds.map((fieldId) => fieldId.toLowerCase()));
  if (command.sort.some((sort) => !sortable.has(sort.fieldId.toLowerCase()))) return "sort_invalid";
  if (command.filter !== undefined) {
    const filterable = new Set(command.filterableFieldIds.map((fieldId) => fieldId.toLowerCase()));
    const referenced = new Set<string>();
    conditionFieldIds(command.filter, referenced);
    if ([...referenced].some((fieldId) => !filterable.has(fieldId))) return "filter_invalid";
  }
  return undefined;
};

const readPage = async (
  transaction: RequestDatabaseTransaction,
  command: ProtectedQueryCommand,
  releaseRevision: number,
  inputValues: Readonly<Record<string, JsonValue>>,
  after: QueryContinuation | undefined,
) => {
  const rows =
    command.exactRecordIds === undefined
      ? await transaction.query<ResultRow>`
    select vortex_record.run_module_query_rows(
      ${command.moduleRootId}::uuid,
      ${command.queryId}::uuid,
      ${releaseRevision}::bigint,
      ${JSON.stringify(inputValues)}::text::jsonb,
      ${sqlArray(command.requestedFieldIds)}::text::uuid[],
      ${sqlArray(command.requestedSystemFieldKeys)}::text::text[],
      ${command.filter === undefined ? null : JSON.stringify(command.filter)}::text::jsonb,
      ${sqlArray(command.filterableFieldIds)}::text::uuid[],
      ${JSON.stringify(command.sort)}::text::jsonb,
      ${command.search ?? null}::text,
      ${sqlArray(command.sortableFieldIds)}::text::uuid[],
      ${sqlArray(command.searchableFieldIds)}::text::uuid[],
      ${command.pageSize}::integer,
      ${after === undefined ? null : JSON.stringify({ sort: after.sort, sortKey: after.sortKey, phase: after.phase, recordId: after.recordId })}::text::jsonb,
      ${command.pageDirection ?? "forward"}::text
    ) as result
  `
      : await transaction.query<ResultRow>`
    select vortex_record.run_module_query_exact_rows(
      ${command.moduleRootId}::uuid,
      ${command.queryId}::uuid,
      ${releaseRevision}::bigint,
      ${JSON.stringify(inputValues)}::text::jsonb,
      ${sqlArray(command.requestedFieldIds)}::text::uuid[],
      ${sqlArray(command.requestedSystemFieldKeys)}::text::text[],
      ${command.filter === undefined ? null : JSON.stringify(command.filter)}::text::jsonb,
      ${sqlArray(command.filterableFieldIds)}::text::uuid[],
      ${JSON.stringify(command.sort)}::text::jsonb,
      ${command.search ?? null}::text,
      ${sqlArray(command.sortableFieldIds)}::text::uuid[],
      ${sqlArray(command.searchableFieldIds)}::text::uuid[],
      ${sqlArray(command.exactRecordIds)}::text::uuid[]
    ) as result
  `;
  return pageReadSchema.parse(one(rows));
};

const membershipReadSchema = z.discriminatedUnion("outcome", [
  z
    .object({ outcome: z.literal("completed"), recordIds: z.array(recordIdSchema).max(200) })
    .strict(),
  z
    .object({ outcome: z.literal("refused"), reasonCode: z.enum(protectedQueryRefusalReasonCodes) })
    .strict(),
]);

/** Re-decide only the supplied identities against the installed query and current authority. */
export const readQueryMembership = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  command: ProtectedQueryCommand,
) => {
  const ids = command.exactRecordIds;
  if (
    scope.applicationRootId === undefined ||
    ids === undefined ||
    command.continuationToken !== undefined ||
    ids.length !== command.pageSize
  )
    return refuseWithCause("request_invalid", "membership", "exact_ids_required");
  const userRefusal = userInputRefusal(command);
  if (userRefusal !== undefined) return refuseWithCause(userRefusal, "user_input", userRefusal);
  const admitted = await admitQueryInputs(transaction, command);
  if (admitted.outcome === "refused") return admitted;
  const rows = await transaction.query<ResultRow>`
    select vortex_record.run_module_query_members(
      ${command.moduleRootId}::uuid,
      ${command.queryId}::uuid,
      ${admitted.declared.moduleReleaseRevision}::bigint,
      ${JSON.stringify(admitted.inputValues)}::text::jsonb,
      ${sqlArray(command.requestedFieldIds)}::text::uuid[],
      ${sqlArray(command.requestedSystemFieldKeys)}::text::text[],
      ${command.filter === undefined ? null : JSON.stringify(command.filter)}::text::jsonb,
      ${sqlArray(command.filterableFieldIds)}::text::uuid[],
      ${JSON.stringify(command.sort)}::text::jsonb,
      ${command.search ?? null}::text,
      ${sqlArray(command.sortableFieldIds)}::text::uuid[],
      ${sqlArray(command.searchableFieldIds)}::text::uuid[],
      ${sqlArray(ids)}::text::uuid[]
    ) as result
  `;
  const result = membershipReadSchema.parse(one(rows));
  return result.outcome === "refused"
    ? refuseWithCause(result.reasonCode, "membership", result.reasonCode)
    : result;
};

export const runCommand = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  command: ProtectedQueryCommand,
  continuationKey: QueryContinuationKey,
): Promise<ProtectedQueryResult> => {
  const applicationRootId = scope.applicationRootId;
  if (applicationRootId === undefined)
    return refuseWithCause("request_invalid", "scope", "application_not_selected");
  if (
    command.exactRecordIds !== undefined &&
    (command.continuationToken !== undefined || command.exactRecordIds.length !== command.pageSize)
  ) {
    return refuseWithCause(
      "request_invalid",
      "exact_ids",
      command.continuationToken !== undefined ? "exact_ids_cursor" : "exact_ids_page_size",
    );
  }

  // A user sort or filter outside the component-declared sets is refused before any read.
  const userRefusal = userInputRefusal(command);
  if (userRefusal !== undefined) return refuseWithCause(userRefusal, "user_input", userRefusal);

  // A continuation is accepted only for the same actor, installation, query,
  // release and inputs it was issued for.
  let after: QueryContinuation | undefined;
  const direction = command.pageDirection ?? "forward";
  if (command.continuationToken !== undefined) {
    try {
      after = decodeQueryContinuationToken(command.continuationToken, continuationKey);
    } catch (error) {
      if (error instanceof QueryContinuationTokenError)
        return refuseWithCause("cursor_invalid", "continuation", "token_not_authentic");
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
      return refuseWithCause("cursor_stale", "continuation", "other_scope_or_query");
  }

  const admitted = await admitQueryInputs(transaction, command, after?.moduleReleaseRevision);
  if (admitted.outcome === "refused") return admitted;
  const { declared, inputValues } = admitted;
  // The fingerprint binds the query inputs, the user's sort, filter and search and the page size,
  // so a continuation issued under one order or narrowing can never be replayed under another. The
  // requested columns are not bound: a keyset position is the sort-key values and record identity
  // of a row (the scan never reads the projection to place it), and every read
  // re-authorises its own projection, so showing or hiding a column rereads the same page.
  const inputFingerprint = fingerprintQueryInputs({
    inputValues,
    user: userQueryInputs(command),
    requestedSystemFieldKeys: [...command.requestedSystemFieldKeys].sort(),
    pageSize: command.pageSize,
  });
  if (after !== undefined && after.inputFingerprint !== inputFingerprint)
    return refuseWithCause("cursor_stale", "continuation", "inputs_or_order_changed");

  const load = async (): Promise<ProtectedQueryResult> => {
    let cursor = after;
    let rows: ProtectedQueryPage["rows"] = [];
    let nextAnchor: z.infer<typeof pageAnchorSchema> | null = null;
    let oppositeAnchor: z.infer<typeof pageAnchorSchema> | null = null;
    let releaseVersion: string | undefined;
    let fieldBounds: ProtectedQueryPage["fieldBounds"] | undefined;
    for (
      let call = 0;
      call < (command.exactRecordIds === undefined ? tableReadCallsPerRequest : 1);
      call += 1
    ) {
      const page = await readPage(
        transaction,
        { ...command, pageSize: command.pageSize - rows.length },
        declared.moduleReleaseRevision,
        inputValues,
        cursor,
      );
      if (page.outcome === "refused")
        return refuseWithCause(page.reasonCode, "page_read", page.reasonCode);
      releaseVersion = page.moduleReleaseVersion;
      // Every call of one request reads under the same authority; the first decides the bound.
      fieldBounds ??= page.fieldBounds;
      if (oppositeAnchor === null) oppositeAnchor = page.opposite;
      rows = direction === "forward" ? [...rows, ...page.rows] : [...page.rows, ...rows];
      nextAnchor = page.next;
      if (rows.length === command.pageSize || nextAnchor === null) break;
      cursor = {
        version: 1,
        organizationId: scope.organizationId,
        applicationRootId,
        organizationAccountId: scope.organizationAccountId,
        moduleRootId: command.moduleRootId,
        queryId: command.queryId,
        moduleReleaseRevision: page.moduleReleaseRevision,
        inputFingerprint,
        direction,
        ...nextAnchor,
      };
    }
    if (releaseVersion === undefined || fieldBounds === undefined)
      throw new Error("PROTECTED_QUERY_RESULT_INVALID");
    // The request's scan budget ran out before the page filled: the rows found so far are the
    // page and the continuation (sealed at the last examined key) resumes the search.
    const scanLimited = rows.length < command.pageSize && nextAnchor !== null;
    // A page with no rows has no first row to turn back from: it turns back from the last key it
    // examined, or (at the end of the data) from the key it started after, so a person who paged
    // into an empty stretch of a sparse search can still go back.
    if (rows.length === 0 && after !== undefined)
      oppositeAnchor =
        nextAnchor ??
        pageAnchorSchema.parse({
          sortKey: after.sortKey,
          sort: after.sort,
          phase: after.phase,
          recordId: after.recordId,
        });
    // Only the declared system values may appear; a row carrying any other is a
    // contract breach, not something to pass on.
    const declaredSystemKeys = new Set<string>(command.requestedSystemFieldKeys);
    for (const row of rows) {
      const disclosed = Object.keys(row.systemValues ?? {});
      if (
        disclosed.some((key) => !declaredSystemKeys.has(key)) ||
        declaredSystemKeys.size > 0 !== (row.systemValues !== undefined) ||
        declaredSystemKeys.size !== disclosed.length
      )
        throw new Error("PROTECTED_QUERY_RESULT_INVALID");
    }

    const seal = (
      anchor: z.infer<typeof pageAnchorSchema>,
      tokenDirection: "forward" | "backward",
    ) =>
      encodeQueryContinuationToken(
        {
          version: 1,
          organizationId: scope.organizationId,
          applicationRootId,
          organizationAccountId: scope.organizationAccountId,
          moduleRootId: command.moduleRootId,
          queryId: command.queryId,
          moduleReleaseRevision: declared.moduleReleaseRevision,
          inputFingerprint,
          direction: tokenDirection,
          ...anchor,
        },
        continuationKey,
      );
    const next =
      direction === "forward"
        ? nextAnchor === null
          ? undefined
          : seal(nextAnchor, "forward")
        : after === undefined || oppositeAnchor === null
          ? undefined
          : seal(oppositeAnchor, "forward");
    const previous =
      direction === "backward"
        ? nextAnchor === null
          ? undefined
          : seal(nextAnchor, "backward")
        : after === undefined || oppositeAnchor === null
          ? undefined
          : seal(oppositeAnchor, "backward");
    return {
      outcome: "completed",
      moduleRootId: command.moduleRootId,
      moduleReleaseVersion: releaseVersion,
      queryId: command.queryId,
      rows,
      fieldBounds,
      scanLimited,
      ...(next === undefined ? {} : { nextContinuationToken: next }),
      ...(previous === undefined ? {} : { previousContinuationToken: previous }),
    };
  };

  return load();
};
