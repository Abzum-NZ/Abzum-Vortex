import "server-only";

import type { z } from "zod";
import type { RequestDatabaseTransaction } from "../db/index";
import { type JsonValue, type SelectedOrganizationScope, sameId } from "../schema";
import {
  type QueryContinuation,
  type QueryContinuationKey,
  decodeQueryContinuationToken,
  QueryContinuationTokenError,
  fingerprintQueryInputs,
  encodeQueryContinuationToken,
} from "./continuation-token";
import { planCache, recheckHit } from "./protected-query-cache";
import {
  type ProtectedQueryCommand,
  type ProtectedQueryRefusalReasonCode,
  type ProtectedQueryResult,
  type ProtectedQueryPage,
  protectedQueryResultSchema,
} from "./protected-query-contracts";
import {
  conditionFieldIds,
  type ResultRow,
  one,
  refusal,
  readInputs,
} from "./protected-query-helpers";
import { pageReadSchema, type pageAnchorSchema } from "./protected-query-read-schemas";
import type { QueryCache } from "./protected-query-types";
import { readThroughQueryCache } from "./shared-cache-adapter";
import {
  parseQueryInputDeclarations,
  validateQueryInputValues,
  QueryInputRefusalError,
} from "./typed-input-validation";

/**
 * One table read makes at most this many database reads, each examining at most
 * `tableReadCandidatesPerCall` candidates (the `scan_limit` of run_module_query), so one request
 * examines at most `tableReadCandidatesPerRequest` candidates.
 */
export const tableReadCallsPerRequest = 4;
export const tableReadCandidatesPerCall = 500;
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
      ${JSON.stringify(userQueryInputs(command))}::text::jsonb,
      ${command.pageDirection ?? "forward"}::text,
      ${command.exactRecordId ?? null}::uuid
    ) as result
  `;
  return pageReadSchema.parse(one(rows));
};

export const runCommand = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  command: ProtectedQueryCommand,
  continuationKey: QueryContinuationKey,
  cache: QueryCache | undefined,
): Promise<ProtectedQueryResult> => {
  const applicationRootId = scope.applicationRootId;
  if (applicationRootId === undefined) return refusal("request_invalid");
  if (command.exactRecordId !== undefined && command.continuationToken !== undefined)
    return refusal("request_invalid");

  // A user sort or filter outside the component-declared sets is refused before any read.
  const userRefusal = userInputRefusal(command);
  if (userRefusal !== undefined) return refusal(userRefusal);

  // A continuation is accepted only for the same actor, installation, query,
  // release and inputs it was issued for.
  let after: QueryContinuation | undefined;
  const direction = command.pageDirection ?? "forward";
  if (command.continuationToken !== undefined) {
    try {
      after = decodeQueryContinuationToken(command.continuationToken, continuationKey);
    } catch (error) {
      if (error instanceof QueryContinuationTokenError) return refusal("cursor_invalid");
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
      return refusal("cursor_stale");
  }

  const declared = await readInputs(transaction, command);
  if (declared.outcome === "refused") return refusal(declared.reasonCode);
  if (after !== undefined && after.moduleReleaseRevision !== declared.moduleReleaseRevision)
    return refusal("cursor_stale");
  const declarations = parseQueryInputDeclarations(declared.inputs);
  if (declarations === undefined) return refusal("descriptor_invalid");

  let inputValues: Readonly<Record<string, JsonValue>>;
  try {
    inputValues = validateQueryInputValues(declarations, command.inputValues);
  } catch (error) {
    if (error instanceof QueryInputRefusalError) return refusal("input_invalid");
    throw error;
  }
  // The fingerprint binds the query inputs, the user's sort, filter and search and the page size,
  // so a continuation issued under one order or narrowing can never be replayed under another. The
  // requested columns are not bound: a keyset position is the sort-key values and record identity
  // of a row (run_module_query never reads the projection to place it), and every read
  // re-authorises its own projection, so showing or hiding a column rereads the same page.
  const inputFingerprint = fingerprintQueryInputs({
    inputValues,
    user: userQueryInputs(command),
    requestedSystemFieldKeys: [...command.requestedSystemFieldKeys].sort(),
    pageSize: command.pageSize,
  });
  if (after !== undefined && after.inputFingerprint !== inputFingerprint)
    return refusal("cursor_stale");

  const load = async (): Promise<ProtectedQueryResult> => {
    let cursor = after;
    let rows: ProtectedQueryPage["rows"] = [];
    let nextAnchor: z.infer<typeof pageAnchorSchema> | null = null;
    let oppositeAnchor: z.infer<typeof pageAnchorSchema> | null = null;
    let releaseVersion: string | undefined;
    let fieldBounds: ProtectedQueryPage["fieldBounds"] | undefined;
    for (
      let call = 0;
      call < (command.exactRecordId === undefined ? tableReadCallsPerRequest : 1);
      call += 1
    ) {
      const page = await readPage(
        transaction,
        { ...command, pageSize: command.pageSize - rows.length },
        declared.moduleReleaseRevision,
        inputValues,
        cursor,
      );
      if (page.outcome === "refused") return refusal(page.reasonCode);
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

  if (cache === undefined || command.exactRecordId !== undefined) return load();
  const plan = await planCache(transaction, scope, command, applicationRootId, declared, cache);
  if (plan === undefined) return load();
  const { value } = await readThroughQueryCache<ProtectedQueryResult>({
    store: cache.store,
    decision: plan.decision,
    now: cache.now,
    load,
    parse: (stored) => {
      const parsed = protectedQueryResultSchema.safeParse(stored);
      return parsed.success ? parsed.data : undefined;
    },
    // A hit is returned only after every stored row passes the same per-row
    // Access projection the ordinary query applies, at current authority.
    recheck: (stored) => recheckHit(transaction, stored, command, declared, plan),
    shouldStore: (result) => result.outcome === "completed",
  });
  return value;
};
