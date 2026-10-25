import "server-only";

import { recordTypeDefinitionSchema } from "../definition/module-contracts";
import type { EventOccurrenceEnvelope } from "../events/occurrence-contracts";
import type { DatabaseRow } from "../db/request-transaction";
import { inEventConsumerScope } from "../events/system-scope";
import type { SearchIndexOccurrenceDependencies, SearchIndexRecordType } from "./event-consumer";
import type {
  SearchDocumentStoreCommand,
  SearchDocumentStoreOutcome,
  SearchRecordSnapshot,
} from "./document-store";

/**
 * Database-backed dependencies of the search event consumer (#644).
 *
 * Indexing runs inside event dispatch, which has no human caller. Each step
 * runs under a short-lived system context for the occurrence's organisation
 * and Application: the tenant, access version and system actor come from
 * `vortex_access.resolve_event_consumer_scope`, never from the occurrence.
 * `vortex_record.read_search_snapshot` answers only to that system context, so
 * no request-bound read can reach it, and `vortex_record.put_document` writes
 * into the context organisation only.
 *
 * Event delivery is also the backfill: a consumer registered after records were
 * created has no progress, so storage offers it every earlier occurrence in
 * order, and its own progress rows are the checkpoint.
 */

/**
 * No organisation privacy policy is stored yet, so personal fields stay out of
 * the index (specification 10: personal fields are indexed only when the
 * organisation privacy policy permits it).
 */
const indexPolicy = Object.freeze({ personalDataPermitted: false });

type IndexFacts = Readonly<{
  recordType: SearchIndexRecordType;
  snapshot: SearchRecordSnapshot | undefined;
}>;

const objectOf = (value: unknown, what: string): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`SEARCH_INDEX_${what}_INVALID`);
  return value as Readonly<Record<string, unknown>>;
};

const readFacts = async (occurrence: EventOccurrenceEnvelope): Promise<IndexFacts | undefined> =>
  inEventConsumerScope(
    occurrence.organizationId,
    occurrence.installation.applicationRootId,
    async (transaction) => {
      const rows = await transaction.query<DatabaseRow>`
        select vortex_record.read_search_snapshot(
          ${occurrence.descriptor.recordTypeId}::uuid, ${occurrence.recordId}::uuid
        ) as snapshot
      `;
      const result = objectOf(rows[0]?.snapshot, "SNAPSHOT");
      if (result.outcome === "record_type_unavailable") return undefined;
      if (result.outcome !== "loaded" && result.outcome !== "record_unavailable")
        throw new Error("SEARCH_INDEX_SNAPSHOT_INVALID");

      const recordType = recordTypeDefinitionSchema.parse(result.recordType);
      if (result.outcome === "record_unavailable") return { recordType, snapshot: undefined };
      const record = objectOf(result.record, "RECORD");
      const stored = objectOf(record.fieldValues, "FIELD_VALUES");
      const storedByName = new Map(
        Object.entries(stored).map(([key, value]) => [key.toLowerCase(), value]),
      );
      const fieldValues = Object.fromEntries(
        recordType.fields.flatMap((field) =>
          storedByName.has(field.fieldId.toLowerCase())
            ? [[field.fieldId, storedByName.get(field.fieldId.toLowerCase())]]
            : [],
        ),
      );
      // An organisation-shared record has no application of its own; it stays
      // unstamped so that every application installing its type finds it.
      const applicationRootId =
        typeof record.applicationRootId === "string" ? record.applicationRootId : undefined;
      return {
        recordType,
        snapshot: {
          indexOrganisationId: occurrence.organizationId,
          ownerOrganisationId: String(record.ownerOrganizationId),
          ...(applicationRootId === undefined ? {} : { applicationRootId }),
          recordTypeId: occurrence.descriptor.recordTypeId,
          recordId: occurrence.recordId,
          recordVersion: Number(record.concurrencyNumber),
          lifecycle: record.lifecycleState === "active" ? "active" : "deleted",
          fieldValues,
        },
      };
    },
  );

/**
 * The consumer asks for the record type, the policy and the snapshot of one
 * occurrence in turn; they are read once, in one transaction, per occurrence.
 */
export const createSearchIndexDependencies = (): SearchIndexOccurrenceDependencies => {
  const facts = new WeakMap<EventOccurrenceEnvelope, Promise<IndexFacts | undefined>>();
  const factsFor = (occurrence: EventOccurrenceEnvelope): Promise<IndexFacts | undefined> => {
    let read = facts.get(occurrence);
    if (read === undefined) {
      read = readFacts(occurrence);
      facts.set(occurrence, read);
    }
    return read;
  };
  return Object.freeze({
    loadRecordType: async (occurrence) => (await factsFor(occurrence))?.recordType,
    loadPolicy: async () => indexPolicy,
    loadRecordSnapshot: async (occurrence) => (await factsFor(occurrence))?.snapshot,
    storeDocument: async (command: SearchDocumentStoreCommand, occurrence) => {
      const rows = await inEventConsumerScope(
        command.organizationId,
        occurrence.installation.applicationRootId,
        (transaction) =>
          transaction.query<DatabaseRow>`
            select outcome from vortex_record.put_document(
              ${command.organizationId}::uuid, ${command.recordTypeId}::uuid,
              ${command.recordId}::uuid, ${command.applicationRootId}::uuid,
              ${command.sourceRecordVersion}::bigint, ${command.deleted}::boolean,
              ${command.entriesJson}::text::jsonb, ${command.contentFingerprint}::text
            )
          `,
      );
      return String(rows[0]?.outcome) as SearchDocumentStoreOutcome;
    },
  });
};
