import "server-only";

import {
  eventOccurrenceEnvelopeV2Schema,
  organizationIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  timestampSchema,
  type EventOccurrenceEnvelopeV2,
  type RecordTypeDefinitionV2,
} from "@vortex/contracts";
import {
  buildSearchDocument,
  searchDocumentStoreCommand,
  searchableFieldConfigurationFor,
  type SearchDocumentRefusalCode,
  type SearchDocumentStoreCommand,
  type SearchDocumentStoreOutcome,
  type SearchableFieldPolicy,
  type SearchRecordSnapshot,
} from "./document-store";

/**
 * Event-driven search refresh (#644).
 *
 * One ordered batch of committed Event occurrences from #639 is turned into
 * idempotent document upserts and deletion markers through the #643 builder and
 * store command, or into a bounded rebuild checkpoint after a search
 * configuration or privacy-policy change. Delivery always re-reads the current
 * Record snapshot, including a soft-deleted one, and indexes it under that
 * snapshot's own concurrency version. The occurrence's record sequence is an
 * Event counter, not a Record version, so it never versions a document; a
 * stale or duplicate occurrence can therefore only re-store current state, and
 * #643 storage additionally ignores an older source version. Documents stay
 * content-only: entries carry field identity, and read-time permission is
 * rechecked by #645, which is why this consumer never records or returns an
 * access decision.
 */

/** Consumer identity registered with the #641 dispatcher for organisation search indexing. */
export const searchEventConsumerKey = "search.documents" as const;

/** Normal-operation target from the search specification: changes appear within ten seconds. */
export const searchIndexFreshnessTargetMs = 10_000;

/**
 * Past this lag a delayed index is reported `stale`: an outage rather than a
 * transient delay. Both states past the target require recovery.
 */
export const searchIndexStaleCeilingMs = 300_000;

export const searchEventConsumerLimits = Object.freeze({
  maximumOccurrences: 100,
  maximumRebuildPage: 100,
  freshnessTargetMs: searchIndexFreshnessTargetMs,
  staleCeilingMs: searchIndexStaleCeilingMs,
});

export const searchEventConsumerErrorCodes = [
  "INVALID_SEARCH_EVENT_BATCH",
  "INVALID_SEARCH_REBUILD_INPUT",
  "SEARCH_REBUILD_RECORD_TYPE_UNAVAILABLE",
] as const;

export type SearchEventConsumerErrorCode = (typeof searchEventConsumerErrorCodes)[number];

export class SearchEventConsumerError extends Error {
  readonly code: SearchEventConsumerErrorCode;

  constructor(code: SearchEventConsumerErrorCode) {
    super(code);
    this.name = "SearchEventConsumerError";
    this.code = code;
  }
}

/**
 * The exact published record shape consumed by #643's configuration
 * derivation. A record type that has not published a search-relevant field is
 * still a valid configuration: every field is then simply left out.
 */
export type SearchIndexRecordType = Pick<RecordTypeDefinitionV2, "recordTypeId" | "fields">;

/**
 * Server-side reads and the idempotent write the consumer needs. A loader never
 * receives a caller-chosen organisation or permission: the occurrence supplies
 * both the organisation and the record, and the store implementation must apply
 * #643's own version ordering rather than trusting the caller.
 *
 * `loadRecordSnapshot` returns the Record's current state in the occurrence's
 * organisation: an active record as `active`, a soft-deleted or removal-pending
 * record as `deleted`, each at its current concurrency number. It returns
 * `undefined` only when the record cannot be read at all.
 */
export type SearchIndexOccurrenceDependencies = Readonly<{
  loadRecordType: (
    occurrence: EventOccurrenceEnvelopeV2,
  ) => Promise<SearchIndexRecordType | undefined>;
  loadPolicy: (occurrence: EventOccurrenceEnvelopeV2) => Promise<SearchableFieldPolicy>;
  loadRecordSnapshot: (
    occurrence: EventOccurrenceEnvelopeV2,
  ) => Promise<SearchRecordSnapshot | undefined>;
  storeDocument: (command: SearchDocumentStoreCommand) => Promise<SearchDocumentStoreOutcome>;
}>;

export type SearchOccurrenceSkipReason =
  | "not_indexable_event"
  | "record_type_unavailable"
  | "record_unavailable";

export type SearchIndexOccurrenceOutcome =
  | Readonly<{ kind: "skipped"; reason: SearchOccurrenceSkipReason }>
  | Readonly<{
      kind: "indexed";
      command: SearchDocumentStoreCommand;
      storeOutcome: SearchDocumentStoreOutcome;
    }>
  | Readonly<{ kind: "refused"; code: SearchDocumentRefusalCode }>;

export type SearchIndexOccurrenceResult = Readonly<{
  occurrenceId: string;
  organizationId: string;
  recordTypeId: string;
  recordId: string;
  recordSequence: number;
  outcome: SearchIndexOccurrenceOutcome;
}>;

export type ConsumeSearchEventsInput = Readonly<{
  occurrences: readonly EventOccurrenceEnvelopeV2[];
  /** Indexing observation instant; defaults to the current time. */
  observedAt?: string;
}>;

export type ConsumeSearchEventsResult = Readonly<{
  results: readonly SearchIndexOccurrenceResult[];
  /** How late this batch was indexed: the lag of its oldest occurrence at observation. */
  freshness: SearchIndexFreshness;
  /** Latest instant among occurrences whose document was stored. */
  lastIndexedAt: string | undefined;
  indexedCount: number;
  skippedCount: number;
  refusedCount: number;
}>;

export type SearchIndexFreshnessState = "fresh" | "delayed" | "stale" | "unknown";

export type SearchIndexFreshness = Readonly<{
  state: SearchIndexFreshnessState;
  targetMs: number;
  staleCeilingMs: number;
  lagMs: number | undefined;
  requiresRecovery: boolean;
}>;

export type SearchIndexFreshnessInput = Readonly<{
  /**
   * Instant of the oldest committed occurrence the index has not yet processed,
   * or `null` when the index is caught up. Measuring from the last indexed
   * change instead would report an idle, fully current index as stale.
   */
  oldestUnindexedAt: string | null;
  /** Observation instant; defaults to the current time. */
  observedAt?: string;
}>;

/**
 * Resumable, content-free cursor for a bounded rebuild over one organisation and
 * record type. `afterRecordId` is exclusive; the caller persists it between
 * pages and passes it back unchanged, and a complete checkpoint does no more work.
 */
export type SearchRebuildCheckpoint = Readonly<{
  organizationId: string;
  recordTypeId: string;
  afterRecordId: string | undefined;
  processedCount: number;
  complete: boolean;
}>;

export type SearchRebuildCandidate = Readonly<{ snapshot: SearchRecordSnapshot }>;

export type SearchRebuildStored = Readonly<{
  recordId: string;
  command: SearchDocumentStoreCommand;
  storeOutcome: SearchDocumentStoreOutcome;
}>;

export type SearchRebuildRefusal = Readonly<{
  recordId: string;
  code: SearchDocumentRefusalCode;
}>;

export type SearchRebuildPageResult = Readonly<{
  checkpoint: SearchRebuildCheckpoint;
  stored: readonly SearchRebuildStored[];
  refused: readonly SearchRebuildRefusal[];
}>;

/**
 * `listRebuildCandidates` returns the organisation's records of one record type
 * in ascending record identity after `afterRecordId`, at most `limit`, each as
 * its current snapshot (soft-deleted records as `deleted`, so their markers are
 * refreshed too), and `complete` once no record follows the page.
 */
export type SearchRebuildDependencies = Readonly<{
  loadRecordType: (
    input: Readonly<{ organizationId: string; recordTypeId: string }>,
  ) => Promise<SearchIndexRecordType | undefined>;
  loadPolicy: (input: Readonly<{ organizationId: string }>) => Promise<SearchableFieldPolicy>;
  listRebuildCandidates: (
    input: Readonly<{
      organizationId: string;
      recordTypeId: string;
      afterRecordId: string | undefined;
      limit: number;
    }>,
  ) => Promise<Readonly<{ candidates: readonly SearchRebuildCandidate[]; complete: boolean }>>;
  storeDocument: (command: SearchDocumentStoreCommand) => Promise<SearchDocumentStoreOutcome>;
}>;

export type PlanSearchRebuildInput = Readonly<{
  organizationId: string;
  recordTypeId: string;
  checkpoint?: SearchRebuildCheckpoint;
  pageSize?: number;
}>;

/**
 * Delivery failure classification. Search emits the same names #640 recovery
 * accepts for its own failures rather than inventing a second vocabulary; every
 * value below is one of that closed set, so the dispatcher's
 * `failureClassificationMatches` accepts it unchanged.
 */
export type SearchDeliveryFailureCode =
  | "transient_dependency_unavailable"
  | "transient_timeout"
  | "validation_rejected"
  | "authorization_denied"
  | "unclassified";

/**
 * One claimed occurrence handed to the consumer. This is structurally the #641
 * `EventConsumerDelivery`, declared locally because a runtime service may not
 * depend on a same-tier service package.
 */
export type SearchEventDelivery = Readonly<{
  occurrence: EventOccurrenceEnvelopeV2;
  renewLease: () => Promise<boolean>;
}>;

export type SearchEventConsumerOutcome =
  | Readonly<{ outcome: "completed" }>
  | Readonly<{ outcome: "retryable_failure"; failureCode: SearchDeliveryFailureCode }>
  | Readonly<{ outcome: "terminal_failure"; failureCode: SearchDeliveryFailureCode }>;

export type SearchEventConsumer = Readonly<{
  consumerKey: typeof searchEventConsumerKey;
  deliver: (delivery: SearchEventDelivery) => Promise<SearchEventConsumerOutcome>;
}>;

/**
 * Event kinds that can change a searchable document. An ownership reassignment
 * is a new Record version too, so it is refreshed like any record change; when
 * no searchable text changed, storage records it as a replay or replacement of
 * identical content. Link and declaration events cannot change a document:
 * link and person-link fields carry no indexed text, and declared events are not
 * a standard record change.
 */
const indexableEventKinds: ReadonlySet<string> = new Set([
  "created",
  "changed",
  "deleted",
  "state_changed",
  "reassigned",
]);

const occurrenceIsIndexable = (occurrence: EventOccurrenceEnvelopeV2): boolean =>
  indexableEventKinds.has(occurrence.payload.kind);

/**
 * Storage orders claimed occurrences by microsecond `occurred_at`; `Date.parse`
 * keeps only milliseconds, so compare the exact instant including microseconds.
 */
const occurredAtMicros = (value: string): bigint | undefined => {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null) return undefined;
  const wholeSeconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(wholeSeconds)) return undefined;
  return BigInt(wholeSeconds) * 1_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
};

const isIdentifier = (
  schema: Readonly<{ safeParse: (value: unknown) => Readonly<{ success: boolean }> }>,
  value: unknown,
): value is string => typeof value === "string" && schema.safeParse(value).success;

const laterTimestamp = (current: string | undefined, candidate: string): string => {
  if (current === undefined) return candidate;
  const currentMs = Date.parse(current);
  const candidateMs = Date.parse(candidate);
  return Number.isFinite(currentMs) && Number.isFinite(candidateMs) && candidateMs < currentMs
    ? current
    : candidate;
};

const clampInteger = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, Math.trunc(value)));

const batchInvalid = (): never => {
  throw new SearchEventConsumerError("INVALID_SEARCH_EVENT_BATCH");
};

/**
 * Re-validates and orders one batch. Occurrences must be strictly ordered by
 * instant then identity, matching the #639 claim order, and no two occurrences
 * for one record may arrive in non-increasing sequence. A violation refuses the
 * whole batch rather than indexing out of order.
 */
const validateOccurrenceBatch = (candidate: unknown): readonly EventOccurrenceEnvelopeV2[] => {
  if (!Array.isArray(candidate) || candidate.length > searchEventConsumerLimits.maximumOccurrences)
    return batchInvalid();
  const parsed: EventOccurrenceEnvelopeV2[] = [];
  for (const item of candidate) {
    const occurrence = eventOccurrenceEnvelopeV2Schema.safeParse(item);
    if (!occurrence.success) return batchInvalid();
    const previous = parsed[parsed.length - 1];
    if (previous !== undefined) {
      const previousMicros = occurredAtMicros(previous.occurredAt);
      const currentMicros = occurredAtMicros(occurrence.data.occurredAt);
      if (
        previousMicros === undefined ||
        currentMicros === undefined ||
        previousMicros > currentMicros ||
        (previousMicros === currentMicros &&
          previous.occurrenceId.toLowerCase() >= occurrence.data.occurrenceId.toLowerCase())
      )
        return batchInvalid();
    }
    parsed.push(occurrence.data);
  }
  const highestSequence = new Map<string, number>();
  for (const occurrence of parsed) {
    const recordKey = `${occurrence.organizationId}:${occurrence.recordId}`;
    const seen = highestSequence.get(recordKey);
    if (seen !== undefined && occurrence.recordSequence <= seen) return batchInvalid();
    highestSequence.set(recordKey, occurrence.recordSequence);
  }
  return Object.freeze(parsed);
};

const occurrenceResult = (
  occurrence: EventOccurrenceEnvelopeV2,
  outcome: SearchIndexOccurrenceOutcome,
): SearchIndexOccurrenceResult =>
  Object.freeze({
    occurrenceId: occurrence.occurrenceId,
    organizationId: occurrence.organizationId,
    recordTypeId: occurrence.descriptor.recordTypeId,
    recordId: occurrence.recordId,
    recordSequence: occurrence.recordSequence,
    outcome,
  });

/**
 * Indexes exactly one occurrence: it re-reads the current record type and
 * snapshot, derives the exact #643 configuration, and stores the idempotent
 * document or deletion marker. A `deleted` occurrence is handled the same way:
 * the soft-deleted snapshot yields a content-free marker at the Record's own
 * deleting version, and a record restored since then is indexed as it now is.
 * The store command always carries the snapshot's concurrency version, so an
 * older occurrence can never seed an older document; #643 storage repeats that
 * ordering check.
 */
const indexOccurrence = async (
  occurrence: EventOccurrenceEnvelopeV2,
  dependencies: SearchIndexOccurrenceDependencies,
): Promise<SearchIndexOccurrenceResult> => {
  if (!occurrenceIsIndexable(occurrence))
    return occurrenceResult(occurrence, { kind: "skipped", reason: "not_indexable_event" });

  const recordType = await dependencies.loadRecordType(occurrence);
  if (recordType === undefined || recordType.recordTypeId !== occurrence.descriptor.recordTypeId)
    return occurrenceResult(occurrence, { kind: "skipped", reason: "record_type_unavailable" });

  const policy = await dependencies.loadPolicy(occurrence);
  const configuration = searchableFieldConfigurationFor(recordType, policy);

  const snapshot = await dependencies.loadRecordSnapshot(occurrence);
  if (snapshot === undefined)
    return occurrenceResult(occurrence, { kind: "skipped", reason: "record_unavailable" });
  if (
    snapshot.indexOrganisationId !== occurrence.organizationId ||
    snapshot.recordTypeId !== recordType.recordTypeId ||
    snapshot.recordId !== occurrence.recordId
  )
    return occurrenceResult(occurrence, { kind: "refused", code: "invalid_snapshot" });

  const built = buildSearchDocument(snapshot, configuration, policy);
  if (!built.success) return occurrenceResult(occurrence, { kind: "refused", code: built.code });

  const command = searchDocumentStoreCommand(built.output);
  const storeOutcome = await dependencies.storeDocument(command);
  return occurrenceResult(occurrence, { kind: "indexed", command, storeOutcome });
};

/**
 * Processes one ordered #639 batch and reports both per-occurrence outcomes and
 * how late the batch was indexed. A batch out of claim order, or with a
 * non-increasing sequence for one record, is refused whole. Re-delivery is
 * safe: every occurrence re-reads current state, and #643 storage replays the
 * same version and ignores an older one.
 */
export const consumeSearchEvents = async (
  input: ConsumeSearchEventsInput,
  dependencies: SearchIndexOccurrenceDependencies,
): Promise<ConsumeSearchEventsResult> => {
  const occurrences = validateOccurrenceBatch(input.occurrences);
  const results: SearchIndexOccurrenceResult[] = [];
  let lastIndexedAt: string | undefined;

  for (const occurrence of occurrences) {
    const result = await indexOccurrence(occurrence, dependencies);
    results.push(result);
    if (result.outcome.kind === "indexed")
      lastIndexedAt = laterTimestamp(lastIndexedAt, occurrence.occurredAt);
  }

  // The batch is in claim order, so its first occurrence has waited longest.
  const freshness = searchIndexFreshness({
    oldestUnindexedAt: occurrences[0]?.occurredAt ?? null,
    ...(input.observedAt === undefined ? {} : { observedAt: input.observedAt }),
  });

  return Object.freeze({
    results: Object.freeze(results),
    freshness,
    lastIndexedAt,
    indexedCount: results.filter((result) => result.outcome.kind === "indexed").length,
    skippedCount: results.filter((result) => result.outcome.kind === "skipped").length,
    refusedCount: results.filter((result) => result.outcome.kind === "refused").length,
  });
};

/**
 * Reports whether indexing is within the specification's normal-operation
 * ten-second target, measured from the oldest committed occurrence not yet
 * indexed; a caught-up index is `fresh`. A delayed or stale index is visible as
 * its own state with `requiresRecovery` (the specification's freshness warning
 * and recovery trigger), never as a broader search that bypasses current access.
 */
export const searchIndexFreshness = (input: SearchIndexFreshnessInput): SearchIndexFreshness => {
  const observed = timestampSchema.safeParse(input.observedAt ?? new Date().toISOString());
  const pending =
    input.oldestUnindexedAt === null ? null : timestampSchema.safeParse(input.oldestUnindexedAt);
  if (observed.success && pending === null)
    return Object.freeze({
      state: "fresh",
      targetMs: searchIndexFreshnessTargetMs,
      staleCeilingMs: searchIndexStaleCeilingMs,
      lagMs: 0,
      requiresRecovery: false,
    });
  if (!observed.success || pending === null || !pending.success)
    return Object.freeze({
      state: "unknown",
      targetMs: searchIndexFreshnessTargetMs,
      staleCeilingMs: searchIndexStaleCeilingMs,
      lagMs: undefined,
      requiresRecovery: false,
    });

  const lagMs = Math.max(0, Date.parse(observed.data) - Date.parse(pending.data));
  const state: SearchIndexFreshnessState =
    lagMs <= searchIndexFreshnessTargetMs
      ? "fresh"
      : lagMs <= searchIndexStaleCeilingMs
        ? "delayed"
        : "stale";
  return Object.freeze({
    state,
    targetMs: searchIndexFreshnessTargetMs,
    staleCeilingMs: searchIndexStaleCeilingMs,
    lagMs,
    requiresRecovery: state !== "fresh",
  });
};

/**
 * Rebuilds at most one bounded page of a record type's documents under the
 * current configuration and privacy policy. Rebuilding reuses each snapshot's
 * existing version, so #643 storage classifies unchanged content as a replay and
 * replaces only documents whose searchable text or permitted fields changed.
 * The returned checkpoint is content-free and resumable across calls. A
 * checkpoint for another organisation or record type is refused, and every
 * listed snapshot must belong to the organisation and record type rebuilt.
 */
export const planSearchRebuildPage = async (
  input: PlanSearchRebuildInput,
  dependencies: SearchRebuildDependencies,
): Promise<SearchRebuildPageResult> => {
  const resumed = input.checkpoint;
  if (
    !isIdentifier(organizationIdSchema, input.organizationId) ||
    !isIdentifier(recordTypeIdSchema, input.recordTypeId) ||
    (input.pageSize !== undefined && !Number.isFinite(input.pageSize)) ||
    (resumed !== undefined &&
      (resumed.organizationId !== input.organizationId ||
        resumed.recordTypeId !== input.recordTypeId ||
        (resumed.afterRecordId !== undefined &&
          !isIdentifier(recordIdSchema, resumed.afterRecordId)) ||
        !Number.isSafeInteger(resumed.processedCount) ||
        resumed.processedCount < 0))
  )
    throw new SearchEventConsumerError("INVALID_SEARCH_REBUILD_INPUT");
  if (resumed?.complete === true)
    return Object.freeze({
      checkpoint: resumed,
      stored: Object.freeze([]),
      refused: Object.freeze([]),
    });

  const pageSize = clampInteger(
    input.pageSize ?? searchEventConsumerLimits.maximumRebuildPage,
    1,
    searchEventConsumerLimits.maximumRebuildPage,
  );

  const recordType = await dependencies.loadRecordType({
    organizationId: input.organizationId,
    recordTypeId: input.recordTypeId,
  });
  if (recordType === undefined || recordType.recordTypeId !== input.recordTypeId)
    throw new SearchEventConsumerError("SEARCH_REBUILD_RECORD_TYPE_UNAVAILABLE");

  const policy = await dependencies.loadPolicy({ organizationId: input.organizationId });
  const configuration = searchableFieldConfigurationFor(recordType, policy);
  const listed = await dependencies.listRebuildCandidates({
    organizationId: input.organizationId,
    recordTypeId: input.recordTypeId,
    afterRecordId: resumed?.afterRecordId,
    limit: pageSize,
  });
  // A listing longer than the page is cut to it and resumed after its last record.
  const candidates = listed.candidates.slice(0, pageSize);
  const complete = listed.complete && candidates.length === listed.candidates.length;

  const stored: SearchRebuildStored[] = [];
  const refused: SearchRebuildRefusal[] = [];
  let afterRecordId = resumed?.afterRecordId;
  for (const { snapshot } of candidates) {
    // The cursor is only resumable over this organisation's record type in
    // ascending identity (lower-case text order is storage's UUID order).
    if (
      snapshot.indexOrganisationId !== input.organizationId ||
      snapshot.recordTypeId !== input.recordTypeId ||
      !isIdentifier(recordIdSchema, snapshot.recordId) ||
      (afterRecordId !== undefined &&
        snapshot.recordId.toLowerCase() <= afterRecordId.toLowerCase())
    )
      throw new SearchEventConsumerError("INVALID_SEARCH_REBUILD_INPUT");
    const built = buildSearchDocument(snapshot, configuration, policy);
    if (!built.success) {
      refused.push(Object.freeze({ recordId: snapshot.recordId, code: built.code }));
    } else {
      const command = searchDocumentStoreCommand(built.output);
      const storeOutcome = await dependencies.storeDocument(command);
      stored.push(Object.freeze({ recordId: snapshot.recordId, command, storeOutcome }));
    }
    afterRecordId = snapshot.recordId;
  }

  const checkpoint: SearchRebuildCheckpoint = Object.freeze({
    organizationId: input.organizationId,
    recordTypeId: input.recordTypeId,
    afterRecordId,
    processedCount: (resumed?.processedCount ?? 0) + candidates.length,
    complete,
  });
  return Object.freeze({
    checkpoint,
    stored: Object.freeze(stored),
    refused: Object.freeze(refused),
  });
};

/**
 * The #641 dispatcher-compatible consumer. A deterministic refusal is terminal so
 * a malformed or shared-source occurrence cannot poison its record sequence; a
 * missing record type or snapshot is retryable because publication or a later
 * change can still make it indexable. Duplicate delivery is safe because the
 * store command is idempotent on the document's version and content fingerprint.
 *
 * One delivery indexes exactly one occurrence and completes well inside the
 * lease the dispatcher renews immediately before invoking it, so the delivery's
 * `renewLease` is not called and no second progress transaction is opened. The
 * batch entry point {@link consumeSearchEvents} is used where a caller already
 * holds ordered occurrences without a lease.
 */
export const createSearchEventConsumer = (
  dependencies: SearchIndexOccurrenceDependencies,
): SearchEventConsumer =>
  Object.freeze({
    consumerKey: searchEventConsumerKey,
    async deliver(delivery: SearchEventDelivery): Promise<SearchEventConsumerOutcome> {
      const occurrence = eventOccurrenceEnvelopeV2Schema.safeParse(delivery.occurrence);
      if (!occurrence.success)
        return { outcome: "terminal_failure", failureCode: "validation_rejected" };

      let result: SearchIndexOccurrenceResult;
      try {
        result = await indexOccurrence(occurrence.data, dependencies);
      } catch {
        return { outcome: "retryable_failure", failureCode: "transient_dependency_unavailable" };
      }

      switch (result.outcome.kind) {
        case "indexed":
          return { outcome: "completed" };
        case "skipped":
          return result.outcome.reason === "record_unavailable" ||
            result.outcome.reason === "record_type_unavailable"
            ? { outcome: "retryable_failure", failureCode: "transient_dependency_unavailable" }
            : { outcome: "completed" };
        case "refused":
          return result.outcome.code === "shared_source_record"
            ? { outcome: "terminal_failure", failureCode: "authorization_denied" }
            : { outcome: "terminal_failure", failureCode: "validation_rejected" };
      }
    },
  });
