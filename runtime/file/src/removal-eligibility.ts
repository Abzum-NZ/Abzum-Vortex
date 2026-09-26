import "server-only";

import { createHash } from "node:crypto";
import {
  activeFileAttachmentReferenceSchema,
  activeFileShareReferenceSchema,
  activeFileSourceResponsibilityReferenceSchema,
  fileLegalHoldProjectionSchema,
  fileRemovalAuthoritySnapshotSchema,
  fileRemovalEligibilityBindingSchema,
  fileRemovalEligibilityDecisionSchema,
  fileRemovalEligibilityRequestSchema,
  fileRemovalHoldAuthoritySnapshotSchema,
  fileRemovalRecoveryPolicySnapshotSchema,
  protectedLegalHoldReferenceSchema,
  protectedLegalHoldScopeSchema,
  type FileRemovalAuthoritySnapshot,
  type FileRemovalEligibilityDecision,
  type FileRemovalEligibilityRequest,
  type FileRemovalOwnerBinding,
  type FileRemovalRefusalReason,
  type ProtectedLegalHoldReference,
} from "@vortex/contracts";

export {
  activeFileAttachmentReferenceSchema,
  activeFileShareReferenceSchema,
  activeFileSourceResponsibilityReferenceSchema,
  fileLegalHoldProjectionSchema,
  fileRemovalAuthoritySnapshotSchema,
  fileRemovalEligibilityBindingSchema,
  fileRemovalEligibilityDecisionSchema,
  fileRemovalEligibilityRequestSchema,
  fileRemovalHoldAuthoritySnapshotSchema,
  fileRemovalRecoveryPolicySnapshotSchema,
  protectedLegalHoldReferenceSchema,
  protectedLegalHoldScopeSchema,
  type ActiveFileAttachmentReference,
  type ActiveFileShareReference,
  type ActiveFileSourceResponsibilityReference,
  type FileLegalHoldProjection,
  type FileRemovalAuthoritySnapshot,
  type FileRemovalEligibilityBinding,
  type FileRemovalEligibilityDecision,
  type FileRemovalEligibilityRequest,
  type FileRemovalHoldAuthoritySnapshot,
  type FileRemovalOwnerBinding,
  type FileRemovalRecoveryPolicySnapshot,
  type FileRemovalRefusalReason,
  type ProtectedLegalHoldReference,
  type ProtectedLegalHoldScope,
} from "@vortex/contracts";

export type FileHoldEvaluationScope = Readonly<{
  tenantId: string;
  organizationId: string;
  fileId: string;
  applicationRootId?: string;
  ownerRecordTypeId?: string;
  ownerRecordId?: string;
}>;

const sameId = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const sameOptionalId = (left: string | undefined, right: string | undefined): boolean =>
  left === undefined || right === undefined
    ? left === right
    : sameId(left, right);

const sameOwner = (
  left: FileRemovalOwnerBinding,
  right: FileRemovalOwnerBinding,
): boolean =>
  sameId(left.sourceOrganizationId, right.sourceOrganizationId) &&
  sameOptionalId(left.applicationRootId, right.applicationRootId) &&
  sameId(left.recordTypeId, right.recordTypeId) &&
  sameId(left.recordId, right.recordId) &&
  sameId(left.fieldId, right.fieldId) &&
  left.recordRevision === right.recordRevision;

/** A hold protects only data in its exact tenant and organisation-owned scope. */
export const matchesProtectedLegalHold = (
  hold: ProtectedLegalHoldReference,
  fileScope: FileHoldEvaluationScope,
): boolean => {
  if (
    hold.status !== "active" ||
    !sameId(hold.tenantId, fileScope.tenantId) ||
    !sameId(hold.organizationId, fileScope.organizationId)
  ) {
    return false;
  }

  switch (hold.scope.kind) {
    case "all_organization_data":
      return true;
    case "file":
      return sameId(hold.scope.fileId, fileScope.fileId);
    case "record":
      return (
        fileScope.ownerRecordTypeId !== undefined &&
        fileScope.ownerRecordId !== undefined &&
        sameId(hold.scope.recordTypeId, fileScope.ownerRecordTypeId) &&
        sameId(hold.scope.recordId, fileScope.ownerRecordId)
      );
    case "record_type":
      return (
        fileScope.ownerRecordTypeId !== undefined &&
        sameId(hold.scope.recordTypeId, fileScope.ownerRecordTypeId)
      );
    case "application":
      return (
        fileScope.applicationRootId !== undefined &&
        sameId(hold.scope.applicationRootId, fileScope.applicationRootId)
      );
    default: {
      const exhaustive: never = hold.scope;
      return exhaustive;
    }
  }
};

const ELIGIBLE_REMOVAL_LIFECYCLE_STATES: ReadonlySet<
  FileRemovalAuthoritySnapshot["lifecycleState"]
> = new Set(["soft_deleted", "quarantined", "abandoned"]);

const refused = (
  reason: FileRemovalRefusalReason,
  decidedAt: string,
): FileRemovalEligibilityDecision =>
  Object.freeze(
    fileRemovalEligibilityDecisionSchema.parse({
      eligible: false,
      status: "refused",
      reason,
      decidedAt,
    }),
  );

const parseMilliseconds = (value: string): number | undefined => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
};

const authorityWindowIsCurrent = (
  resolvedAt: string,
  validUntil: string,
  nowMilliseconds: number,
): boolean => {
  const resolvedAtMilliseconds = parseMilliseconds(resolvedAt);
  const validUntilMilliseconds = parseMilliseconds(validUntil);
  return (
    resolvedAtMilliseconds !== undefined &&
    validUntilMilliseconds !== undefined &&
    resolvedAtMilliseconds <= nowMilliseconds &&
    nowMilliseconds < validUntilMilliseconds &&
    resolvedAtMilliseconds < validUntilMilliseconds
  );
};

const allRelationsMatchSource = (input: FileRemovalAuthoritySnapshot): boolean => {
  for (const attachment of input.activeAttachmentReferences) {
    if (
      !sameId(attachment.sourceOrganizationId, input.sourceOrganizationId) ||
      !sameId(attachment.fileId, input.fileId) ||
      input.owner === null ||
      !sameOwner(attachment.owner, input.owner)
    ) {
      return false;
    }
  }
  for (const share of input.activeShareReferences) {
    if (
      !sameId(share.sourceOrganizationId, input.sourceOrganizationId) ||
      !sameId(share.fileId, input.fileId)
    ) {
      return false;
    }
  }
  for (const responsibility of input.activeSourceResponsibilityReferences) {
    if (
      !sameId(responsibility.sourceOrganizationId, input.sourceOrganizationId) ||
      !sameId(responsibility.fileId, input.fileId)
    ) {
      return false;
    }
  }
  return true;
};

/**
 * Content-free binding over the complete parsed authority snapshot. This keeps
 * private object paths, hold identifiers and foreign share identifiers out of
 * the decision while making any change to them produce a different binding.
 */
const authorityFingerprint = (input: FileRemovalAuthoritySnapshot): string =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");

const evaluateFileRemovalEligibility = (
  candidate: unknown,
  now: Date,
): FileRemovalEligibilityDecision => {
  const nowMilliseconds = now.getTime();
  const validNow = Number.isFinite(nowMilliseconds);
  const decidedAt = validNow ? now.toISOString() : new Date().toISOString();
  const parsed = fileRemovalAuthoritySnapshotSchema.safeParse(candidate);
  if (!parsed.success || !validNow) return refused("malformed_input", decidedAt);

  const input = parsed.data;
  if (!authorityWindowIsCurrent(input.resolvedAt, input.validUntil, nowMilliseconds)) {
    return refused("authority_stale", decidedAt);
  }
  if (
    !sameId(input.organizationId, input.sourceOrganizationId) ||
    !input.objectPath.startsWith(`${input.sourceOrganizationId}/${input.fileId}/`) ||
    (input.owner !== null &&
      (!sameId(input.owner.sourceOrganizationId, input.sourceOrganizationId) ||
        !sameOptionalId(input.owner.applicationRootId, input.applicationRootId)))
  ) {
    return refused("ownership_mismatch", decidedAt);
  }
  if (
    input.expectedFileRevision !== input.fileRevision ||
    (input.owner === null) !== (input.expectedRecordRevision === null) ||
    (input.owner !== null && input.owner.recordRevision !== input.expectedRecordRevision)
  ) {
    return refused("stale_revision", decidedAt);
  }
  if (!allRelationsMatchSource(input)) {
    return refused("ownership_mismatch", decidedAt);
  }

  const holdAuthority = input.holdAuthority;
  const recoveryPolicy = input.recoveryPolicy;
  if (holdAuthority === null || recoveryPolicy === null) {
    return refused("unavailable_governing_policy", decidedAt);
  }
  if (
    !authorityWindowIsCurrent(
      holdAuthority.resolvedAt,
      holdAuthority.validUntil,
      nowMilliseconds,
    ) ||
    !authorityWindowIsCurrent(
      recoveryPolicy.resolvedAt,
      recoveryPolicy.validUntil,
      nowMilliseconds,
    )
  ) {
    return refused("authority_stale", decidedAt);
  }
  if (
    !sameId(holdAuthority.tenantId, input.tenantId) ||
    !sameId(holdAuthority.organizationId, input.sourceOrganizationId) ||
    !sameId(recoveryPolicy.tenantId, input.tenantId) ||
    !sameId(recoveryPolicy.organizationId, input.organizationId) ||
    !sameId(recoveryPolicy.sourceOrganizationId, input.sourceOrganizationId) ||
    !sameId(recoveryPolicy.retentionPolicyId, input.governingPolicyId) ||
    recoveryPolicy.policyRevision !== input.governingPolicyRevision ||
    !sameOptionalId(recoveryPolicy.applicationRootId, input.applicationRootId) ||
    !sameOptionalId(recoveryPolicy.recordTypeId, input.owner?.recordTypeId)
  ) {
    return refused("stale_revision", decidedAt);
  }
  if (!ELIGIBLE_REMOVAL_LIFECYCLE_STATES.has(input.lifecycleState)) {
    return refused("wrong_lifecycle", decidedAt);
  }
  if (input.activeAttachmentReferences.length !== 0) {
    return refused("active_attachment_ownership", decidedAt);
  }
  if (input.activeShareReferences.length !== 0) {
    return refused("active_share_responsibility", decidedAt);
  }
  if (input.activeSourceResponsibilityReferences.length !== 0) {
    return refused("active_source_responsibility", decidedAt);
  }

  const recoveryDeadlineMilliseconds = parseMilliseconds(recoveryPolicy.recoveryDeadline);
  if (recoveryDeadlineMilliseconds === undefined) {
    return refused("unavailable_governing_policy", decidedAt);
  }
  if (nowMilliseconds <= recoveryDeadlineMilliseconds) {
    return refused("current_recovery_protection", decidedAt);
  }

  const fileScope: FileHoldEvaluationScope = {
    tenantId: input.tenantId,
    organizationId: input.sourceOrganizationId,
    fileId: input.fileId,
    ...(input.applicationRootId === undefined
      ? {}
      : { applicationRootId: input.applicationRootId }),
    ...(input.owner === null ? {} : { ownerRecordTypeId: input.owner.recordTypeId }),
    ...(input.owner === null ? {} : { ownerRecordId: input.owner.recordId }),
  };
  if (input.holds.some((hold) => matchesProtectedLegalHold(hold, fileScope))) {
    return refused("matching_legal_hold", decidedAt);
  }

  const decision = fileRemovalEligibilityDecisionSchema.parse({
    eligible: true,
    status: "eligible",
    reason: null,
    binding: {
      authorityFingerprint: authorityFingerprint(input),
      fileRevision: input.fileRevision,
      recordRevision: input.owner?.recordRevision ?? null,
      governingPolicyRevision: input.governingPolicyRevision,
      holdPolicyRevision: holdAuthority.policyRevision,
    },
    decidedAt,
  });
  if (decision.eligible) Object.freeze(decision.binding);
  return Object.freeze(decision);
};

/**
 * Package-internal evaluator for state that trusted File-service wiring has
 * already resolved. It is not re-exported from the package public surface.
 */
export const evaluateResolvedFileRemovalAuthority = (
  candidate: unknown,
  now: Date,
): FileRemovalEligibilityDecision => evaluateFileRemovalEligibility(candidate, now);

export type FileRemovalAuthorityResolution =
  | Readonly<{ available: true; authority: FileRemovalAuthoritySnapshot }>
  | Readonly<{ available: false }>;

export type ResolveCurrentFileRemovalAuthority = (
  request: FileRemovalEligibilityRequest,
) => Promise<FileRemovalAuthorityResolution>;

export type FileRemovalEligibilityService = Readonly<{
  decideFileRemovalEligibility(
    candidate: unknown,
  ): Promise<FileRemovalEligibilityDecision>;
}>;

/**
 * Creates the authoritative File-service decision boundary. A caller can name
 * only a file; the injected resolver supplies every current ownership, relation,
 * hold and recovery-policy fact, and the injected server clock supplies time.
 */
export const createFileRemovalEligibilityService = (dependencies: Readonly<{
  resolveCurrentAuthority: ResolveCurrentFileRemovalAuthority;
  clock?: () => Date;
}>): FileRemovalEligibilityService => {
  if (typeof dependencies.resolveCurrentAuthority !== "function") {
    throw new Error("File removal eligibility requires a current-authority resolver");
  }
  const clock = dependencies.clock ?? (() => new Date());

  return Object.freeze({
    decideFileRemovalEligibility: async (
      candidate: unknown,
    ): Promise<FileRemovalEligibilityDecision> => {
      let now: Date;
      try {
        now = clock();
      } catch {
        return refused("authority_unavailable", new Date().toISOString());
      }
      const nowMilliseconds = now.getTime();
      const decidedAt = Number.isFinite(nowMilliseconds)
        ? now.toISOString()
        : new Date().toISOString();
      if (!Number.isFinite(nowMilliseconds)) {
        return refused("authority_unavailable", decidedAt);
      }

      const request = fileRemovalEligibilityRequestSchema.safeParse(candidate);
      if (!request.success) return refused("malformed_input", decidedAt);

      let resolution: FileRemovalAuthorityResolution;
      try {
        resolution = await dependencies.resolveCurrentAuthority(request.data);
      } catch {
        return refused("authority_unavailable", decidedAt);
      }
      if (!resolution.available) return refused("authority_unavailable", decidedAt);
      const authority = fileRemovalAuthoritySnapshotSchema.safeParse(
        resolution.authority,
      );
      if (!authority.success) return refused("authority_unavailable", decidedAt);
      if (!sameId(authority.data.fileId, request.data.fileId)) {
        return refused("ownership_mismatch", decidedAt);
      }
      return evaluateResolvedFileRemovalAuthority(authority.data, now);
    },
  });
};
