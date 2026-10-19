import "server-only";

import type { HumanOrganizationRequestDependencies } from "../access/index";
import type { RequestDatabaseTransaction } from "../db/index";
import type { SelectedOrganizationScope } from "../schema";
import type { QueryCacheInput, QueryCachePublishedField } from "./cache-policy";
import type { QueryContinuationKey } from "./continuation-token";
import type { ProtectedQueryCommand } from "./protected-query-contracts";
import type { SharedCacheStore } from "./shared-cache-adapter";

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
export type QueryCache = Readonly<{
  store: SharedCacheStore;
  resolveContext: NonNullable<ProtectedQueryServiceDependencies["resolveQueryCacheContext"]>;
  now: () => Date;
  sessionExpiresAt: string;
}>;
