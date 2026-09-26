import "server-only";

import {
  applicationRootIdSchema,
  fieldIdSchema,
  fingerprintSchema,
  organizationIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  searchPrioritySchema,
  selectedOrganizationScopeSchema,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import {
  searchDocumentLimits,
  searchDocumentSchemaVersion,
  type SearchDocument,
  type SearchDocumentEntry,
} from "./document-store";
import {
  sharedResultGroupDecisions,
  type SharedResultGroupDecision,
  type SharedResultPolicyRequest,
  type SharedResultPolicyResult,
} from "./shared-result-policy";

/**
 * Current-access filtering for search candidates (#645).
 *
 * The organisation search index is built once from searchable fields (#643) and
 * refreshed by committed events (#644). It carries no access decision, so it can
 * be stale the moment authority changes. This module turns one current Access
 * context, one search request and one bounded candidate document set into the
 * candidates a reader may actually see now, and it does so before any ranking,
 * counting, filtering or paging boundary. The caller runs that later work over
 * this filtered set, so a hidden record or field can never lift a rank, a count,
 * a filter match or a page slot.
 *
 * Every candidate is rechecked against the same fixed current read adapter the
 * ordinary record read uses, through the injected `readCurrentRecord`
 * dependency. Only field identities cross that boundary: the returned readable
 * set is the adapter's derived field projection, which already requires every
 * recursive calculation input, and every total input, to be readable before a
 * derived field is admitted. The index text of a field that is not readable now
 * is dropped, so titles, highlights, counts and filters stay inside the current
 * projection. The caller must evaluate query matching, ranking, highlights,
 * counts, filters and paging only over the returned entries, never over the
 * original index document, so a match on a withheld field cannot surface.
 * Opening a result is a separate ordinary current read by the caller; this
 * module never returns authoritative stored values.
 *
 * A shared source is not in the index at all, so its results arrive as the
 * request's own Shared result groups and are decided by #646 in the same
 * pre-ranking step. Those decisions are returned beside the local candidates:
 * they are request-only projections carrying their own source identities, they
 * are never documents, and the caller ranks and pages over both sets for the
 * current response only. A group set that is not exact refuses the request;
 * every other shared refusal is per group or per record, so an inactive mirror
 * or an unreachable source never removes the recipient's own results.
 */

/** Bounded work per request; a larger candidate set is refused rather than silently truncated. */
export const permittedSearchLimits = Object.freeze({
  maximumCandidates: 1_000,
  maximumRequestedFieldIds: 200,
  maximumReadableFieldIds: 1_000,
});

const lower = (value: string): string => value.toLowerCase();
const sameId = (left: string, right: string): boolean => lower(left) === lower(right);

type UnknownRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: UnknownRecord, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const isJavaScriptSafeRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/**
 * The verified current request scope. Search reuses the ordinary selected
 * organisation scope, so the organisation, account, Application and Access
 * version are the caller's own current evidence rather than search input.
 */
export type PermittedSearchAccessContext = SelectedOrganizationScope;

/**
 * One resolved search request. It names the Application and record type being
 * searched and the exact fields the caller will match, rank, title or
 * highlight. A field the caller did not request never reaches it, even when the
 * reader may read it on the record.
 */
export type PermittedSearchRequest = Readonly<{
  applicationRootId: string;
  recordTypeId: string;
  requestedFieldIds: readonly string[];
}>;

/**
 * The current read projection of one record, exactly as the fixed read adapter
 * reports it: `allowed` carries the record's current concurrency number and the
 * field identities that are readable now, and `refused` is the identical
 * refusal a missing, foreign or unreachable record produces. The dependency
 * must not widen this projection.
 */
export type PermittedSearchCurrentRead =
  | Readonly<{
      outcome: "allowed";
      concurrencyNumber: number;
      readableFieldIds: readonly string[];
    }>
  | Readonly<{ outcome: "refused" }>;

export type PermittedSearchCurrentReadRequest = Readonly<{
  organizationId: string;
  applicationRootId: string;
  recordTypeId: string;
  recordId: string;
}>;

export type PermittedSearchInput = Readonly<{
  access: PermittedSearchAccessContext;
  request: PermittedSearchRequest;
  candidates: readonly SearchDocument[];
  /**
   * The request's shared-source groups, when the response includes a Shared
   * result group. The requested field identities are taken from this module's
   * own parsed request, never from the caller, so a shared group cannot widen
   * the fields this search matches. Omitted when the response has no shared
   * content; running the source search itself is #739.
   */
  shared?: SharedResultPolicyRequest;
}>;

export type PermittedSearchDependencies = Readonly<{
  /**
   * The caller's own current fixed record read adapter, bound to this request's
   * transaction and authority. It returns `undefined` when the record cannot be
   * checked at all, which is treated as a refusal for that candidate.
   */
  readCurrentRecord: (
    input: PermittedSearchCurrentReadRequest,
  ) => Promise<PermittedSearchCurrentRead | undefined>;
}>;

/** One authority-filtered candidate, still before ranking, counting and paging. */
export type PermittedSearchCandidate = Readonly<{
  recordId: string;
  recordTypeId: string;
  applicationRootId: string;
  sourceRecordVersion: number;
  concurrencyNumber: number;
  /**
   * Readable, requested searchable entries only; a withheld field is absent.
   * The index content fingerprint is not carried, because it covers withheld
   * entries and could reveal a hidden value or change.
   */
  entries: readonly SearchDocumentEntry[];
}>;

export const permittedSearchRefusalReasonCodes = [
  "access_context_invalid",
  "search_request_invalid",
  "candidate_set_invalid",
  "candidate_document_invalid",
  "shared_result_invalid",
] as const;
export type PermittedSearchRefusalReasonCode = (typeof permittedSearchRefusalReasonCodes)[number];

export type PermittedSearchResult =
  | Readonly<{
      outcome: "completed";
      organizationId: string;
      applicationRootId: string;
      recordTypeId: string;
      /**
       * Deliberately carries no count of excluded candidates: that number would
       * reveal how many hidden records matched.
       */
      candidates: readonly PermittedSearchCandidate[];
      /**
       * The request's own shared-source decisions, one per group, still before
       * ranking. An admitted projection is a request-only source result, never
       * a document, and is never written into the recipient index.
       */
      sharedGroups: readonly SharedResultGroupDecision[];
    }>
  | Readonly<{ outcome: "refused"; reasonCode: PermittedSearchRefusalReasonCode }>;

const parseRequest = (value: unknown): PermittedSearchRequest | undefined => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["applicationRootId", "recordTypeId", "requestedFieldIds"])
  )
    return undefined;
  const applicationRootId = applicationRootIdSchema.safeParse(value.applicationRootId);
  const recordTypeId = recordTypeIdSchema.safeParse(value.recordTypeId);
  const requested = value.requestedFieldIds;
  if (
    !applicationRootId.success ||
    !recordTypeId.success ||
    !Array.isArray(requested) ||
    requested.length < 1 ||
    requested.length > permittedSearchLimits.maximumRequestedFieldIds
  )
    return undefined;
  const requestedFieldIds: string[] = [];
  const seen = new Set<string>();
  for (const item of requested) {
    const fieldId = fieldIdSchema.safeParse(item);
    if (!fieldId.success || seen.has(lower(fieldId.data))) return undefined;
    seen.add(lower(fieldId.data));
    requestedFieldIds.push(fieldId.data);
  }
  return Object.freeze({
    applicationRootId: applicationRootId.data,
    recordTypeId: recordTypeId.data,
    requestedFieldIds: Object.freeze(requestedFieldIds),
  });
};

const parseEntry = (value: unknown): SearchDocumentEntry | undefined => {
  if (!isRecord(value) || !hasOnlyKeys(value, ["fieldId", "priority", "weight", "text"]))
    return undefined;
  const fieldId = fieldIdSchema.safeParse(value.fieldId);
  const priority = searchPrioritySchema.safeParse(value.priority);
  const weight = value.weight;
  const text = value.text;
  if (
    !fieldId.success ||
    !priority.success ||
    typeof weight !== "number" ||
    !Number.isInteger(weight) ||
    weight <= 0 ||
    typeof text !== "string" ||
    text.length > searchDocumentLimits.entryTextLength
  )
    return undefined;
  return Object.freeze({ fieldId: fieldId.data, priority: priority.data, weight, text });
};

/**
 * The accepted candidate shape is exactly the #643 stored document. A deletion
 * marker carries no content and is not a candidate here, so it is refused as an
 * invalid document rather than silently matching nothing.
 */
const parseCandidateDocument = (value: unknown): SearchDocument | undefined => {
  if (
    !isRecord(value) ||
    value.kind !== "document" ||
    value.schemaVersion !== searchDocumentSchemaVersion ||
    !hasOnlyKeys(value, [
      "kind",
      "schemaVersion",
      "organisationId",
      "recordTypeId",
      "recordId",
      "applicationRootId",
      "sourceRecordVersion",
      "entries",
      "contentFingerprint",
    ])
  )
    return undefined;
  const organisationId = organizationIdSchema.safeParse(value.organisationId);
  const recordTypeId = recordTypeIdSchema.safeParse(value.recordTypeId);
  const recordId = recordIdSchema.safeParse(value.recordId);
  const contentFingerprint = fingerprintSchema.safeParse(value.contentFingerprint);
  const entriesValue = value.entries;
  const sourceRecordVersion = value.sourceRecordVersion;
  if (
    !organisationId.success ||
    !recordTypeId.success ||
    !recordId.success ||
    !contentFingerprint.success ||
    !isJavaScriptSafeRevision(sourceRecordVersion) ||
    !Array.isArray(entriesValue) ||
    entriesValue.length > searchDocumentLimits.entries
  )
    return undefined;

  let applicationRootId: string | undefined;
  if (value.applicationRootId !== undefined) {
    const parsedApplicationRootId = applicationRootIdSchema.safeParse(value.applicationRootId);
    if (!parsedApplicationRootId.success) return undefined;
    applicationRootId = parsedApplicationRootId.data;
  }

  const entries: SearchDocumentEntry[] = [];
  for (const item of entriesValue) {
    const entry = parseEntry(item);
    if (entry === undefined) return undefined;
    entries.push(entry);
  }
  return Object.freeze({
    kind: "document",
    schemaVersion: searchDocumentSchemaVersion,
    organisationId: organisationId.data,
    recordTypeId: recordTypeId.data,
    recordId: recordId.data,
    ...(applicationRootId === undefined ? {} : { applicationRootId }),
    sourceRecordVersion,
    entries: Object.freeze(entries),
    contentFingerprint: contentFingerprint.data,
  });
};

const parseCurrentRead = (value: unknown): PermittedSearchCurrentRead | undefined => {
  if (!isRecord(value)) return undefined;
  if (value.outcome === "refused")
    return hasOnlyKeys(value, ["outcome"]) ? Object.freeze({ outcome: "refused" }) : undefined;
  if (
    value.outcome !== "allowed" ||
    !hasOnlyKeys(value, ["outcome", "concurrencyNumber", "readableFieldIds"]) ||
    !isJavaScriptSafeRevision(value.concurrencyNumber) ||
    !Array.isArray(value.readableFieldIds) ||
    value.readableFieldIds.length > permittedSearchLimits.maximumReadableFieldIds
  )
    return undefined;
  const concurrencyNumber = value.concurrencyNumber;
  const readableFieldIds: string[] = [];
  for (const item of value.readableFieldIds) {
    const fieldId = fieldIdSchema.safeParse(item);
    if (!fieldId.success) return undefined;
    readableFieldIds.push(fieldId.data);
  }
  return Object.freeze({
    outcome: "allowed",
    concurrencyNumber,
    readableFieldIds: Object.freeze(readableFieldIds),
  });
};

const refusal = (reasonCode: PermittedSearchRefusalReasonCode): PermittedSearchResult =>
  Object.freeze({ outcome: "refused", reasonCode });

/** A request with no Shared result group has no shared decision to make. */
const noSharedGroups: SharedResultPolicyResult = Object.freeze({
  outcome: "completed",
  groups: Object.freeze([]),
});

/**
 * Filters one bounded candidate set to the records the current reader may see
 * and the exact searchable fields it may see on them.
 *
 * A candidate is excluded when it belongs to another organisation, has no
 * Application scope or another Application, targets another record type, is
 * unreadable under current access, or has no requested field still readable.
 * Access removal therefore affects the next request without any index change. A
 * malformed candidate document, or the same record twice, refuses the whole
 * request, because a set built from the index must be exact. Shared-source
 * results are decided by #646 from the request's own groups and returned as
 * `sharedGroups`; a malformed group refuses the request for the same reason,
 * while an excluded, unavailable or refused group leaves the local candidates
 * untouched.
 */
export const permittedSearchCandidates = async (
  input: PermittedSearchInput,
  dependencies: PermittedSearchDependencies,
): Promise<PermittedSearchResult> => {
  const access = selectedOrganizationScopeSchema.safeParse(input.access);
  if (!access.success || access.data.applicationRootId === undefined)
    return refusal("access_context_invalid");
  const accessApplicationRootId = access.data.applicationRootId;

  const request = parseRequest(input.request);
  if (request === undefined || !sameId(accessApplicationRootId, request.applicationRootId))
    return refusal("search_request_invalid");

  if (
    !Array.isArray(input.candidates) ||
    input.candidates.length > permittedSearchLimits.maximumCandidates
  )
    return refusal("candidate_set_invalid");

  // Shared-source content is decided by #646 in the same pre-ranking step, from
  // the source's own approved projection and the recipient's current grant
  // capability, so a shared result can never reach ranking, counting or paging
  // before the same boundary that filters the recipient's own index.
  const shared =
    input.shared === undefined
      ? noSharedGroups
      : sharedResultGroupDecisions({
          ...input.shared,
          recipient: Object.freeze({
            organizationId: access.data.organizationId,
            applicationRootId: request.applicationRootId,
          }),
          requestedFieldIds: request.requestedFieldIds,
        });
  if (shared.outcome === "refused") return refusal("shared_result_invalid");
  const sharedGroups = shared.groups;

  const requestedFieldIds = new Set(request.requestedFieldIds.map(lower));
  const candidates: PermittedSearchCandidate[] = [];
  const seenRecords = new Set<string>();

  for (const rawCandidate of input.candidates) {
    const document = parseCandidateDocument(rawCandidate);
    if (document === undefined) return refusal("candidate_document_invalid");
    const recordKey = `${lower(document.organisationId)}:${lower(document.recordId)}`;
    if (seenRecords.has(recordKey)) return refusal("candidate_set_invalid");
    seenRecords.add(recordKey);

    if (
      !sameId(document.organisationId, access.data.organizationId) ||
      document.applicationRootId === undefined ||
      !sameId(document.applicationRootId, request.applicationRootId) ||
      !sameId(document.recordTypeId, request.recordTypeId)
    )
      continue;
    const applicationRootId = document.applicationRootId;

    const currentCandidate = await dependencies.readCurrentRecord({
      organizationId: access.data.organizationId,
      applicationRootId,
      recordTypeId: request.recordTypeId,
      recordId: document.recordId,
    });
    if (currentCandidate === undefined) continue;
    const current = parseCurrentRead(currentCandidate);
    if (current === undefined || current.outcome === "refused") continue;

    const readableFieldIds = new Set(current.readableFieldIds.map(lower));
    const seen = new Set<string>();
    const entries: SearchDocumentEntry[] = [];
    for (const entry of document.entries) {
      const fieldId = lower(entry.fieldId);
      if (seen.has(fieldId) || !readableFieldIds.has(fieldId) || !requestedFieldIds.has(fieldId))
        continue;
      seen.add(fieldId);
      entries.push(entry);
    }
    // A record with no requested field readable now must not appear at all, or
    // a count or filter would reveal that only hidden text could have matched.
    if (entries.length === 0) continue;

    candidates.push(
      Object.freeze({
        recordId: document.recordId,
        recordTypeId: document.recordTypeId,
        applicationRootId,
        sourceRecordVersion: document.sourceRecordVersion,
        concurrencyNumber: current.concurrencyNumber,
        entries: Object.freeze(entries),
      }),
    );
  }

  return Object.freeze({
    outcome: "completed",
    organizationId: access.data.organizationId,
    applicationRootId: request.applicationRootId,
    recordTypeId: request.recordTypeId,
    candidates: Object.freeze(candidates),
    sharedGroups,
  });
};
