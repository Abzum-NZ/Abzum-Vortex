import "server-only";

import {
  eventOccurrenceEnvelopeV2Schema,
  organizationIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  sessionContextSchema,
  type EventOccurrenceEnvelopeV2,
  type RecordTypeDefinitionV3,
  type SessionContext,
} from "@vortex/contracts";
import {
  createSearchEventConsumer,
  searchEventConsumerKey,
  type SearchEventConsumerOutcome,
  type SearchEventDelivery,
  type SearchIndexRecordType,
} from "./event-consumer";
import type {
  SearchDocumentStoreCommand,
  SearchDocumentStoreOutcome,
  SearchRecordSnapshot,
} from "./document-store";

type DatabaseValue = string | number | boolean | Date | Uint8Array | null;
type DatabaseRow = Readonly<Record<string, unknown>>;

type SearchRequestTransaction = Readonly<{
  query<Row extends DatabaseRow = DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly DatabaseValue[]
  ): Promise<readonly Row[]>;
}>;

type ResolvedSearchContext<Scope> = Readonly<{
  context: SessionContext;
  channel: "system";
  scope: Scope;
}>;

export type SearchRequestTransactionRunner = <Scope, Result>(
  resolve: (transaction: SearchRequestTransaction) => Promise<ResolvedSearchContext<Scope>>,
  operation: (transaction: SearchRequestTransaction, scope: Scope) => Promise<Result>,
) => Promise<Result>;

type ResolvedSearchActorScope = Readonly<{
  systemActorId: string;
  tenantId: string;
  organizationId: string;
  applicationRootId: string;
  storageContractId: string;
  storageScope: "application_contained";
  sequenceApplicationRootId: string;
  accessVersion: number;
  observedAt: string;
  leaseExpiresAt: string;
  occurrence: EventOccurrenceEnvelopeV2;
}>;

type InstalledSearchSource = Readonly<{
  recordType: SearchIndexRecordType;
  snapshot: SearchRecordSnapshot;
}>;

type SearchSourceRow = DatabaseRow & { readonly result: unknown };

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const exactRecord = <Key extends string>(
  value: unknown,
  keys: readonly Key[],
): Readonly<Record<Key, unknown>> | undefined => {
  const candidate = record(value);
  if (
    candidate === undefined ||
    Object.keys(candidate).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(candidate, key))
  )
    return undefined;
  return candidate as Readonly<Record<Key, unknown>>;
};

const nonNilUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";

const positiveSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

const timestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

const parseActorScope = (candidate: unknown): ResolvedSearchActorScope => {
  const value = exactRecord(candidate, [
    "systemActorId",
    "tenantId",
    "organizationId",
    "applicationRootId",
    "storageContractId",
    "storageScope",
    "sequenceApplicationRootId",
    "accessVersion",
    "occurrence",
    "observedAt",
    "leaseExpiresAt",
  ]);
  const occurrence = eventOccurrenceEnvelopeV2Schema.safeParse(value?.occurrence);
  const organizationId = organizationIdSchema.safeParse(value?.organizationId);
  if (
    value === undefined ||
    !nonNilUuid(value.systemActorId) ||
    !nonNilUuid(value.tenantId) ||
    !organizationId.success ||
    !nonNilUuid(value.applicationRootId) ||
    !nonNilUuid(value.storageContractId) ||
    value.storageScope !== "application_contained" ||
    value.sequenceApplicationRootId !== value.applicationRootId ||
    !positiveSafeInteger(value.accessVersion) ||
    !timestamp(value.observedAt) ||
    !timestamp(value.leaseExpiresAt) ||
    Date.parse(value.leaseExpiresAt) <= Date.parse(value.observedAt) ||
    !occurrence.success ||
    occurrence.data.installation.applicationRootId !== value.applicationRootId ||
    occurrence.data.organizationId !== organizationId.data
  )
    throw new Error("SEARCH_REQUEST_AUTHORITY_UNAVAILABLE");
  return Object.freeze({
    systemActorId: value.systemActorId,
    tenantId: value.tenantId,
    organizationId: organizationId.data,
    applicationRootId: value.applicationRootId,
    storageContractId: value.storageContractId,
    storageScope: "application_contained",
    sequenceApplicationRootId: value.sequenceApplicationRootId,
    accessVersion: value.accessVersion,
    occurrence: occurrence.data,
    observedAt: value.observedAt,
    leaseExpiresAt: value.leaseExpiresAt,
  });
};

const parseInstalledSource = (
  candidate: unknown,
  occurrence: EventOccurrenceEnvelopeV2,
): InstalledSearchSource => {
  const value = exactRecord(candidate, ["occurrence", "recordType", "snapshot"]);
  const retained = eventOccurrenceEnvelopeV2Schema.safeParse(value?.occurrence);
  const recordTypeCandidate = exactRecord(value?.recordType, ["recordTypeId", "fields"]);
  const recordTypeId = recordTypeIdSchema.safeParse(recordTypeCandidate?.recordTypeId);
  const recordTypeFields = recordTypeCandidate?.fields;
  const snapshotValue = exactRecord(value?.snapshot, [
    "indexOrganisationId",
    "ownerOrganisationId",
    "applicationRootId",
    "recordTypeId",
    "recordId",
    "recordVersion",
    "lifecycle",
    "fieldValues",
  ]);
  const fieldValues = record(snapshotValue?.fieldValues);
  const indexOrganisationId = organizationIdSchema.safeParse(snapshotValue?.indexOrganisationId);
  const ownerOrganisationId = organizationIdSchema.safeParse(snapshotValue?.ownerOrganisationId);
  const snapshotRecordTypeId = recordTypeIdSchema.safeParse(snapshotValue?.recordTypeId);
  const snapshotRecordId = recordIdSchema.safeParse(snapshotValue?.recordId);
  if (
    value === undefined ||
    !retained.success ||
    recordTypeCandidate === undefined ||
    !recordTypeId.success ||
    !Array.isArray(recordTypeFields) ||
    snapshotValue === undefined ||
    fieldValues === undefined ||
    !indexOrganisationId.success ||
    !ownerOrganisationId.success ||
    !nonNilUuid(snapshotValue.applicationRootId) ||
    !snapshotRecordTypeId.success ||
    !snapshotRecordId.success ||
    !positiveSafeInteger(snapshotValue.recordVersion) ||
    (snapshotValue.lifecycle !== "active" && snapshotValue.lifecycle !== "deleted") ||
    retained.data.occurrenceId !== occurrence.occurrenceId ||
    retained.data.organizationId !== occurrence.organizationId ||
    retained.data.recordId !== occurrence.recordId ||
    retained.data.descriptor.recordTypeId !== occurrence.descriptor.recordTypeId ||
    recordTypeId.data !== occurrence.descriptor.recordTypeId ||
    indexOrganisationId.data !== occurrence.organizationId ||
    ownerOrganisationId.data !== occurrence.organizationId ||
    snapshotValue.applicationRootId !== occurrence.installation.applicationRootId ||
    snapshotRecordTypeId.data !== occurrence.descriptor.recordTypeId ||
    snapshotRecordId.data !== occurrence.recordId
  )
    throw new Error("SEARCH_SOURCE_UNAVAILABLE");

  const snapshot: SearchRecordSnapshot = Object.freeze({
    indexOrganisationId: indexOrganisationId.data,
    ownerOrganisationId: ownerOrganisationId.data,
    applicationRootId: snapshotValue.applicationRootId,
    recordTypeId: snapshotRecordTypeId.data,
    recordId: snapshotRecordId.data,
    recordVersion: snapshotValue.recordVersion,
    lifecycle: snapshotValue.lifecycle,
    fieldValues,
  });
  return Object.freeze({
    recordType: {
      recordTypeId: recordTypeId.data,
      fields: recordTypeFields as RecordTypeDefinitionV3["fields"],
    },
    snapshot,
  });
};

const sourceFor = async (
  transaction: SearchRequestTransaction,
  occurrence: EventOccurrenceEnvelopeV2,
  claimCursor: string,
): Promise<InstalledSearchSource> => {
  const rows = await transaction.query<SearchSourceRow>`
    select vortex_module.read_search_index_source(
      ${occurrence.occurrenceId}::uuid,
      ${claimCursor}::uuid
    ) as result
  `;
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error("SEARCH_SOURCE_UNAVAILABLE");
  return parseInstalledSource(rows[0].result, occurrence);
};

const parseStoreOutcome = (candidate: unknown): SearchDocumentStoreOutcome => {
  const value = exactRecord(candidate, ["outcome"]);
  if (
    value?.outcome === "stored" ||
    value?.outcome === "replaced" ||
    value?.outcome === "rebuilt" ||
    value?.outcome === "replayed" ||
    value?.outcome === "ignored_older" ||
    value?.outcome === "ignored_deleted"
  )
    return value.outcome;
  throw new Error("SEARCH_STORE_UNAVAILABLE");
};

const storeDocument = async (
  transaction: SearchRequestTransaction,
  occurrence: EventOccurrenceEnvelopeV2,
  claimCursor: string,
  command: SearchDocumentStoreCommand,
): Promise<SearchDocumentStoreOutcome> => {
  const rows = await transaction.query<SearchSourceRow>`
    select vortex_search.store_claimed_search_document(
      ${occurrence.occurrenceId}::uuid,
      ${claimCursor}::uuid,
      ${command.organizationId}::uuid,
      ${command.recordTypeId}::uuid,
      ${command.recordId}::uuid,
      ${command.applicationRootId}::uuid,
      ${command.sourceRecordVersion}::bigint,
      ${command.deleted}::boolean,
      ${command.entriesJson}::jsonb,
      ${command.contentFingerprint}::text
    ) as result
  `;
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error("SEARCH_STORE_UNAVAILABLE");
  return parseStoreOutcome(rows[0].result);
};

/** Composes the existing pure Search event consumer with its fixed installed SYSTEM source. */
export const createInstalledSearchEventConsumer = (dependencies: Readonly<{
  resolvedRequestTransaction: SearchRequestTransactionRunner;
}>) =>
  Object.freeze({
    consumerKey: searchEventConsumerKey,
    policy: Object.freeze({ leaseSeconds: 120, maxAttempts: 5, retryBackoffSeconds: 30 }),
    async deliver(delivery: SearchEventDelivery & Readonly<{ claimCursor?: string }>): Promise<SearchEventConsumerOutcome> {
      const occurrence = eventOccurrenceEnvelopeV2Schema.safeParse(delivery.occurrence);
      if (!occurrence.success || !nonNilUuid(delivery.claimCursor))
        return { outcome: "terminal_failure", failureCode: "validation_rejected" };
      const claimCursor = delivery.claimCursor;

      try {
        return await dependencies.resolvedRequestTransaction(
          async (transaction) => {
            const rows = await transaction.query<SearchSourceRow>`
              select vortex_access.resolve_search_index_actor_scope(
                ${occurrence.data.occurrenceId}::uuid,
                ${claimCursor}::uuid
              ) as result
            `;
            if (rows.length !== 1 || rows[0] === undefined)
              throw new Error("SEARCH_REQUEST_AUTHORITY_UNAVAILABLE");
            const scope = parseActorScope(rows[0].result);
            if (
              scope.occurrence.occurrenceId !== occurrence.data.occurrenceId ||
              scope.occurrence.organizationId !== occurrence.data.organizationId ||
              scope.occurrence.recordId !== occurrence.data.recordId ||
              scope.occurrence.descriptor.recordTypeId !== occurrence.data.descriptor.recordTypeId
            )
              throw new Error("SEARCH_REQUEST_AUTHORITY_UNAVAILABLE");
            const context = sessionContextSchema.parse({
              callerKind: "system",
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              applicationRootId: scope.applicationRootId,
              systemActorId: scope.systemActorId,
              sessionId: scope.occurrence.occurrenceId,
              authenticationStrength: "service",
              issuedAt: scope.observedAt,
              expiresAt: scope.leaseExpiresAt,
              accessVersion: scope.accessVersion,
              correlationId: scope.occurrence.correlationId,
            });
            return { context, channel: "system" as const, scope };
          },
          async (transaction, scope) => {
            let source: Promise<InstalledSearchSource> | undefined;
            const loadSource = (): Promise<InstalledSearchSource> => {
              source ??= sourceFor(transaction, scope.occurrence, claimCursor);
              return source;
            };
            const consumer = createSearchEventConsumer({
              loadRecordType: async (candidate) => {
                if (candidate.occurrenceId !== scope.occurrence.occurrenceId)
                  throw new Error("SEARCH_SOURCE_UNAVAILABLE");
                return (await loadSource()).recordType as SearchIndexRecordType &
                  Pick<RecordTypeDefinitionV3, "recordTypeId" | "fields">;
              },
              loadPolicy: async () => ({ personalDataPermitted: false }),
              loadRecordSnapshot: async (candidate) => {
                if (candidate.occurrenceId !== scope.occurrence.occurrenceId)
                  throw new Error("SEARCH_SOURCE_UNAVAILABLE");
                return (await loadSource()).snapshot;
              },
              storeDocument: (command) =>
                storeDocument(transaction, scope.occurrence, claimCursor, command),
            });
            return consumer.deliver({
              occurrence: scope.occurrence,
              renewLease: delivery.renewLease,
            });
          },
        );
      } catch (error) {
        let code: unknown;
        try {
          code = error instanceof Error
            ? Object.getOwnPropertyDescriptor(error, "code")?.value
            : undefined;
        } catch {
          code = undefined;
        }
        if (code === "42501")
          return { outcome: "terminal_failure", failureCode: "authorization_denied" };
        if (code === "22023" || code === "23514")
          return { outcome: "terminal_failure", failureCode: "validation_rejected" };
        return { outcome: "retryable_failure", failureCode: "transient_dependency_unavailable" };
      }
    },
  });
