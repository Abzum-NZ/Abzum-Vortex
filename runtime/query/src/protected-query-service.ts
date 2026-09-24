import "server-only";

import { z } from "zod";
import {
  activeApplicationInstallationEvidenceSchema,
  fieldIdSchema,
  jsonValueSchema,
  recordIdSchema,
  recordTypeIdSchema,
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
  type ProtectedQueryPage,
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
 * What the query path cannot read for itself and the caller must prove for one
 * request. The request role can read neither Record data versions, nor the
 * installed query's record type and filter/sort fields, nor field
 * classification, nor release fingerprints, so these come from the caller.
 * Anything the caller cannot prove is left out or reported unsafe, and the
 * query bypasses. The service still checks the Module release and Application
 * release revision against this request's own reads, and rechecks every hit
 * row by row against current Access.
 */
export type ProtectedQueryCacheContext = Readonly<{
  /** Fingerprint of the installed Module release the query runs under. */
  moduleFingerprint: QueryCacheInput["definition"]["module"]["fingerprint"];
  /** The active Application release; its revision must be the installation's current one. */
  application: QueryCacheInput["definition"]["application"];
  /** The Record type the query returns rows of; one of `recordDependencies`. */
  recordTypeId: QueryCacheInput["recordDependencies"][number]["recordTypeId"];
  /** Every field the query filters or sorts by; each must stay readable on every returned row. */
  referencedFieldIds: readonly string[];
  /** Every Record type the query reads, each at its current data version. */
  recordDependencies: QueryCacheInput["recordDependencies"];
  /**
   * True only when a published declaration explicitly allows result caching.
   * None exists yet, and a query whose fields depend on a deadline calculation
   * cannot prove freshness from data versions, so either case reports false.
   */
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
     * the query is admitted and behind a savepoint. Returning nothing, throwing
     * or failing a database statement bypasses the cache.
     */
    resolveQueryCacheContext?: (
      transaction: RequestDatabaseTransaction,
      scope: SelectedOrganizationScope,
      command: ProtectedQueryCommand,
      release: Readonly<{ moduleReleaseRevision: number; moduleReleaseVersion: string }>,
    ) => Promise<ProtectedQueryCacheContext | undefined>;
  }>;

/** A configured cache for one request: both the store and the context resolver are present. */
type QueryCache = Readonly<{
  store: SharedCacheStore;
  resolveContext: NonNullable<ProtectedQueryServiceDependencies["resolveQueryCacheContext"]>;
  now: () => Date;
  sessionExpiresAt: string;
}>;

type CachePlan = Readonly<{
  decision: Extract<QueryCacheDecision, { outcome: "cache" }>;
  recordTypeId: string;
  /** Lower-cased filtered and sorted field identifiers. */
  referencedFieldIds: readonly string[];
}>;

type ResolvedInputs = Extract<z.infer<typeof inputsReadSchema>, { outcome: "resolved" }>;

type ResultRow = DatabaseRow & { readonly result: unknown };
type InstallationRow = DatabaseRow & { readonly active_installation: unknown };

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
  cache: QueryCache | undefined,
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

  if (cache === undefined) return load();
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

/**
 * Runs cache work behind a savepoint, so a failed statement never aborts the
 * request's transaction: any failure yields undefined and the ordinary
 * authorised query still runs.
 */
const isolated = async <Value>(
  transaction: RequestDatabaseTransaction,
  work: () => Promise<Value | undefined>,
): Promise<Value | undefined> => {
  await transaction.query`savepoint protected_query_cache`;
  let value: Value | undefined;
  try {
    value = await work();
  } catch {
    await transaction.query`rollback to savepoint protected_query_cache`;
    value = undefined;
  }
  await transaction.query`release savepoint protected_query_cache`;
  return value;
};

const referencedFieldIdsSchema = z.array(fieldIdSchema).max(200);

/**
 * The cache key and recheck facts for one admitted request, or undefined when
 * any input is missing, unproven or inconsistent with this request's own reads.
 */
const planCache = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  command: ProtectedQueryCommand,
  applicationRootId: string,
  declared: ResolvedInputs,
  cache: QueryCache,
): Promise<CachePlan | undefined> => {
  const context = await isolated(transaction, async () => {
    const resolved = await cache.resolveContext(transaction, scope, command, {
      moduleReleaseRevision: declared.moduleReleaseRevision,
      moduleReleaseVersion: declared.moduleReleaseVersion,
    });
    if (resolved === undefined) return undefined;
    // The Application pin must be the release this installation runs now, so
    // a page can never cross an Application upgrade.
    const rows = await transaction.query<InstallationRow>`
      select vortex_module.read_current_active_installation() as active_installation
    `;
    const installation = activeApplicationInstallationEvidenceSchema.safeParse(
      rows.length === 1 ? rows[0]?.active_installation : undefined,
    );
    if (
      !installation.success ||
      !sameId(installation.data.organizationId, scope.organizationId) ||
      !sameId(installation.data.applicationRootId, applicationRootId) ||
      installation.data.applicationReleaseRevision !== resolved.application.releaseRevision
    )
      return undefined;
    return resolved;
  });
  if (context === undefined) return undefined;

  try {
    const recordTypeId = recordTypeIdSchema.safeParse(context.recordTypeId);
    const referencedFieldIds = referencedFieldIdsSchema.safeParse(context.referencedFieldIds);
    if (
      !recordTypeId.success ||
      !referencedFieldIds.success ||
      !context.recordDependencies.some((dependency) => sameId(dependency.recordTypeId, recordTypeId.data))
    )
      return undefined;
    const decision = decideQueryCache({
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
    if (decision.outcome !== "cache") return undefined;
    return {
      decision,
      recordTypeId: recordTypeId.data,
      referencedFieldIds: referencedFieldIds.data.map((fieldId) => fieldId.toLowerCase()),
    };
  } catch {
    // Anything unresolved bypasses to the ordinary authorised query.
    return undefined;
  }
};

/** A stored page is reusable only as a completed page for this admitted release, query and field set. */
const sameAdmittedResult = (
  stored: ProtectedQueryResult,
  command: ProtectedQueryCommand,
  declared: ResolvedInputs,
): stored is ProtectedQueryPage => {
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

const sameJson = (left: unknown, right: unknown): boolean => {
  if (Array.isArray(left))
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJson(item, right[index]))
    );
  if (typeof left === "object" && left !== null) {
    if (typeof right !== "object" || right === null || Array.isArray(right)) return false;
    const leftEntries = Object.entries(left);
    return (
      leftEntries.length === Object.keys(right).length &&
      leftEntries.every(
        ([key, item]) =>
          Object.hasOwn(right, key) && sameJson(item, (right as Record<string, unknown>)[key]),
      )
    );
  }
  return left === right;
};

const readableRecordSchema = z.object({
  outcome: z.literal("allowed"),
  values: z.record(z.string(), jsonValueSchema),
});

/**
 * The current-Access recheck for a hit. Every stored row goes back through
 * vortex_record.read_record, the same per-row projection the ordinary query
 * applies: the row must still be readable, every filtered or sorted field must
 * still be readable on it, and its values must be exactly the requested fields
 * readable now, with their current values. Anything else discards the hit.
 */
const recheckHit = async (
  transaction: RequestDatabaseTransaction,
  stored: ProtectedQueryResult,
  command: ProtectedQueryCommand,
  declared: ResolvedInputs,
  plan: CachePlan,
): Promise<boolean> => {
  if (!sameAdmittedResult(stored, command, declared)) return false;
  if (stored.rows.length === 0) return true;
  const checked = await isolated(
    transaction,
    () => transaction.query<ResultRow>`
      select vortex_record.read_record(${plan.recordTypeId}::uuid, item.record_id::uuid) as result
      from pg_catalog.jsonb_array_elements_text(
        ${JSON.stringify(stored.rows.map((row) => row.recordId))}::text::jsonb
      ) with ordinality as item(record_id, position)
      order by item.position
    `,
  );
  if (checked === undefined || checked.length !== stored.rows.length) return false;
  const requestedFieldIds = command.requestedFieldIds.map((fieldId) => fieldId.toLowerCase());
  return stored.rows.every((row, index) => {
    const current = readableRecordSchema.safeParse(checked[index]?.result);
    if (!current.success) return false;
    const readable = new Map(
      Object.entries(current.data.values).map(([fieldId, value]) => [fieldId.toLowerCase(), value]),
    );
    const disclosed = new Map(
      Object.entries(row.values).map(([fieldId, value]) => [fieldId.toLowerCase(), value]),
    );
    return (
      plan.referencedFieldIds.every((fieldId) => readable.has(fieldId)) &&
      requestedFieldIds.every((fieldId) =>
        readable.has(fieldId)
          ? disclosed.has(fieldId) && sameJson(disclosed.get(fieldId), readable.get(fieldId))
          : !disclosed.has(fieldId),
      )
    );
  });
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
      const cache: QueryCache | undefined =
        sharedCacheStore === undefined || resolveQueryCacheContext === undefined
          ? undefined
          : {
              store: sharedCacheStore,
              resolveContext: resolveQueryCacheContext,
              now,
              // Verified by the request service before this operation runs.
              sessionExpiresAt: session.accessTokenExpiresAt,
            };
      return requests.run(session, selection, (transaction, scope) =>
        runCommand(transaction, scope, command.data, continuationKey, cache),
      );
    },
  });
};
