import "server-only";

import {
  applicationRootIdSchema,
  fieldIdSchema,
  organizationIdSchema,
  recordTypeIdSchema,
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
 * current capability is read for each grant through the recipient's own adapter
 * at decision time, never taken from the request or a cache: its non-content
 * grant mirror state plus the definition scope and readable field projection of
 * its own federated search query under that grant. Only an `active` mirror whose
 * grant identity, grant fingerprint, source, definition scope and recipient
 * application all match may be searched, so a pending, suspended, revoked or
 * expired grant, a second grant, a stale mirror or another recipient
 * application contributes nothing.
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

/** The verified recipient scope and record type this search runs under. */
export type SharedResultRecipientScope = Readonly<{
  organizationId: string;
  applicationRootId: string;
  recordTypeId: string;
}>;

/**
 * The request's own Shared result groups. The recipient scope, the requested
 * field identities and the recipient's capability are not part of it: the
 * caller supplies scope and fields from its own already validated search
 * request, and the capability is read at decision time, so a shared group can
 * never widen the fields this request matches, ranks, titles or highlights.
 */
export type SharedResultPolicyRequest = Readonly<{
  groups: readonly SharedResultGroup[];
}>;

export type SharedResultPolicyInput = SharedResultPolicyRequest &
  Readonly<{
    recipient: SharedResultRecipientScope;
    requestedFieldIds: readonly string[];
  }>;

export type SharedResultCapabilityReadRequest = Readonly<{
  organizationId: string;
  applicationRootId: string;
  grantId: string;
}>;

export type SharedResultPolicyDependencies = Readonly<{
  /**
   * The recipient's own current grant capability read, bound to this request's
   * transaction and authority. It returns `undefined` when the recipient holds
   * no mirror for the grant or it cannot be checked, which excludes the group.
   * It is called for every grant on every decision, so a suspended, revoked or
   * expired grant stops contributing on the next request.
   */
  readCurrentCapability: (
    input: SharedResultCapabilityReadRequest,
  ) => Promise<SharedRecipientCapability | undefined>;
}>;

/**
 * The source identity an admitted, unavailable or refused group keeps, so a
 * rendered result can name its source organisation and one result can never be
 * attributed to a second source or grant. An excluded group keeps none of it.
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

export const sharedResultGroupExclusionReasonCodes = [
  "capability_unavailable",
  "recipient_scope_mismatch",
  "grant_identity_mismatch",
  "source_scope_mismatch",
  "definition_scope_mismatch",
  "repeated_grant",
] as const;
export type SharedResultGroupExclusionReasonCode =
  (typeof sharedResultGroupExclusionReasonCodes)[number];

/**
 * One group's decision, in the order of the request's groups. An excluded group
 * carries no source identity and no record, so an exclusion never confirms
 * which source or grant was asked, and one source cannot fail, dilute or delay
 * the recipient's own results. An unavailable source stays visibly unavailable
 * instead of becoming an empty or stale local answer. An admitted group carries
 * only its admitted projections: a record with no permitted field is absent, not
 * reported, so neither its identity nor a count can reveal withheld text.
 */
export type SharedResultGroupDecision =
  | Readonly<
      SharedResultGroupIdentity & {
        state: "admitted";
        projections: readonly SharedSearchableProjection[];
      }
    >
  | Readonly<{ state: "excluded"; reasonCode: SharedResultGroupExclusionReasonCode }>
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
  reasonCode: SharedResultGroupExclusionReasonCode,
): SharedResultGroupDecision => Object.freeze({ state: "excluded", reasonCode });

/**
 * Checks one group against the recipient's current capability for its grant.
 * Returns the exclusion reason, or the verified capability when the group may
 * contribute.
 */
const capabilityDecision = (
  group: SharedResultGroup,
  recipient: SharedResultRecipientScope,
  current: SharedRecipientCapability | undefined,
): SharedResultGroupExclusionReasonCode | SharedRecipientCapability => {
  const parsed = sharedRecipientCapabilitySchema.safeParse(current);
  if (!parsed.success || parsed.data.state !== "active") return "capability_unavailable";
  const capability = parsed.data;
  if (
    !sameId(capability.recipientOrganizationId, recipient.organizationId) ||
    !sameId(capability.recipientApplicationRootId, recipient.applicationRootId)
  )
    return "recipient_scope_mismatch";
  if (
    !sameId(capability.grantId, group.grantId) ||
    capability.contractFingerprint !== group.contractFingerprint
  )
    return "grant_identity_mismatch";
  if (
    !sameId(capability.sourceClusterId, group.sourceClusterId) ||
    !sameId(capability.sourceOrganizationId, group.sourceOrganizationId)
  )
    return "source_scope_mismatch";
  if (
    !sameId(capability.moduleRootId, group.moduleRootId) ||
    !sameId(capability.recordTypeId, group.recordTypeId) ||
    capability.publishedModuleRevision !== group.publishedModuleRevision ||
    !sameId(group.recordTypeId, recipient.recordTypeId)
  )
    return "definition_scope_mismatch";
  return capability;
};

/**
 * Decides which shared-source results the recipient may search, before ranking.
 *
 * A malformed request, a malformed group or a group set that is not a bounded
 * array refuses the whole decision rather than merging a partial answer: a
 * shared group must be exact, because a merged projection is shown as source
 * content. Every other refusal is per group, so one stale mirror or one
 * unreachable source never removes the recipient's own results. Two groups for
 * the same grant are both excluded, because either could be a partial answer. A
 * group is admitted only under the one active grant it names, its records are
 * admitted only for requested, grant-readable, source-approved fields, and a
 * record with no such field is left out so that no count, filter or rank can
 * reveal that withheld text existed.
 */
export const sharedResultGroupDecisions = async (
  input: SharedResultPolicyInput,
  dependencies: SharedResultPolicyDependencies,
): Promise<SharedResultPolicyResult> => {
  const organizationId = organizationIdSchema.safeParse(input.recipient?.organizationId);
  const applicationRootId = applicationRootIdSchema.safeParse(input.recipient?.applicationRootId);
  const recordTypeId = recordTypeIdSchema.safeParse(input.recipient?.recordTypeId);
  if (
    !organizationId.success ||
    !applicationRootId.success ||
    !recordTypeId.success ||
    !Array.isArray(input.requestedFieldIds) ||
    input.requestedFieldIds.length < 1 ||
    input.requestedFieldIds.length > sharedResultPolicyLimits.maximumRequestedFieldIds ||
    !Array.isArray(input.groups) ||
    input.groups.length > sharedResultPolicyLimits.maximumGroups
  )
    return refusal("request_invalid");
  const recipient: SharedResultRecipientScope = Object.freeze({
    organizationId: organizationId.data,
    applicationRootId: applicationRootId.data,
    recordTypeId: recordTypeId.data,
  });

  const requested = new Set<string>();
  for (const item of input.requestedFieldIds) {
    const fieldId = fieldIdSchema.safeParse(item);
    if (!fieldId.success || requested.has(lower(fieldId.data))) return refusal("request_invalid");
    requested.add(lower(fieldId.data));
  }

  const groups: SharedResultGroup[] = [];
  const groupsPerGrant = new Map<string, number>();
  for (const item of input.groups) {
    const group = sharedResultGroupSchema.safeParse(item);
    if (!group.success) return refusal("group_invalid");
    groups.push(group.data);
    const grantKey = lower(group.data.grantId);
    groupsPerGrant.set(grantKey, (groupsPerGrant.get(grantKey) ?? 0) + 1);
  }

  const decisions: SharedResultGroupDecision[] = [];
  for (const group of groups) {
    // One search asks each grant once. A repeated grant is never resolved by
    // order, so neither copy can double a count or a rank.
    if ((groupsPerGrant.get(lower(group.grantId)) ?? 0) > 1) {
      decisions.push(groupExcluded("repeated_grant"));
      continue;
    }
    const current = await dependencies.readCurrentCapability({
      organizationId: recipient.organizationId,
      applicationRootId: recipient.applicationRootId,
      grantId: group.grantId,
    });
    const capability = capabilityDecision(group, recipient, current);
    if (typeof capability === "string") {
      decisions.push(groupExcluded(capability));
      continue;
    }

    const identity = identityOf(group);
    if (group.state === "unavailable" || group.state === "retryable") {
      decisions.push(
        Object.freeze({ ...identity, state: "unavailable", safeErrorCode: group.safeErrorCode }),
      );
      continue;
    }
    if (group.state === "refused") {
      decisions.push(
        Object.freeze({ ...identity, state: "refused", safeErrorCode: group.safeErrorCode }),
      );
      continue;
    }

    const readable = new Set(capability.readableFieldIds.map(lower));
    const priorityByField = new Map(
      group.fieldProjection.map((field) => [lower(field.fieldId), field.searchPriority]),
    );
    const projections: SharedSearchableProjection[] = [];
    for (const record of group.records) {
      const entries: SearchDocumentEntry[] = [];
      let remaining: number = searchDocumentLimits.documentTextLength;
      for (const entry of record.entries) {
        const fieldId = lower(entry.fieldId);
        if (!requested.has(fieldId) || !readable.has(fieldId)) continue;
        const priority = priorityByField.get(fieldId);
        if (priority === undefined || entry.text.length > remaining) continue;
        remaining -= entry.text.length;
        // The ranking weight is derived here from the published priority; no
        // source-supplied number ever reaches ranking.
        entries.push(
          Object.freeze({
            fieldId: entry.fieldId,
            priority,
            weight: searchPriorityWeights[priority],
            text: entry.text,
          }),
        );
      }
      // A record with no permitted field must not appear at all, or a count or
      // filter would reveal that only withheld source text could have matched.
      if (entries.length === 0) continue;
      projections.push(
        Object.freeze({
          sourceClusterId: record.sourceClusterId,
          sourceOrganizationId: record.sourceOrganizationId,
          recordTypeId: record.recordTypeId,
          recordId: record.recordId,
          concurrencyNumber: record.concurrencyNumber,
          entries: Object.freeze(entries),
        }),
      );
    }
    decisions.push(
      Object.freeze({ ...identity, state: "admitted", projections: Object.freeze(projections) }),
    );
  }

  return Object.freeze({ outcome: "completed", groups: Object.freeze(decisions) });
};
