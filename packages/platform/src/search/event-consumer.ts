import "server-only";
import type { RecordTypeDefinition } from "../definition/module-contracts";
import {
  eventOccurrenceEnvelopeSchema,
  type EventOccurrenceEnvelope,
} from "../events/occurrence-contracts";
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
 * Event-driven search refresh.
 *
 * One ordered batch of committed Event occurrences from the event dispatcher
 * claim is turned into idempotent document upserts and deletion markers
 * through the search document builder and store command, or into a bounded
 * rebuild checkpoint after a search configuration or privacy-policy change.
 * Delivery always re-reads the current Record snapshot, including a
 * soft-deleted one, and indexes it under that snapshot's own concurrency
 * version. The occurrence's record sequence is an Event counter, not a Record
 * version, so it never versions a document; a stale or duplicate occurrence
 * can therefore only re-store current state, and search document storage
 * additionally ignores an older source version. Documents stay
 * content-only: entries carry field identity, and read-time permission is
 * rechecked by permitted search, which is why this consumer never records or returns an
 * access decision.
 */

/** Consumer identity registered with the event dispatcher for organisation search indexing. */
const searchEventConsumerKey = "search.documents" as const;

/**
 * The exact published record shape consumed by the search document configuration
 * derivation. A record type that has not published a search-relevant field is
 * still a valid configuration: every field is then simply left out.
 */
export type SearchIndexRecordType = Pick<RecordTypeDefinition, "recordTypeId" | "fields">;

/**
 * Server-side reads and the idempotent write the consumer needs. A loader never
 * receives a caller-chosen organisation or permission: the occurrence supplies
 * both the organisation and the record, and the store implementation must apply
 * the search document store's own version ordering rather than trusting the caller.
 *
 * `loadRecordSnapshot` returns the Record's current state in the occurrence's
 * organisation: an active record as `active`, a soft-deleted or removal-pending
 * record as `deleted`, each at its current concurrency number. It returns
 * `undefined` only when the record cannot be read at all.
 */
export type SearchIndexOccurrenceDependencies = Readonly<{
  loadRecordType: (
    occurrence: EventOccurrenceEnvelope,
  ) => Promise<SearchIndexRecordType | undefined>;
  loadPolicy: (occurrence: EventOccurrenceEnvelope) => Promise<SearchableFieldPolicy>;
  loadRecordSnapshot: (
    occurrence: EventOccurrenceEnvelope,
  ) => Promise<SearchRecordSnapshot | undefined>;
  storeDocument: (
    command: SearchDocumentStoreCommand,
    occurrence: EventOccurrenceEnvelope,
  ) => Promise<SearchDocumentStoreOutcome>;
}>;

type SearchOccurrenceSkipReason =
  | "not_indexable_event"
  | "record_type_not_searchable"
  | "record_type_unavailable"
  | "record_unavailable";

type SearchIndexOccurrenceOutcome =
  | Readonly<{ kind: "skipped"; reason: SearchOccurrenceSkipReason }>
  | Readonly<{
      kind: "indexed";
      command: SearchDocumentStoreCommand;
      storeOutcome: SearchDocumentStoreOutcome;
    }>
  | Readonly<{ kind: "refused"; code: SearchDocumentRefusalCode }>;

type SearchIndexOccurrenceResult = Readonly<{
  occurrenceId: string;
  organizationId: string;
  recordTypeId: string;
  recordId: string;
  recordSequence: number;
  outcome: SearchIndexOccurrenceOutcome;
}>;

/**
 * Delivery failure classification. Search emits the same names delivery recovery
 * accepts for its own failures rather than inventing a second vocabulary; every
 * value below is one of that closed set, so the dispatcher's
 * `failureClassificationMatches` accepts it unchanged.
 */
type SearchDeliveryFailureCode =
  | "transient_dependency_unavailable"
  | "transient_timeout"
  | "validation_rejected"
  | "authorization_denied"
  | "unclassified";

/**
 * One claimed occurrence handed to the consumer. This is structurally the event dispatcher's
 * `EventConsumerDelivery`, declared locally because a runtime service may not
 * depend on a same-tier service package.
 */
type SearchEventDelivery = Readonly<{
  occurrence: unknown;
  renewLease: () => Promise<boolean>;
}>;

type SearchEventConsumerOutcome =
  | Readonly<{ outcome: "completed" }>
  | Readonly<{ outcome: "retryable_failure"; failureCode: SearchDeliveryFailureCode }>
  | Readonly<{ outcome: "terminal_failure"; failureCode: SearchDeliveryFailureCode }>;

type SearchEventConsumer = Readonly<{
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
  "restored",
  "state_changed",
  "reassigned",
]);

const occurrenceIsIndexable = (occurrence: EventOccurrenceEnvelope): boolean =>
  indexableEventKinds.has(occurrence.payload.kind);

const occurrenceResult = (
  occurrence: EventOccurrenceEnvelope,
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
 * snapshot, derives the exact search document configuration, and stores the idempotent
 * document or deletion marker. A `deleted` occurrence is handled the same way:
 * the soft-deleted snapshot yields a content-free marker at the Record's own
 * deleting version, and a record restored since then is indexed as it now is.
 * The store command always carries the snapshot's concurrency version, so an
 * older occurrence can never seed an older document; search document storage repeats that
 * ordering check.
 */
const indexOccurrence = async (
  occurrence: EventOccurrenceEnvelope,
  dependencies: SearchIndexOccurrenceDependencies,
): Promise<SearchIndexOccurrenceResult> => {
  if (!occurrenceIsIndexable(occurrence))
    return occurrenceResult(occurrence, { kind: "skipped", reason: "not_indexable_event" });

  const recordType = await dependencies.loadRecordType(occurrence);
  if (recordType === undefined || recordType.recordTypeId !== occurrence.descriptor.recordTypeId)
    return occurrenceResult(occurrence, { kind: "skipped", reason: "record_type_unavailable" });

  const policy = await dependencies.loadPolicy(occurrence);
  const configuration = searchableFieldConfigurationFor(recordType, policy);
  if (configuration.fields.length === 0)
    return occurrenceResult(occurrence, { kind: "skipped", reason: "record_type_not_searchable" });

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
  const storeOutcome = await dependencies.storeDocument(command, occurrence);
  return occurrenceResult(occurrence, { kind: "indexed", command, storeOutcome });
};

/**
 * The event dispatcher's consumer. A deterministic refusal is terminal so
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
      const occurrence = eventOccurrenceEnvelopeSchema.safeParse(delivery.occurrence);
      if (!occurrence.success)
        return { outcome: "terminal_failure", failureCode: "validation_rejected" };

      let result: SearchIndexOccurrenceResult;
      try {
        result = await indexOccurrence(occurrence.data, dependencies);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        console.error("Search event delivery interrupted", {
          consumer: searchEventConsumerKey,
          operation: "indexOccurrence",
          cause:
            typeof code === "string" && /^[A-Z0-9]{5}$/.test(code)
              ? code
              : error instanceof TypeError
                ? "TypeError"
                : error instanceof Error
                  ? "Error"
                  : typeof error,
        });
        return { outcome: "retryable_failure", failureCode: "transient_dependency_unavailable" };
      }

      switch (result.outcome.kind) {
        case "indexed":
          return { outcome: "completed" };
        case "skipped":
          if (
            result.outcome.reason === "record_unavailable" ||
            result.outcome.reason === "record_type_unavailable"
          ) {
            console.error(
              `[search] occurrence ${result.occurrenceId} not indexed yet: ${result.outcome.reason}`,
            );
            return {
              outcome: "retryable_failure",
              failureCode: "transient_dependency_unavailable",
            };
          }
          return { outcome: "completed" };
        case "refused":
          return result.outcome.code === "shared_source_record"
            ? { outcome: "terminal_failure", failureCode: "authorization_denied" }
            : { outcome: "terminal_failure", failureCode: "validation_rejected" };
      }
    },
  });
