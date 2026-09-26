import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  applicationRootIdSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
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
  const { request, scope, definition, recordDependencies, eligibility, lifetime } = parsed.data;

  if (eligibility.readTimeFieldsPresent) return bypass("read_time_fields");
  if (!eligibility.cachingAllowed) return bypass("cache_not_allowed");
  if (eligibility.sensitiveFieldsPresent) return bypass("sensitive_fields");
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
