import "server-only";

import {
  applicationRootIdSchema,
  fieldIdSchema,
  organizationIdSchema,
  sharedRecipientCapabilitySchema,
  sharedResultGroupSchema,
  type SharedRecipientCapability,
  type SharedResultGroup,
  type SharedResultSourceRefusalCode,
} from "@vortex/contracts";
import {
  searchDocumentLimits,
  searchPriorityWeights,
  type SearchDocumentEntry,
} from "./document-store";

/**
 * Shared-result capability boundary (#646).
 *
 * The organisation search index built by #643 holds recipient-owned content
 * only, so a shared source can never be found there. Application search may
 * still show a Shared result group: the source executes that search itself and
 * returns its own approved projection, and this module decides, before any
 * ranking, which of those projected results the recipient may search now.
 *
 * The decision takes two independent inputs and never derives authority from
 * either one alone. The source-owned sharing evidence is one complete shared
 * result group: one grant, one source cluster, one source organisation, one
 * Module revision, one record type, and the exact fields the source approved for
 * shared search together with the search words it chose. The recipient's
 * current capability is its own non-content grant mirror state plus that grant's
 * readable field projection. Only an `active` mirror whose grant identity, grant
 * fingerprint, source and recipient application all match may be searched, so a
 * pending, suspended, revoked or expired grant, a second grant, a stale mirror
 * or another recipient application contributes nothing.
 *
 * Search words are admitted per field and never per grant: a field must be
 * approved by the source's own searchable projection, readable under the one
 * complete grant, and named by the current request. A field the source did not
 * approve has no words in the group at all, so a secret, hidden or
 * non-searchable value cannot be searched, counted or highlighted here, and a
 * recipient-copied shared-source value is refused by the #643 builder and has
 * no representation in this decision.
 *
 * The output is request-only. An admitted projection carries source identities
 * and search entries, never a stored document identity, so it is not a
 * `SearchDocument` and `searchDocumentStoreCommand` cannot accept it: nothing
 * here can be written into a recipient index, a cache or recipient storage. The
 * caller ranks, counts, filters and pages over the returned projections within
 * the current response only, shows the plain source-organisation marker, and
 * opens a result through a separate current read at the source. Remote
 * execution of the source search is #739 and the signed gateway is #738; this
 * module performs no remote call and trusts no input it has not rechecked.
 */

const lower = (value: string): string => value.toLowerCase();
const sameId = (left: string, right: string): boolean => lower(left) === lower(right);

/** Bounded work per request; a larger request is refused rather than silently truncated. */
export const sharedResultPolicyLimits = Object.freeze({
  maximumGroups: 50,
  maximumRequestedFieldIds: 200,
});

/** The verified recipient scope this search runs under. */
export type SharedResultRecipientScope = Readonly<{
  organizationId: string;
  applicationRootId: string;
}>;

/**
 * The recipient-owned half of the decision. The requested field identities are
 * not part of it: the caller supplies them from its own already validated
 * search request, so a shared group can never widen the fields this request
 * matches, ranks, titles or highlights.
 */
export type SharedResultPolicyRequest = Readonly<{
  recipient: SharedResultRecipientScope;
  capability: SharedRecipientCapability;
  groups: readonly SharedResultGroup[];
}>;

export type SharedResultPolicyInput = SharedResultPolicyRequest &
  Readonly<{ requestedFieldIds: readonly string[] }>;

/**
 * The source identity every decision keeps, so a rendered result can name its
 * source organisation and one result can never be attributed to a second
 * source or grant.
 */
export type SharedResultGroupIdentity = Readonly<{
  grantId: string;
  sourceClusterId: string;
  sourceOrganizationId: string;
  recordTypeId: string;
}>;

/**
 * One source record's request-only searchable projection. It deliberately has no
 * `kind`, schema version, index organisation or content fingerprint, so it is
 * not a storable search document and never becomes recipient-owned content.
 */
export type SharedSearchableProjection = Readonly<{
  sourceClusterId: string;
  sourceOrganizationId: string;
  recordTypeId: string;
  recordId: string;
  concurrencyNumber: number;
  /** Requested, grant-readable, source-approved entries only; a withheld field is absent. */
  entries: readonly SearchDocumentEntry[];
}>;

export const sharedResultRecordExclusionReasonCodes = [
  "no_permitted_field",
  "repeated_record",
] as const;
export type SharedResultRecordExclusionReasonCode =
  (typeof sharedResultRecordExclusionReasonCodes)[number];

export const sharedResultGroupExclusionReasonCodes = [
  "capability_unavailable",
  "recipient_scope_mismatch",
  "grant_identity_mismatch",
  "source_scope_mismatch",
  "repeated_source_grant",
] as const;
export type SharedResultGroupExclusionReasonCode =
  (typeof sharedResultGroupExclusionReasonCodes)[number];

export type SharedResultRecordDecision =
  | Readonly<{ outcome: "admitted"; projection: SharedSearchableProjection }>
  | Readonly<{
      outcome: "excluded";
      recordId: string;
      reasonCode: SharedResultRecordExclusionReasonCode;
    }>;

/**
 * One group's decision. An excluded or unavailable group carries no record, so
 * one source cannot fail, dilute or delay the recipient's own results, and an
 * unavailable source stays visibly unavailable instead of becoming an empty or
 * stale local answer.
 */
export type SharedResultGroupDecision =
  | Readonly<
      SharedResultGroupIdentity & {
        state: "admitted";
        results: readonly SharedResultRecordDecision[];
      }
    >
  | Readonly<
      SharedResultGroupIdentity & {
        state: "excluded";
        reasonCode: SharedResultGroupExclusionReasonCode;
      }
    >
  | Readonly<
      SharedResultGroupIdentity & {
        state: "unavailable";
        safeErrorCode: "source_unavailable" | "retry_later";
      }
    >
  | Readonly<
      SharedResultGroupIdentity & {
        state: "refused";
        safeErrorCode: SharedResultSourceRefusalCode;
      }
    >;

export const sharedResultRefusalReasonCodes = ["request_invalid", "group_invalid"] as const;
export type SharedResultRefusalReasonCode = (typeof sharedResultRefusalReasonCodes)[number];

export type SharedResultPolicyResult =
  | Readonly<{ outcome: "completed"; groups: readonly SharedResultGroupDecision[] }>
  | Readonly<{ outcome: "refused"; reasonCode: SharedResultRefusalReasonCode }>;

const refusal = (reasonCode: SharedResultRefusalReasonCode): SharedResultPolicyResult =>
  Object.freeze({ outcome: "refused", reasonCode });

const identityOf = (group: SharedResultGroup): SharedResultGroupIdentity =>
  Object.freeze({
    grantId: group.grantId,
    sourceClusterId: group.sourceClusterId,
    sourceOrganizationId: group.sourceOrganizationId,
    recordTypeId: group.recordTypeId,
  });

const groupExcluded = (
  identity: SharedResultGroupIdentity,
  reasonCode: SharedResultGroupExclusionReasonCode,
): SharedResultGroupDecision => Object.freeze({ ...identity, state: "excluded", reasonCode });

const groupAdmitted = (
  identity: SharedResultGroupIdentity,
  results: readonly SharedResultRecordDecision[],
): SharedResultGroupDecision =>
  Object.freeze({ ...identity, state: "admitted", results: Object.freeze(results) });

const groupUnavailable = (
  identity: SharedResultGroupIdentity,
  safeErrorCode: "source_unavailable" | "retry_later",
): SharedResultGroupDecision => Object.freeze({ ...identity, state: "unavailable", safeErrorCode });

const groupRefused = (
  identity: SharedResultGroupIdentity,
  safeErrorCode: SharedResultSourceRefusalCode,
): SharedResultGroupDecision => Object.freeze({ ...identity, state: "refused", safeErrorCode });

const recordAdmitted = (projection: SharedSearchableProjection): SharedResultRecordDecision =>
  Object.freeze({ outcome: "admitted", projection });

const recordExcluded = (
  recordId: string,
  reasonCode: SharedResultRecordExclusionReasonCode,
): SharedResultRecordDecision => Object.freeze({ outcome: "excluded", recordId, reasonCode });

/**
 * Decides which shared-source results the recipient may search, before ranking.
 *
 * A malformed request, a malformed group or a group set that is not a bounded
 * array refuses the whole decision rather than merging a partial answer: a
 * shared group must be exact, because a merged projection is shown as source
 * content. Every other refusal is per group or per record, so one stale mirror
 * or one unreachable source never removes the recipient's own results. A group
 * is admitted only under one active grant, its records are admitted only for
 * requested, grant-readable, source-approved fields, and a record with no such
 * field is excluded so that no count, filter or rank can reveal that withheld
 * text existed.
 */
export const sharedResultGroupDecisions = (
  input: SharedResultPolicyInput,
): SharedResultPolicyResult => {
  const organizationId = organizationIdSchema.safeParse(input.recipient?.organizationId);
  const applicationRootId = applicationRootIdSchema.safeParse(input.recipient?.applicationRootId);
  if (
    !organizationId.success ||
    !applicationRootId.success ||
    !Array.isArray(input.requestedFieldIds) ||
    input.requestedFieldIds.length < 1 ||
    input.requestedFieldIds.length > sharedResultPolicyLimits.maximumRequestedFieldIds ||
    !Array.isArray(input.groups) ||
    input.groups.length > sharedResultPolicyLimits.maximumGroups
  )
    return refusal("request_invalid");
  const recipient = Object.freeze({
    organizationId: organizationId.data,
    applicationRootId: applicationRootId.data,
  });

  const requested = new Set<string>();
  for (const item of input.requestedFieldIds) {
    const fieldId = fieldIdSchema.safeParse(item);
    if (!fieldId.success || requested.has(lower(fieldId.data))) return refusal("request_invalid");
    requested.add(lower(fieldId.data));
  }

  const groups: SharedResultGroup[] = [];
  for (const item of input.groups) {
    const group = sharedResultGroupSchema.safeParse(item);
    if (!group.success) return refusal("group_invalid");
    groups.push(group.data);
  }

  const capability = sharedRecipientCapabilitySchema.safeParse(input.capability);
  const active = capability.success && capability.data.state === "active" ? capability.data : null;
  const decisions: SharedResultGroupDecision[] = [];
  const seenSourceGrants = new Set<string>();

  for (const group of groups) {
    const identity = identityOf(group);
    if (active === null) {
      decisions.push(groupExcluded(identity, "capability_unavailable"));
      continue;
    }
    if (
      !sameId(active.recipientOrganizationId, recipient.organizationId) ||
      !sameId(active.recipientApplicationRootId, recipient.applicationRootId)
    ) {
      decisions.push(groupExcluded(identity, "recipient_scope_mismatch"));
      continue;
    }
    if (
      !sameId(active.grantId, group.grantId) ||
      active.contractFingerprint !== group.contractFingerprint
    ) {
      decisions.push(groupExcluded(identity, "grant_identity_mismatch"));
      continue;
    }
    if (
      !sameId(active.sourceClusterId, group.sourceClusterId) ||
      !sameId(active.sourceOrganizationId, group.sourceOrganizationId)
    ) {
      decisions.push(groupExcluded(identity, "source_scope_mismatch"));
      continue;
    }
    // One search may ask a bounded set of grants, but it never asks one source
    // under one grant twice, so a second group cannot double a count or a rank.
    const sourceGrant = [group.sourceClusterId, group.sourceOrganizationId, group.grantId]
      .map(lower)
      .join(":");
    if (seenSourceGrants.has(sourceGrant)) {
      decisions.push(groupExcluded(identity, "repeated_source_grant"));
      continue;
    }
    seenSourceGrants.add(sourceGrant);

    if (group.state === "unavailable" || group.state === "retryable") {
      decisions.push(groupUnavailable(identity, group.safeErrorCode));
      continue;
    }
    if (group.state === "refused") {
      decisions.push(groupRefused(identity, group.safeErrorCode));
      continue;
    }

    const readable = new Set(active.readableFieldIds.map(lower));
    const priorityByField = new Map(
      group.fieldProjection.map((field) => [lower(field.fieldId), field.searchPriority]),
    );
    const results: SharedResultRecordDecision[] = [];
    const seenRecords = new Set<string>();
    for (const record of group.records) {
      if (seenRecords.has(lower(record.recordId))) {
        results.push(recordExcluded(record.recordId, "repeated_record"));
        continue;
      }
      seenRecords.add(lower(record.recordId));

      const entries: SearchDocumentEntry[] = [];
      let remaining = searchDocumentLimits.documentTextLength;
      for (const entry of record.entries) {
        const fieldId = lower(entry.fieldId);
        if (!requested.has(fieldId) || !readable.has(fieldId)) continue;
        const priority = priorityByField.get(fieldId);
        if (priority === undefined) continue;
        // The recipient derives the ranking weight itself; a source-supplied
        // weight is never trusted, and a source may not raise its own priority.
        const weight = searchPriorityWeights[priority];
        if (weight === undefined || remaining <= 0) continue;
        remaining -= entry.text.length;
        entries.push(Object.freeze({ fieldId: entry.fieldId, priority, weight, text: entry.text }));
      }
      // A record with no permitted field must not appear at all, or a count or
      // filter would reveal that only withheld source text could have matched.
      if (entries.length === 0) {
        results.push(recordExcluded(record.recordId, "no_permitted_field"));
        continue;
      }
      results.push(
        recordAdmitted(
          Object.freeze({
            sourceClusterId: record.sourceClusterId,
            sourceOrganizationId: record.sourceOrganizationId,
            recordTypeId: record.recordTypeId,
            recordId: record.recordId,
            concurrencyNumber: record.concurrencyNumber,
            entries: Object.freeze(entries),
          }),
        ),
      );
    }

    decisions.push(groupAdmitted(identity, results));
  }

  return Object.freeze({ outcome: "completed", groups: Object.freeze(decisions) });
};
