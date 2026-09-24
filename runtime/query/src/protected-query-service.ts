import "server-only";

import { z } from "zod";
import {
  fieldIdSchema,
  jsonValueSchema,
  recordIdSchema,
  stableDefinitionReleaseVersionSchema,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  decodeQueryContinuationToken,
  encodeQueryContinuationToken,
  fingerprintQueryInputs,
  QueryContinuationTokenError,
  type QueryContinuation,
  type QueryContinuationKey,
} from "./continuation-token";
import { decideQueryCache, type QueryCacheDecision, type QueryCacheInput } from "./cache-policy";
import {
  protectedQueryCommandSchema,
  protectedQueryRefusalReasonCodes,
  protectedQueryResultSchema,
  type ProtectedQueryCommand,
  type ProtectedQueryRefusalReasonCode,
  type ProtectedQueryResult,
} from "./protected-query-contracts";
import { recordSystemValuesSchema } from "./record-system-values";
import { readThroughQueryCache, type SharedCacheStore } from "./shared-cache-adapter";
import {
  parseQueryInputDeclarations,
  QueryInputRefusalError,
  validateQueryInputValues,
} from "./typed-input-validation";

/**
 * What the query path itself cannot establish and the caller must prove for one
 * request: the exact definition pin, every Record type read at its current data
 * version, the eligibility facts and the current-authority window. Anything the
 * caller cannot prove is left out or reported unsafe, and the query bypasses.
 */
export type ProtectedQueryCacheContext = Readonly<{
  /** Fingerprint of the installed Module release the query runs under. */
  moduleFingerprint: QueryCacheInput["definition"]["module"]["fingerprint"];
  application: QueryCacheInput["definition"]["application"];
  recordDependencies: QueryCacheInput["recordDependencies"];
  /** True only when a declaration explicitly allows result caching. */
  cachingAllowed: boolean;
  /** True when any requested or filtered field is personal data or its classification is unknown. */
  sensitiveFieldsPresent: boolean;
  sharedSourceOwnership: QueryCacheInput["eligibility"]["sharedSourceOwnership"];
  policyTtlSeconds: QueryCacheInput["lifetime"]["policyTtlSeconds"];
  /** When the current grant or account state stops being valid; absent when unproven. */
  authorityValidUntil?: string;
}>;

export type ProtectedQueryServiceDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    /** Server-held AES-256-GCM key that makes continuation tokens opaque and bound. */
    continuationKey: QueryContinuationKey;
    /**
     * The shared cache. With no store, or no context resolver, the service runs
     * every query exactly as it does without a cache.
     */
    sharedCacheStore?: SharedCacheStore;
    /**
     * Resolves the cache context inside the request's own transaction, after
     * the query is admitted. Returning nothing or throwing bypasses the cache.
     */
    resolveQueryCacheContext?: (
      transaction: RequestDatabaseTransaction,
      scope: SelectedOrganizationScope,
      command: ProtectedQueryCommand,
      release: Readonly<{ moduleReleaseRevision: number; moduleReleaseVersion: string }>,
    ) => Promise<ProtectedQueryCacheContext | undefined>;
  }>;

type QueryCacheHooks = Pick<
  ProtectedQueryServiceDependencies,
  "sharedCacheStore" | "resolveQueryCacheContext"
> &
  Readonly<{ now: () => Date; sessionExpiresAt: string }>;

type ResolvedInputs = Extract<z.infer<typeof inputsReadSchema>, { outcome: "resolved" }>;

type ResultRow = DatabaseRow & { readonly result: unknown };

const refusal = (reasonCode: ProtectedQueryRefusalReasonCode): ProtectedQueryResult => ({
  outcome: "refused",
  reasonCode,
});

const one = (rows: readonly ResultRow[]): unknown => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("PROTECTED_QUERY_RESULT_INVALID");
  return rows[0].result;
};

const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const refusedSchema = z
  .object({ outcome: z.literal("refused"), reasonCode: z.enum(protectedQueryRefusalReasonCodes) })
  .strict();
const inputsReadSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("resolved"),
      moduleReleaseRevision: revisionSchema,
      moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
      inputs: z.unknown(),
    })
    .strict(),
  refusedSchema,
]);
const pageReadSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("completed"),
      moduleReleaseRevision: revisionSchema,
      moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
      rows: z
        .array(
          z
            .object({
              recordId: recordIdSchema,
              values: z.record(fieldIdSchema, jsonValueSchema),
              systemValues: recordSystemValuesSchema.optional(),
            })
            .strict(),
        )
        .max(200),
      next: z
        .object({
          sortKey: z.array(z.string().nullable()).min(1).max(20),
          recordId: recordIdSchema,
        })
        .strict()
        .nullable(),
    })
    .strict(),
  refusedSchema,
]);

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const readInputs = async (transaction: RequestDatabaseTransaction, command: ProtectedQueryCommand) => {
  const rows = await transaction.query<ResultRow>`
    select vortex_record.read_module_query_inputs(
      ${command.moduleRootId}::uuid,
      ${command.queryId}::uuid
    ) as result
  `;
  return inputsReadSchema.parse(one(rows));
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
      ${after === undefined ? null : JSON.stringify({ sortKey: after.sortKey, recordId: after.recordId })}::text::jsonb,
      ${JSON.stringify(command.requestedSystemFieldKeys)}::text::jsonb
    ) as result
  `;
  return pageReadSchema.parse(one(rows));
};

const runCommand = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  command: ProtectedQueryCommand,
  continuationKey: QueryContinuationKey,
  cache: QueryCacheHooks,
): Promise<ProtectedQueryResult> => {
  const applicationRootId = scope.applicationRootId;
  if (applicationRootId === undefined) return refusal("request_invalid");

  // A continuation is accepted only for the same actor, installation, query,
  // release and inputs it was issued for.
  let after: QueryContinuation | undefined;
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
      !sameId(after.queryId, command.queryId)
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
  const inputFingerprint = fingerprintQueryInputs(inputValues);
  if (after !== undefined && after.inputFingerprint !== inputFingerprint) return refusal("cursor_stale");

  const load = async (): Promise<ProtectedQueryResult> => {
  const page = await readPage(
    transaction,
    command,
    declared.moduleReleaseRevision,
    inputValues,
    after,
  );
  if (page.outcome === "refused") return refusal(page.reasonCode);
  // Only the declared system values may appear; a row carrying any other is a
  // contract breach, not something to pass on.
  const declaredSystemKeys = new Set<string>(command.requestedSystemFieldKeys);
  for (const row of page.rows) {
    const disclosed = Object.keys(row.systemValues ?? {});
    if (
      disclosed.some((key) => !declaredSystemKeys.has(key)) ||
      (declaredSystemKeys.size > 0) !== (row.systemValues !== undefined) ||
      declaredSystemKeys.size !== disclosed.length
    )
      throw new Error("PROTECTED_QUERY_RESULT_INVALID");
  }

  return {
    outcome: "completed",
    moduleRootId: command.moduleRootId,
    moduleReleaseVersion: page.moduleReleaseVersion,
    queryId: command.queryId,
    rows: page.rows,
    ...(page.next === null
      ? {}
      : {
          nextContinuationToken: encodeQueryContinuationToken(
            {
              version: 1,
              organizationId: scope.organizationId,
              applicationRootId,
              organizationAccountId: scope.organizationAccountId,
              moduleRootId: command.moduleRootId,
              queryId: command.queryId,
              moduleReleaseRevision: page.moduleReleaseRevision,
              inputFingerprint,
              sortKey: page.next.sortKey,
              recordId: page.next.recordId,
            },
            continuationKey,
          ),
        }),
  };
  };

  const decision = await decideCache(transaction, scope, command, applicationRootId, declared, cache);
  if (cache.sharedCacheStore === undefined) return load();
  const { value } = await readThroughQueryCache<ProtectedQueryResult>({
    store: cache.sharedCacheStore,
    decision,
    now: cache.now,
    load,
    parse: (stored) => {
      const parsed = protectedQueryResultSchema.safeParse(stored);
      return parsed.success ? parsed.data : undefined;
    },
    // The query was admitted above by the same current-Access read the ordinary
    // path uses, in this transaction; a hit is returned only if it is a
    // completed page for exactly this admitted release and request shape.
    recheck: async (stored) => sameAdmittedResult(stored, command, declared),
    shouldStore: (result) => result.outcome === "completed",
  });
  return value;
};

const bypassDecision: QueryCacheDecision = Object.freeze({ outcome: "bypass", reason: "policy_invalid" });

const decideCache = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  command: ProtectedQueryCommand,
  applicationRootId: string,
  declared: ResolvedInputs,
  cache: QueryCacheHooks,
): Promise<QueryCacheDecision> => {
  if (cache.sharedCacheStore === undefined || cache.resolveQueryCacheContext === undefined)
    return bypassDecision;
  try {
    const context = await cache.resolveQueryCacheContext(transaction, scope, command, {
      moduleReleaseRevision: declared.moduleReleaseRevision,
      moduleReleaseVersion: declared.moduleReleaseVersion,
    });
    if (context === undefined) return bypassDecision;
    return decideQueryCache({
      request: command,
      scope: {
        organizationId: scope.organizationId,
        organizationAccountId: scope.organizationAccountId,
        applicationRootId,
        accessVersion: scope.accessVersion,
      },
      definition: {
        moduleRootId: command.moduleRootId,
        module: {
          releaseRevision: declared.moduleReleaseRevision,
          releaseVersion: declared.moduleReleaseVersion,
          fingerprint: context.moduleFingerprint,
        },
        application: context.application,
      },
      recordDependencies: context.recordDependencies,
      eligibility: {
        cachingAllowed: context.cachingAllowed,
        sensitiveFieldsPresent: context.sensitiveFieldsPresent,
        sharedSourceOwnership: context.sharedSourceOwnership,
      },
      lifetime: {
        now: cache.now().toISOString(),
        policyTtlSeconds: context.policyTtlSeconds,
        ...(context.authorityValidUntil === undefined
          ? {}
          : { authorityValidUntil: context.authorityValidUntil }),
        sessionExpiresAt: cache.sessionExpiresAt,
      },
    } satisfies QueryCacheInput);
  } catch {
    // Anything unresolved bypasses to the ordinary authorised query.
    return bypassDecision;
  }
};

/** A stored page is reusable only as a completed page for this admitted release, query and field set. */
const sameAdmittedResult = (
  stored: ProtectedQueryResult,
  command: ProtectedQueryCommand,
  declared: ResolvedInputs,
): boolean => {
  if (
    stored.outcome !== "completed" ||
    stored.moduleRootId !== command.moduleRootId ||
    stored.queryId !== command.queryId ||
    stored.moduleReleaseVersion !== declared.moduleReleaseVersion ||
    stored.rows.length > command.pageSize
  )
    return false;
  const requestedFields = new Set(command.requestedFieldIds.map((fieldId) => fieldId.toLowerCase()));
  const requestedSystem = new Set<string>(command.requestedSystemFieldKeys);
  return stored.rows.every(
    (row) =>
      Object.keys(row.values).every((fieldId) => requestedFields.has(fieldId.toLowerCase())) &&
      Object.keys(row.systemValues ?? {}).every((key) => requestedSystem.has(key)) &&
      (requestedSystem.size > 0) === (row.systemValues !== undefined),
  );
};

/**
 * Protected Query execution for one published Module query. The verified
 * request supplies the organisation, Application and actor; the database
 * resolves the query from the exact installed release, reads only rows the
 * record projection admits, and returns one bounded keyset page with an opaque
 * continuation, or one neutral refusal before any row is exposed.
 */
export const createProtectedQueryService = (dependencies: ProtectedQueryServiceDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const { continuationKey, sharedCacheStore, resolveQueryCacheContext } = dependencies;
  const now = dependencies.clock ?? (() => new Date());

  return Object.freeze({
    async run(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<ProtectedQueryResult>> {
      const command = protectedQueryCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "available", value: refusal("request_invalid") };
      if (selection.applicationRootId === undefined) return { kind: "unavailable" };
      return requests.run(session, selection, (transaction, scope) =>
        runCommand(transaction, scope, command.data, continuationKey, {
          sharedCacheStore,
          resolveQueryCacheContext,
          now,
          sessionExpiresAt: session.accessTokenExpiresAt,
        }),
      );
    },
  });
};
