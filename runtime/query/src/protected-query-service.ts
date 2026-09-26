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
import {
  decideQueryCache,
  queryCacheMaxEvaluatedFields,
  type QueryCacheDecision,
  type QueryCacheInput,
  type QueryCachePublishedField,
} from "./cache-policy";
import {
  protectedQueryCommandSchema,
  protectedQueryRefusalReasonCodes,
  protectedQueryResultSchema,
  protectedQueryRowCapabilitiesSchema,
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
   * None exists yet, so this reports false until one does.
   */
  cachingAllowed: boolean;
  /**
   * True when any requested, filtered or sorted field is a read-time computed
   * field, or a calculation that depends on one. Such a query always bypasses
   * the cache, because its result changes with the clock and no data change.
   */
  readTimeFieldsPresent: boolean;
  /** True when any requested or filtered field is personal data or its classification is unknown. */
  sensitiveFieldsPresent: boolean;
  /**
   * The published fields of the queried record type, when the caller can prove
   * them. Supplying them lets the cache policy re-derive sensitivity and
   * read-time eligibility from each derived field's recursive input closure,
   * so a calculation or total cannot hide an input; a field whose
   * classification is unknown then bypasses. When absent, the eligibility facts
   * above stand unchanged.
   */
  publishedFields?: readonly QueryCachePublishedField[];
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
type RecheckRow = ResultRow & { readonly capabilities: unknown };

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
              revision: revisionSchema,
              capabilities: protectedQueryRowCapabilitiesSchema,
              values: z.record(fieldIdSchema, jsonValueSchema),
              systemValues: recordSystemValuesSchema.optional(),
            })
            .strict(),
        )
        .max(200),
      next: z
        .object({
          // Only values of fields the reader is guaranteed to see; empty when
          // no declared sort field may be pushed, and the scan uses record identity.
          sortKey: z.array(z.string().nullable()).max(20),
          recordId: recordIdSchema,
        })
        .strict()
        .nullable(),
    })
    .strict(),
  refusedSchema,
]);

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

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

/** Every field identifier a typed condition tree reads, lower-cased; a malformed node contributes none. */
const conditionFieldIds = (condition: unknown, into: Set<string>): void => {
  if (Array.isArray(condition)) {
    for (const item of condition) conditionFieldIds(item, into);
    return;
  }
  if (condition === null || typeof condition !== "object") return;
  const record = condition as Record<string, unknown>;
  if (record.source === "field" && typeof record.fieldId === "string")
    into.add(record.fieldId.toLowerCase());
  for (const item of Object.values(record)) conditionFieldIds(item, into);
};

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
      ${JSON.stringify(command.requestedSystemFieldKeys)}::text::jsonb,
      ${JSON.stringify(userQueryInputs(command))}::text::jsonb
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

  // A user sort or filter outside the component-declared sets is refused before any read.
  const userRefusal = userInputRefusal(command);
  if (userRefusal !== undefined) return refusal(userRefusal);

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
  // The fingerprint binds the query inputs and the user's sort, filter and search alike, so a
  // continuation issued under one view can never be replayed under another.
  const inputFingerprint = fingerprintQueryInputs({
    inputValues,
    user: userQueryInputs(command),
  });
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
  // A search match is decided per row over the values readable when the page was read, which the
  // hit recheck does not re-evaluate, so a searched page always bypasses the cache.
  if (command.search !== undefined) return undefined;
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
    // A hit is reusable only while every field that drove it stays readable, so the reader's own
    // sort and filter fields join the fields the caller already named.
    const recheckedFieldIds = new Set(
      referencedFieldIds.data.map((fieldId) => fieldId.toLowerCase()),
    );
    for (const sort of command.sort) recheckedFieldIds.add(sort.fieldId.toLowerCase());
    if (command.filter !== undefined) conditionFieldIds(command.filter, recheckedFieldIds);
    if (recheckedFieldIds.size > 200) return undefined;
    // A cached body also holds the requested projection, so those fields join
    // the exact published-field evidence: a derived requested field whose
    // recursive input is sensitive cannot be cached behind its own label.
    const evaluatedFieldIds = new Set(recheckedFieldIds);
    for (const fieldId of command.requestedFieldIds) evaluatedFieldIds.add(fieldId.toLowerCase());
    if (evaluatedFieldIds.size > queryCacheMaxEvaluatedFields) return undefined;
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
        readTimeFieldsPresent: context.readTimeFieldsPresent,
        sensitiveFieldsPresent: context.sensitiveFieldsPresent,
        sharedSourceOwnership: context.sharedSourceOwnership,
      },
      // Exact evidence when the caller can prove the published fields; the
      // evaluator can only make the decision stricter. With no published fields
      // the caller's own eligibility facts stand.
      ...(context.publishedFields === undefined
        ? {}
        : {
            fieldEvidence: {
              publishedFields: [...context.publishedFields],
              evaluatedFieldIds: [...evaluatedFieldIds],
            },
          }),
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
      referencedFieldIds: [...recheckedFieldIds],
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
  concurrencyNumber: revisionSchema,
  values: z.record(z.string(), jsonValueSchema),
});

/**
 * The current-Access recheck for a hit. Every stored row goes back through
 * vortex_record.read_record and vortex_record.read_record_capabilities, the
 * same per-row projection and capabilities the ordinary query applies: the row
 * must still be readable, every filtered or sorted field must still be readable
 * on it, its values must be exactly the requested fields readable now, with
 * their current values, and its revision and capabilities must be exactly the
 * current ones. Anything else discards the hit.
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
    () => transaction.query<RecheckRow>`
      select
        vortex_record.read_record(${plan.recordTypeId}::uuid, item.record_id::uuid) as result,
        vortex_record.read_record_capabilities(
          ${plan.recordTypeId}::uuid, item.record_id::uuid
        ) as capabilities
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
    const capabilities = protectedQueryRowCapabilitiesSchema.safeParse(checked[index]?.capabilities);
    if (
      !current.success ||
      !capabilities.success ||
      row.revision !== current.data.concurrencyNumber ||
      !sameJson(row.capabilities, capabilities.data)
    )
      return false;
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
