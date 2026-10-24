import "server-only";

import { z } from "zod";
import type { RequestDatabaseTransaction } from "../db/index";
import { DefinitionError } from "../definition/definition-index";
import { createActiveApplicationInstallationRepository } from "../definition/module-index";
import {
  describeFailure,
  fieldIdSchema,
  type SelectedOrganizationScope,
  type ActiveApplicationInstallationEvidence,
  sameId,
  recordTypeIdSchema,
  revisionSchema,
  jsonValueSchema,
} from "../schema";
import {
  type QueryCacheDecision,
  queryCacheMaxEvaluatedFields,
  decideQueryCache,
  type QueryCacheInput,
} from "./cache-policy";
import {
  type ProtectedQueryCommand,
  type ProtectedQueryResult,
  type ProtectedQueryPage,
  protectedQueryRowCapabilitiesSchema,
} from "./protected-query-contracts";
import { type ResultRow, type ResolvedInputs, conditionFieldIds } from "./protected-query-helpers";
import type { QueryCache } from "./protected-query-types";

type CachePlan = Readonly<{
  decision: Extract<QueryCacheDecision, { outcome: "cache" }>;
  recordTypeId: string;
  /** Lower-cased filtered and sorted field identifiers. */
  referencedFieldIds: readonly string[];
}>;

type RecheckRow = ResultRow & { readonly capabilities: unknown };

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
  } catch (error) {
    console.error(
      `[query] shared cache step bypassed QUERY_CACHE_STEP_FAILED: ${describeFailure(error)}`,
    );
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
export const planCache = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  command: ProtectedQueryCommand,
  applicationRootId: string,
  declared: ResolvedInputs,
  cache: QueryCache,
): Promise<CachePlan | undefined> => {
  // A search match is decided per row over the values readable when the page was read, which the
  // hit recheck does not re-evaluate, so a searched page always bypasses the cache. A preview reads
  // its own isolated records, which the cache does not key, so it bypasses the cache too.
  if (command.search !== undefined || scope.previewInstallationId !== undefined) return undefined;
  const context = await isolated(transaction, async () => {
    const resolved = await cache.resolveContext(transaction, scope, command, {
      moduleReleaseRevision: declared.moduleReleaseRevision,
      moduleReleaseVersion: declared.moduleReleaseVersion,
    });
    if (resolved === undefined) return undefined;
    // The Application pin must be the release this installation runs now, so
    // a page can never cross an Application upgrade.
    let installation: ActiveApplicationInstallationEvidence;
    try {
      installation = await createActiveApplicationInstallationRepository(transaction).readCurrent();
    } catch (error) {
      if (
        error instanceof DefinitionError &&
        error.cause === undefined &&
        (error.code === "ACTIVE_APPLICATION_INSTALLATION_UNAVAILABLE" ||
          error.code === "ACTIVE_APPLICATION_INSTALLATION_INCOMPLETE")
      )
        return undefined;
      throw error;
    }
    if (
      !sameId(installation.organizationId, scope.organizationId) ||
      !sameId(installation.applicationRootId, applicationRootId) ||
      installation.applicationReleaseRevision !== resolved.application.releaseRevision
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
      !context.recordDependencies.some((dependency) =>
        sameId(dependency.recordTypeId, recordTypeId.data),
      )
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
  } catch (error) {
    // Anything unresolved bypasses to the ordinary authorised query.
    console.error(
      `[query] shared cache decision bypassed QUERY_CACHE_DECISION_FAILED: ${describeFailure(error)}`,
    );
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
  const requestedFields = new Set(
    command.requestedFieldIds.map((fieldId) => fieldId.toLowerCase()),
  );
  const requestedSystem = new Set<string>(command.requestedSystemFieldKeys);
  return stored.rows.every(
    (row) =>
      Object.keys(row.values).every((fieldId) => requestedFields.has(fieldId.toLowerCase())) &&
      Object.keys(row.systemValues ?? {}).every((key) => requestedSystem.has(key)) &&
      requestedSystem.size > 0 === (row.systemValues !== undefined),
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
 * vortex_record.read_record, which returns the same per-row projection and
 * capabilities the ordinary query applies: the row
 * must still be readable, every filtered or sorted field must still be readable
 * on it, its values must be exactly the requested fields readable now, with
 * their current values, and its revision and capabilities must be exactly the
 * current ones. Anything else discards the hit.
 */
export const recheckHit = async (
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
      with current_records as materialized (
        select item.position,
          vortex_record.read_record(${plan.recordTypeId}::uuid, item.record_id::uuid) as value
        from pg_catalog.jsonb_array_elements_text(
          ${JSON.stringify(stored.rows.map((row) => row.recordId))}::text::jsonb
        ) with ordinality as item(record_id, position)
      )
      select value -> 'record' as result, value -> 'capabilities' as capabilities
      from current_records
      order by position
    `,
  );
  if (checked === undefined || checked.length !== stored.rows.length) return false;
  const requestedFieldIds = command.requestedFieldIds.map((fieldId) => fieldId.toLowerCase());
  return stored.rows.every((row, index) => {
    const current = readableRecordSchema.safeParse(checked[index]?.result);
    const capabilities = protectedQueryRowCapabilitiesSchema.safeParse(
      checked[index]?.capabilities,
    );
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
