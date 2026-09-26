import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  applicationRootIdSchema,
  fieldIdSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  personalDataClassSchema,
  recordTypeIdSchema,
  revisionSchema,
  stableDefinitionReleaseVersionSchema,
  timestampSchema,
} from "@vortex/contracts";
import { protectedQueryCommandSchema } from "./protected-query-contracts";

/**
 * Query cache policy. Given a Query request that has already been permitted and
 * the exact definition and Access version read for this request, it returns
 * either one canonical bounded cache key with its expiry or a bypass.
 *
 * A committed Record save no longer increments one shared per-record-type
 * counter: freshness is bounded by the policy lifetime, and a save publishes a
 * content-free post-commit invalidation notice instead. The Record types a
 * query reads still scope the key, but no Record data version is part of it.
 *
 * It never reads a store, a clock or a database and never grants anything: a
 * hit still passes the current permission and field recheck that
 * `readThroughQueryCache` requires before reuse.
 * A query that reads a read-time computed field (such as deadline-passed) always
 * bypasses: its value changes with the clock and no data change, so no data-result
 * cache entry may hold it.
 * Anything that cannot be established (a missing or repeated dependency, an
 * unproven authority window, sensitive fields, a shared-source result, or a
 * malformed input) bypasses, so the ordinary authorised query runs instead.
 */

export const queryCacheKeyVersion = "v2";
export const queryCacheMaxTtlSeconds = 3_600;
export const queryCacheMaxRecordDependencies = 50;
export const queryCacheMaxPublishedFields = 500;
export const queryCacheMaxEvaluatedFields = 500;

export const queryCacheBypassReasons = [
  "policy_invalid",
  "cache_not_allowed",
  "read_time_fields",
  "sensitive_fields",
  "shared_source",
  "dependencies_unknown",
  "authority_unknown",
  "authority_expired",
] as const;
export type QueryCacheBypassReason = (typeof queryCacheBypassReasons)[number];

/**
 * The published facts cache eligibility reads from one field: its data class
 * and, for a derived field, the published settings that name its inputs. Unknown
 * keys are stripped, so a caller forwards each published field unchanged.
 */
export const queryCachePublishedFieldSchema = z.object({
  fieldId: fieldIdSchema,
  type: z.string().min(1),
  personalData: z.string().min(1),
  settings: z.unknown().optional(),
});
export type QueryCachePublishedField = z.infer<typeof queryCachePublishedFieldSchema>;

const isPublishedSettings = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Every field identifier a derived field's published settings read, direct or
 * nested. It is deliberately broad and mirrors the search-index policy's own
 * walk: an extra input only makes the closure stricter, which is the fail-closed
 * direction. It recognises the published reference names `fieldId`, `*FieldId`
 * and `*FieldIds`.
 */
const derivedFieldInputIds = (settings: unknown): readonly string[] => {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isPublishedSettings(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      if ((key === "fieldId" || key.endsWith("FieldId")) && typeof entry === "string") {
        found.add(entry);
        continue;
      }
      if (key.endsWith("FieldIds") && Array.isArray(entry)) {
        for (const item of entry) if (typeof item === "string") found.add(item);
        continue;
      }
      visit(entry);
    }
  };
  visit(settings);
  return [...found];
};

/** Whether a calculation is worked out at read time from its own published shape. */
const isReadTimeCalculation = (field: QueryCachePublishedField): boolean => {
  if (field.type !== "calculation") return false;
  // A calculation whose settings or expression cannot be read is treated as
  // read-time, so an unrecognised shape can never enter a data-result cache.
  if (!isPublishedSettings(field.settings)) return true;
  if (field.settings.evaluation === "read_time") return true;
  const expression = field.settings.expression;
  if (!isPublishedSettings(expression) || typeof expression.kind !== "string") return true;
  return expression.kind === "deadline_passed";
};

/**
 * Cache eligibility of the exact fields a request reads, derived from published
 * field sensitivity and the recursive input closure of every derived field. A
 * field is sensitive when its own data class is not `none` or its class is
 * unknown, and a derived field is sensitive when any recursive input is. A
 * calculation is read-time when its expression uses the current time or it
 * depends on one. A missing field is treated as sensitive, so unknown metadata
 * always bypasses rather than caching a possibly hidden value.
 */
export const queryCacheFieldEligibilityFor = (
  fields: readonly QueryCachePublishedField[],
  fieldIds: readonly string[],
): Readonly<{ sensitiveFieldsPresent: boolean; readTimeFieldsPresent: boolean }> => {
  const byId = new Map<string, QueryCachePublishedField>();
  for (const field of fields) byId.set(field.fieldId.toLowerCase(), field);

  const visiting = new Set<string>();
  const decided = new Map<string, Readonly<{ sensitive: boolean; readTime: boolean }>>();
  const classify = (fieldId: string): Readonly<{ sensitive: boolean; readTime: boolean }> => {
    const key = fieldId.toLowerCase();
    const cached = decided.get(key);
    if (cached !== undefined) return cached;
    if (visiting.has(key)) return Object.freeze({ sensitive: true, readTime: false });
    const field = byId.get(key);
    if (field === undefined) return Object.freeze({ sensitive: true, readTime: false });
    const classification = personalDataClassSchema.safeParse(field.personalData);
    let sensitive = !classification.success || classification.data !== "none";
    let readTime = isReadTimeCalculation(field);
    if (field.type === "calculation" || field.type === "total") {
      visiting.add(key);
      for (const input of derivedFieldInputIds(field.settings)) {
        const state = classify(input);
        if (state.sensitive) sensitive = true;
        if (state.readTime) readTime = true;
      }
      visiting.delete(key);
    }
    const state = Object.freeze({ sensitive, readTime });
    decided.set(key, state);
    return state;
  };

  let sensitiveFieldsPresent = false;
  let readTimeFieldsPresent = false;
  for (const fieldId of fieldIds) {
    const state = classify(fieldId);
    if (state.sensitive) sensitiveFieldsPresent = true;
    if (state.readTime) readTimeFieldsPresent = true;
  }
  return Object.freeze({ sensitiveFieldsPresent, readTimeFieldsPresent });
};

/**
 * The Record types a query reads. Only the identity is part of the key: with no
 * shared per-record-type data version, reuse is bounded by the policy lifetime
 * and a committed save publishes a content-free invalidation notice. A legacy
 * input that still carries a `dataVersion` is accepted and ignored rather than
 * failing the policy.
 */
const dependencySchema = z.object({ recordTypeId: recordTypeIdSchema });

const pinnedReleaseSchema = z
  .object({
    releaseRevision: revisionSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    fingerprint: fingerprintSchema,
  })
  .strict();

/**
 * The versioned context of one permitted Query request. `recordDependencies`
 * may be empty only when the caller could not establish them, which bypasses.
 */
export const queryCacheInputSchema = z
  .object({
    request: protectedQueryCommandSchema,
    scope: z
      .object({
        organizationId: organizationIdSchema,
        organizationAccountId: organizationAccountIdSchema,
        applicationRootId: applicationRootIdSchema,
        /** Current Access version, read for this request before lookup. */
        accessVersion: revisionSchema,
      })
      .strict(),
    definition: z
      .object({
        moduleRootId: moduleRootIdSchema,
        module: pinnedReleaseSchema,
        application: pinnedReleaseSchema,
      })
      .strict(),
    /** Every Record type the query reads. */
    recordDependencies: z.array(dependencySchema).max(queryCacheMaxRecordDependencies),
    eligibility: z
      .object({
        /** True only when the Query declaration explicitly allows result caching. */
        cachingAllowed: z.boolean(),
        /**
         * True when any requested, filtered or sorted field is a read-time computed field, or a
         * calculation that depends on one. Its value changes without a data change.
         */
        readTimeFieldsPresent: z.boolean(),
        /** True when any requested or filtered field is sensitive or its sensitivity is unknown. */
        sensitiveFieldsPresent: z.boolean(),
        /** True when any row can come from another organisation's shared source. */
        sharedSourceOwnership: z.enum(["none", "shared"]),
      })
      .strict(),
    /**
     * The exact published-field evidence for the fields this request reads.
     * When supplied, sensitivity and read-time eligibility are re-derived from
     * each derived field's recursive input closure, so a calculation or total
     * labelled `none` cannot hide a sensitive or read-time input behind its own
     * field. The evaluator can only make the decision stricter than the
     * eligibility facts above, never looser; a field in `evaluatedFieldIds`
     * that `publishedFields` does not classify counts as sensitive. When absent,
     * the caller's own eligibility facts stand. A classification change is a new
     * Module release fingerprint, which already changes the key, so no separate
     * invalidation counter is needed; an access change changes `accessVersion`.
     */
    fieldEvidence: z
      .object({
        publishedFields: z.array(queryCachePublishedFieldSchema).max(queryCacheMaxPublishedFields),
        evaluatedFieldIds: z.array(fieldIdSchema).max(queryCacheMaxEvaluatedFields),
      })
      .strict()
      .optional(),
    lifetime: z
      .object({
        now: timestampSchema,
        /** Cache-policy lifetime, in seconds. */
        policyTtlSeconds: z.number().int().min(1).max(queryCacheMaxTtlSeconds),
        /** When the current authority (grant or account state) stops being valid. */
        authorityValidUntil: timestampSchema.optional(),
        /** When the session or request context expires. */
        sessionExpiresAt: timestampSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type QueryCacheInput = z.input<typeof queryCacheInputSchema>;

export type QueryCacheDecision =
  | Readonly<{
      outcome: "cache";
      /** `vortex:query:v2:<organisationId>:<sha256>`, at most 128 characters. */
      key: string;
      /** ISO instant at which reuse ends: the earliest of policy, authority and session limits. */
      expiresAt: string;
      ttlSeconds: number;
    }>
  | Readonly<{ outcome: "bypass"; reason: QueryCacheBypassReason }>;

const bypass = (reason: QueryCacheBypassReason): QueryCacheDecision =>
  Object.freeze({ outcome: "bypass", reason });

const lower = (value: string): string => value.toLowerCase();

/** Stable JSON: object keys sorted, so equal contexts always hash equally. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export const decideQueryCache = (input: unknown): QueryCacheDecision => {
  const parsed = queryCacheInputSchema.safeParse(input);
  if (!parsed.success) return bypass("policy_invalid");
  const { request, scope, definition, recordDependencies, eligibility, lifetime, fieldEvidence } =
    parsed.data;

  // Published-field evidence is the exact rule when supplied; it can only widen
  // the bypass, never narrow it. Without evidence the caller's own eligibility
  // facts stand, which an unknown field classification already bypasses.
  const derived = fieldEvidence === undefined
    ? undefined
    : queryCacheFieldEligibilityFor(fieldEvidence.publishedFields, fieldEvidence.evaluatedFieldIds);
  if (eligibility.readTimeFieldsPresent || derived?.readTimeFieldsPresent === true)
    return bypass("read_time_fields");
  if (!eligibility.cachingAllowed) return bypass("cache_not_allowed");
  if (eligibility.sensitiveFieldsPresent || derived?.sensitiveFieldsPresent === true)
    return bypass("sensitive_fields");
  if (eligibility.sharedSourceOwnership !== "none") return bypass("shared_source");
  if (lower(request.moduleRootId) !== lower(definition.moduleRootId)) return bypass("policy_invalid");

  const dependencyRecordTypeIds = recordDependencies
    .map((dependency) => lower(dependency.recordTypeId))
    .sort();
  if (
    dependencyRecordTypeIds.length === 0 ||
    new Set(dependencyRecordTypeIds).size !== dependencyRecordTypeIds.length
  )
    return bypass("dependencies_unknown");

  const now = Date.parse(lifetime.now);
  const limits = [lifetime.authorityValidUntil, lifetime.sessionExpiresAt];
  // Reuse must end by an authority window and a session window that are both
  // proven; without either one the reuse period is unknown.
  if (limits.some((limit) => limit === undefined)) return bypass("authority_unknown");
  const expiresAtMs = Math.min(
    now + lifetime.policyTtlSeconds * 1_000,
    ...limits.map((limit) => Date.parse(limit as string)),
  );
  const ttlSeconds = Math.floor((expiresAtMs - now) / 1_000);
  if (ttlSeconds < 1) return bypass("authority_expired");

  const fingerprint = createHash("sha256")
    .update(
      canonicalJson({
        keyVersion: queryCacheKeyVersion,
        organizationId: lower(scope.organizationId),
        organizationAccountId: lower(scope.organizationAccountId),
        applicationRootId: lower(scope.applicationRootId),
        accessVersion: scope.accessVersion,
        definition: {
          moduleRootId: lower(definition.moduleRootId),
          module: definition.module,
          application: definition.application,
        },
        recordTypeDependencies: dependencyRecordTypeIds,
        // The request's own identifiers keep their exact spelling: the Query
        // result echoes them, so a hit must come from an identical request.
        query: {
          moduleRootId: request.moduleRootId,
          queryId: request.queryId,
          inputValues: request.inputValues,
          requestedFieldIds: [...request.requestedFieldIds].sort(),
          requestedSystemFieldKeys: [...request.requestedSystemFieldKeys].sort(),
          sort: request.sort.map((entry) => ({
            fieldId: lower(entry.fieldId),
            direction: entry.direction,
          })),
          filter: request.filter ?? null,
          search: request.search ?? null,
          sortableFieldIds: [...request.sortableFieldIds].map(lower).sort(),
          filterableFieldIds: [...request.filterableFieldIds].map(lower).sort(),
          searchableFieldIds: [...request.searchableFieldIds].map(lower).sort(),
          pageSize: request.pageSize,
          continuationToken: request.continuationToken ?? null,
        },
      }),
      "utf8",
    )
    .digest("hex");

  return Object.freeze({
    outcome: "cache",
    key: `vortex:query:${queryCacheKeyVersion}:${lower(scope.organizationId)}:${fingerprint}`,
    expiresAt: new Date(now + ttlSeconds * 1_000).toISOString(),
    ttlSeconds,
  });
};
