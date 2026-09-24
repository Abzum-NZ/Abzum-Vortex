import "server-only";

import { randomUUID } from "node:crypto";
import {
  accessGrantSchema,
  activityIdSchema,
  clusterIdSchema,
  grantConsentRequestIdSchema,
  grantConsentRequestSchema,
  grantIdSchema,
  organizationAccountIdSchema,
  roleIdSchema,
  type AccessGrant,
  type GrantConsentRequest,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { fingerprintCanonicalValue } from "@vortex/definition";
import { z } from "zod";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "./human-organization-request";

/**
 * A server-owned binding that resolves the real facts of one source record for
 * a single-record proposal, the same projection the protected direct record
 * share reads. Request data never supplies facts, so a proposal cannot claim
 * authority over a record it cannot actually reach.
 */
export interface FixedRecordShareGrantFactsAdapter {
  resolveRecordFacts(
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    target: Readonly<{ moduleRootId: string; recordTypeId: string; recordId: string }>,
  ): Promise<unknown>;
}

export type RecordShareGrantDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    /** The cluster this runtime serves; it is always the source cluster of a proposal. */
    sourceClusterId: string;
    /** Required to propose or revise a single-record grant. */
    recordFacts?: FixedRecordShareGrantFactsAdapter;
    grantId?: () => string;
    consentRequestId?: () => string;
    activityId?: () => string;
  }>;

/** One stored proposal: the exact grant, its consent request (cross-organisation only) and lifecycle facts. */
export type RecordShareGrantState = Readonly<{
  grant: AccessGrant;
  consentRequest?: GrantConsentRequest;
  proposalFingerprint: string;
  revision: number;
  changedAt: string;
}>;

const grantTermKeys = [
  "scopeKind",
  "recipientClusterId",
  "recipientOrganizationId",
  "recipientApplicationRootId",
  "moduleRootId",
  "recordTypeId",
  "recordId",
  "savedConditionId",
  "savedConditionRevision",
  "savedConditionFingerprint",
  "parameters",
  "readableFieldIds",
  "changeableFieldIds",
  "recipientRoleIds",
  "allowedActionKeys",
  "exportAllowed",
  "approvedRecipientRegion",
  "startsAt",
  "expiresAt",
  "contractVersion",
  "contractFingerprint",
  "recipientBindingId",
  "definitionMappingFingerprint",
  "sourceAuthorizingRoleIds",
  "recipientAcceptingRoleIds",
] as const;

// A grant never carries these authorities; the protected SQL refuses the same words.
const forbiddenActionWords = new Set([
  "delete",
  "restore",
  "share",
  "reshare",
  "permission",
  "permissions",
  "ownership",
  "transfer",
  "grant",
  "revoke",
  "role",
  "roles",
  "administer",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const positiveRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

const sameUuid = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const sortedLower = (values: readonly string[]): string[] =>
  values.map((value) => value.toLowerCase()).sort();

type ProposalTerms = Readonly<{
  terms: Record<string, unknown>;
  sourceAuthorizingRoleIds: readonly string[];
  recipientAcceptingRoleIds: readonly string[];
}>;

// Validation-only stand-in for the account that proposes; the stored value is
// the verified request scope's own account.
const validationAccountId = organizationAccountIdSchema.parse(
  "00000000-0000-4000-8000-000000000727",
);

/**
 * Builds and validates one proposal from request-supplied terms. Everything the
 * caller may not choose (source organisation, application, cluster, account,
 * lifecycle status, consent identity) comes from the verified scope and
 * server-issued identifiers; the contract schema then checks the whole grant.
 */
const buildProposal = (
  candidate: unknown,
  source: Readonly<{
    grantId: string;
    consentRequestId: string;
    clusterId: string;
    organizationId: string;
    applicationRootId: string;
    organizationAccountId: string;
  }>,
): { proposal: ProposalTerms; grant: AccessGrant } | undefined => {
  if (!isRecord(candidate)) return undefined;
  if (Object.keys(candidate).some((key) => !(grantTermKeys as readonly string[]).includes(key)))
    return undefined;
  const {
    sourceAuthorizingRoleIds = [],
    recipientAcceptingRoleIds = [],
    ...grantTerms
  } = candidate as Record<string, unknown> & {
    sourceAuthorizingRoleIds?: unknown;
    recipientAcceptingRoleIds?: unknown;
  };
  const consentRoles = z.array(roleIdSchema).max(100);
  const sourceRoles = consentRoles.safeParse(sourceAuthorizingRoleIds);
  const recipientRoles = consentRoles.safeParse(recipientAcceptingRoleIds);
  if (!sourceRoles.success || !recipientRoles.success) return undefined;
  if (typeof grantTerms.recipientOrganizationId !== "string") return undefined;
  const crossOrganization = !sameUuid(grantTerms.recipientOrganizationId, source.organizationId);
  // Export is off unless the proposal names it; the field is always stored explicitly.
  const exportAllowed = grantTerms.exportAllowed === undefined ? false : grantTerms.exportAllowed;
  const parsed = accessGrantSchema.safeParse({
    ...grantTerms,
    exportAllowed,
    grantId: source.grantId,
    sourceClusterId: source.clusterId,
    sourceOrganizationId: source.organizationId,
    sourceApplicationRootId: source.applicationRootId,
    createdByOrganizationAccountId: source.organizationAccountId,
    status: crossOrganization ? "pending_consent" : "draft",
    ...(crossOrganization ? { consentRequestId: source.consentRequestId } : {}),
  });
  if (!parsed.success) return undefined;
  const grant = parsed.data;
  if (
    crossOrganization
      ? sourceRoles.data.length === 0 || recipientRoles.data.length === 0
      : sourceRoles.data.length !== 0 || recipientRoles.data.length !== 0
  )
    return undefined;
  if (
    grant.allowedActionKeys.some((key) =>
      key.split(/[._]/).some((part) => forbiddenActionWords.has(part)),
    )
  )
    return undefined;
  return {
    grant,
    proposal: {
      terms: {
        ...grantTerms,
        exportAllowed,
        sourceClusterId: source.clusterId,
        ...(crossOrganization
          ? {
              sourceAuthorizingRoleIds: sourceRoles.data,
              recipientAcceptingRoleIds: recipientRoles.data,
            }
          : {}),
      },
      sourceAuthorizingRoleIds: sourceRoles.data,
      recipientAcceptingRoleIds: recipientRoles.data,
    },
  };
};

/**
 * Fingerprints exactly the proposed terms. Collections whose order carries no
 * meaning are sorted, so re-submitting the same terms reproduces the value and
 * any real change replaces it.
 */
const fingerprintProposal = (grant: AccessGrant, proposal: ProposalTerms): string => {
  const {
    status: _status,
    createdByOrganizationAccountId: _createdBy,
    consentRequestId: _consentRequestId,
    ...terms
  } = grant;
  return fingerprintCanonicalValue({
    grant: {
      ...terms,
      readableFieldIds: sortedLower(grant.readableFieldIds),
      changeableFieldIds: sortedLower(grant.changeableFieldIds),
      recipientRoleIds: sortedLower(grant.recipientRoleIds),
      allowedActionKeys: [...grant.allowedActionKeys].sort(),
    },
    sourceAuthorizingRoleIds: sortedLower(proposal.sourceAuthorizingRoleIds),
    recipientAcceptingRoleIds: sortedLower(proposal.recipientAcceptingRoleIds),
  });
};

type ResultRow = DatabaseRow & { result: unknown };

const parseState = (rows: readonly ResultRow[]): RecordShareGrantState => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("INVALID_GRANT_RESULT");
  const raw: unknown = typeof rows[0].result === "string" ? JSON.parse(rows[0].result) : rows[0].result;
  if (!isRecord(raw)) throw new Error("INVALID_GRANT_RESULT");
  const grant = accessGrantSchema.parse(raw.grant);
  const consentRequest =
    raw.consentRequest === null || raw.consentRequest === undefined
      ? undefined
      : grantConsentRequestSchema.parse(raw.consentRequest);
  const revision = typeof raw.revision === "string" ? Number(raw.revision) : raw.revision;
  if (
    typeof raw.proposalFingerprint !== "string" ||
    typeof raw.changedAt !== "string" ||
    !positiveRevision(revision) ||
    (grant.consentRequestId === undefined) !== (consentRequest === undefined) ||
    (consentRequest !== undefined &&
      (consentRequest.requestId !== grant.consentRequestId ||
        consentRequest.proposedGrantFingerprint !== raw.proposalFingerprint ||
        consentRequest.sourceOrganizationId !== grant.sourceOrganizationId ||
        consentRequest.recipientOrganizationId !== grant.recipientOrganizationId))
  )
    throw new Error("INVALID_GRANT_RESULT");
  return {
    grant,
    ...(consentRequest === undefined ? {} : { consentRequest }),
    proposalFingerprint: raw.proposalFingerprint,
    revision,
    changedAt: raw.changedAt,
  };
};

export const createRecordShareGrantService = (dependencies: RecordShareGrantDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const sourceClusterId = clusterIdSchema.parse(dependencies.sourceClusterId);
  const newGrantId = dependencies.grantId ?? randomUUID;
  const newConsentRequestId = dependencies.consentRequestId ?? randomUUID;
  const newActivityId = dependencies.activityId ?? randomUUID;

  const identifiers = ():
    | Readonly<{ grantId: string; consentRequestId: string; activityId: string }>
    | undefined => {
    try {
      return {
        grantId: grantIdSchema.parse(newGrantId()),
        consentRequestId: grantConsentRequestIdSchema.parse(newConsentRequestId()),
        activityId: activityIdSchema.parse(newActivityId()),
      };
    } catch {
      return undefined;
    }
  };

  // The source is always the caller's selected organisation and application; a
  // proposal without an application context has no source application to bind.
  const sourceApplication = (candidate: OrganizationSelectionCandidate): string | undefined =>
    candidate.applicationRootId;

  const verifiedSource = (
    scope: SelectedOrganizationScope,
    candidate: OrganizationSelectionCandidate,
  ): string => {
    if (
      !sameUuid(scope.organizationId, candidate.organizationId) ||
      scope.applicationRootId === undefined ||
      !sameUuid(scope.applicationRootId, candidate.applicationRootId ?? "")
    )
      throw new Error("INVALID_SCOPE_RESULT");
    return scope.applicationRootId;
  };

  const recordFactsFor = async (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    grant: AccessGrant,
  ): Promise<unknown> => {
    if (grant.scopeKind !== "record") return null;
    if (dependencies.recordFacts === undefined) throw new Error("RECORD_FACTS_UNAVAILABLE");
    return dependencies.recordFacts.resolveRecordFacts(transaction, scope, {
      moduleRootId: grant.moduleRootId,
      recordTypeId: grant.recordTypeId,
      recordId: grant.recordId,
    });
  };

  const prevalidate = (
    candidate: OrganizationSelectionCandidate,
    ids: Readonly<{ grantId: string; consentRequestId: string }>,
    terms: unknown,
    grantId?: string,
  ): { proposal: ProposalTerms; grant: AccessGrant } | undefined => {
    const applicationRootId = sourceApplication(candidate);
    if (applicationRootId === undefined) return undefined;
    return buildProposal(terms, {
      grantId: grantId ?? ids.grantId,
      consentRequestId: ids.consentRequestId,
      clusterId: sourceClusterId,
      organizationId: candidate.organizationId,
      applicationRootId,
      organizationAccountId: validationAccountId,
    });
  };

  return Object.freeze({
    /** Stores one new proposal: draft inside the organisation, pending_consent between organisations. */
    propose: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      termsCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<RecordShareGrantState>> => {
      const ids = identifiers();
      if (ids === undefined) return { kind: "temporarily_unavailable" };
      if (prevalidate(candidate, ids, termsCandidate) === undefined) return { kind: "unavailable" };
      return requests.runChange(session, candidate, async (transaction, scope) => {
        const applicationRootId = verifiedSource(scope, candidate);
        const built = buildProposal(termsCandidate, {
          ...ids,
          clusterId: sourceClusterId,
          organizationId: scope.organizationId,
          applicationRootId,
          organizationAccountId: scope.organizationAccountId,
        });
        if (built === undefined) throw new Error("INVALID_PROPOSAL");
        const facts = await recordFactsFor(transaction, scope, built.grant);
        const fingerprint = fingerprintProposal(built.grant, built.proposal);
        const state = parseState(
          await transaction.query<ResultRow>`
            select vortex_access.propose_record_share_grant_for_administration(
              ${built.grant.grantId}::uuid,
              ${built.grant.consentRequestId ?? null}::uuid,
              ${JSON.stringify(built.proposal.terms)}::text::jsonb,
              ${fingerprint}::text,
              ${facts === null ? null : JSON.stringify(facts)}::text::jsonb,
              ${ids.activityId}::uuid
            ) as result
          `,
        );
        if (
          state.proposalFingerprint !== fingerprint ||
          state.revision !== 1 ||
          !sameUuid(state.grant.grantId, built.grant.grantId) ||
          !sameUuid(state.grant.sourceOrganizationId, scope.organizationId)
        )
          throw new Error("INVALID_GRANT_RESULT");
        return state;
      });
    },

    /**
     * Replaces the terms, and so the fingerprints, of a draft or pending_consent
     * proposal under the exact revision the caller last saw.
     */
    revise: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<RecordShareGrantState>> => {
      if (!isRecord(commandCandidate)) return { kind: "unavailable" };
      const { grantId: grantIdCandidate, expectedRevision, ...termsCandidate } = commandCandidate;
      const grantId = grantIdSchema.safeParse(grantIdCandidate);
      if (!grantId.success || !positiveRevision(expectedRevision)) return { kind: "unavailable" };
      const ids = identifiers();
      if (ids === undefined) return { kind: "temporarily_unavailable" };
      if (prevalidate(candidate, ids, termsCandidate, grantId.data) === undefined)
        return { kind: "unavailable" };
      return requests.runChange(session, candidate, async (transaction, scope) => {
        const applicationRootId = verifiedSource(scope, candidate);
        // The stored consent request keeps its identity; only a same-shape
        // (same-organisation or cross-organisation) revision is accepted, which
        // the protected operation checks against the stored proposal.
        const built = buildProposal(termsCandidate, {
          ...ids,
          grantId: grantId.data,
          clusterId: sourceClusterId,
          organizationId: scope.organizationId,
          applicationRootId,
          organizationAccountId: scope.organizationAccountId,
        });
        if (built === undefined) throw new Error("INVALID_PROPOSAL");
        const facts = await recordFactsFor(transaction, scope, built.grant);
        const fingerprint = fingerprintProposal(built.grant, built.proposal);
        const state = parseState(
          await transaction.query<ResultRow>`
            select vortex_access.revise_record_share_grant_for_administration(
              ${grantId.data}::uuid,
              ${expectedRevision}::bigint,
              ${JSON.stringify(built.proposal.terms)}::text::jsonb,
              ${fingerprint}::text,
              ${facts === null ? null : JSON.stringify(facts)}::text::jsonb,
              ${ids.activityId}::uuid
            ) as result
          `,
        );
        if (
          state.proposalFingerprint !== fingerprint ||
          state.revision !== expectedRevision + 1 ||
          !sameUuid(state.grant.grantId, grantId.data) ||
          !sameUuid(state.grant.sourceOrganizationId, scope.organizationId)
        )
          throw new Error("INVALID_GRANT_RESULT");
        return state;
      });
    },

    /** Withdraws a draft or pending_consent proposal; the grant is kept as revoked evidence. */
    withdraw: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<RecordShareGrantState>> => {
      if (!isRecord(commandCandidate)) return { kind: "unavailable" };
      const { grantId: grantIdCandidate, expectedRevision, reason, ...unknownKeys } =
        commandCandidate;
      const grantId = grantIdSchema.safeParse(grantIdCandidate);
      if (
        Object.keys(unknownKeys).length !== 0 ||
        !grantId.success ||
        !positiveRevision(expectedRevision) ||
        typeof reason !== "string" ||
        reason.length < 1 ||
        reason.length > 500
      )
        return { kind: "unavailable" };
      const ids = identifiers();
      if (ids === undefined) return { kind: "temporarily_unavailable" };
      return requests.runChange(session, candidate, async (transaction, scope) => {
        verifiedSource(scope, candidate);
        const state = parseState(
          await transaction.query<ResultRow>`
            select vortex_access.withdraw_record_share_grant_for_administration(
              ${grantId.data}::uuid,
              ${expectedRevision}::bigint,
              ${reason}::text,
              ${ids.activityId}::uuid
            ) as result
          `,
        );
        if (
          state.revision !== expectedRevision + 1 ||
          state.grant.status !== "revoked" ||
          !sameUuid(state.grant.grantId, grantId.data) ||
          !sameUuid(state.grant.sourceOrganizationId, scope.organizationId)
        )
          throw new Error("INVALID_GRANT_RESULT");
        return state;
      });
    },

    /** Reads one proposal for the source or recipient organisation it names. */
    get: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      grantIdCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<RecordShareGrantState>> => {
      const grantId = grantIdSchema.safeParse(grantIdCandidate);
      if (!grantId.success) return { kind: "unavailable" };
      return requests.run(session, candidate, async (transaction, scope) => {
        const state = parseState(
          await transaction.query<ResultRow>`
            select vortex_access.get_record_share_grant_for_administration(
              ${grantId.data}::uuid
            ) as result
          `,
        );
        if (
          !sameUuid(state.grant.grantId, grantId.data) ||
          (!sameUuid(state.grant.sourceOrganizationId, scope.organizationId) &&
            !sameUuid(state.grant.recipientOrganizationId, scope.organizationId))
        )
          throw new Error("INVALID_GRANT_RESULT");
        return state;
      });
    },
  });
};
