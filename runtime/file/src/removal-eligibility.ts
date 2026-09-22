import "server-only";

import {
  MAXIMUM_FILE_STORAGE_OPERATION_SECONDS,
  fileLegalHoldProjectionSchema,
  fileRemovalEligibilityDecisionSchema,
  fileRemovalEligibilityInputSchema,
  protectedLegalHoldReferenceSchema,
  protectedLegalHoldScopeSchema,
  type FileLegalHoldProjection,
  type FileRecord,
  type FileRemovalEligibilityDecision,
  type FileRemovalEligibleDecision,
  type FileRemovalEligibilityInput,
  type FileRemovalRefusalReason,
  type PlatformId,
  type ProtectedLegalHoldReference,
  type ProtectedLegalHoldScope,
} from "@vortex/contracts";

export {
  fileLegalHoldProjectionSchema,
  fileRemovalEligibilityDecisionSchema,
  fileRemovalEligibilityInputSchema,
  protectedLegalHoldReferenceSchema,
  protectedLegalHoldScopeSchema,
  type FileLegalHoldProjection,
  type FileRemovalEligibilityDecision,
  type FileRemovalEligibilityInput,
  type FileRemovalRefusalReason,
  type ProtectedLegalHoldReference,
  type ProtectedLegalHoldScope,
};

/** The symbol and registry keep eligible evidence server-local and non-forgeable. */
declare const fileRemovalEligibilityEvidence: unique symbol;

export type FileRemovalEligibilityEvidence = FileRemovalEligibleDecision &
  Readonly<{ [fileRemovalEligibilityEvidence]: true }>;

export type FileHoldEvaluationScope = Readonly<{
  organizationId: string;
  fileId: string;
  applicationRootId?: string;
  ownerRecordTypeId?: string;
  ownerRecordId?: string;
}>;

type EvidenceFacts = Readonly<{
  input: FileRemovalEligibilityInput;
  decidedAtMilliseconds: number;
}>;

const issuedEligibilityEvidence = new WeakMap<object, EvidenceFacts>();

const sameId = (left: string | undefined, right: string | undefined): boolean =>
  left !== undefined && right !== undefined && left === right;

/** A hold protects only data in its exact organisation-owned, versioned scope. */
export const matchesProtectedLegalHold = (
  hold: ProtectedLegalHoldReference,
  fileScope: FileHoldEvaluationScope,
): boolean => {
  if (hold.status !== "active" || hold.organizationId !== fileScope.organizationId) {
    return false;
  }

  switch (hold.scope.kind) {
    case "all_organization_data":
      return true;
    case "file":
      return sameId(hold.scope.fileId, fileScope.fileId);
    case "record":
      return (
        sameId(hold.scope.recordTypeId, fileScope.ownerRecordTypeId) &&
        sameId(hold.scope.recordId, fileScope.ownerRecordId)
      );
    case "record_type":
      return sameId(hold.scope.recordTypeId, fileScope.ownerRecordTypeId);
    case "application":
      return sameId(hold.scope.applicationRootId, fileScope.applicationRootId);
    default: {
      const exhaustive: never = hold.scope;
      return exhaustive;
    }
  }
};

const ELIGIBLE_REMOVAL_LIFECYCLE_STATES: ReadonlySet<FileRemovalEligibilityInput["lifecycleState"]> =
  new Set(["soft_deleted", "quarantined", "abandoned"]);

const refused = (
  reason: FileRemovalRefusalReason,
  input: FileRemovalEligibilityInput | undefined,
  decidedAt: string,
): FileRemovalEligibilityDecision =>
  fileRemovalEligibilityDecisionSchema.parse({
    eligible: false,
    status: "refused",
    reason,
    fileId: input?.fileId ?? null,
    organizationId: input?.organizationId ?? null,
    evaluatedRevision: input?.currentRevision ?? null,
    decidedAt,
  });

/**
 * Performs the current, source-organisation removal decision. The result is
 * content-free; a matching hold is reported only by its stable refusal reason.
 */
export const decideFileRemovalEligibility = (
  candidate: unknown,
  options?: Readonly<{ clock?: () => Date }>,
): FileRemovalEligibilityDecision => {
  const clock = options?.clock ?? (() => new Date());
  const now = clock();
  const validNow = Number.isFinite(now.getTime());
  const decidedAt = validNow ? now.toISOString() : new Date().toISOString();
  const parsed = fileRemovalEligibilityInputSchema.safeParse(candidate);
  if (!parsed.success || !validNow) {
    return refused("malformed_input", undefined, decidedAt);
  }

  const input = parsed.data;
  if (input.sourceOrganizationId !== input.organizationId) {
    return refused("active_share_responsibility", input, decidedAt);
  }
  if (input.expectedRevision !== input.currentRevision) {
    return refused("stale_revision", input, decidedAt);
  }
  if (!input.holdPolicyAvailable || !input.recoveryPolicyAvailable) {
    return refused("unavailable_governing_policy", input, decidedAt);
  }
  if (!ELIGIBLE_REMOVAL_LIFECYCLE_STATES.has(input.lifecycleState)) {
    return refused("wrong_lifecycle", input, decidedAt);
  }
  if (input.activeAttachmentReferences.length !== 0) {
    return refused("active_attachment_ownership", input, decidedAt);
  }

  // A share is retained as current evidence, but recipient access cannot veto a
  // source-owned removal or become an independent source of removal authority.
  // Coordination of revocation and bytes stays outside this eligibility decision.

  if (input.lifecycleState === "soft_deleted") {
    if (input.recoveryDeadline === null || input.recoveryDeadline === undefined) {
      return refused("unavailable_governing_policy", input, decidedAt);
    }
    const deadline = Date.parse(input.recoveryDeadline);
    if (!Number.isFinite(deadline)) {
      return refused("unavailable_governing_policy", input, decidedAt);
    }
    if (now.getTime() <= deadline) {
      return refused("current_recovery_protection", input, decidedAt);
    }
  }

  const fileScope: FileHoldEvaluationScope = {
    organizationId: input.sourceOrganizationId,
    fileId: input.fileId,
    applicationRootId: input.applicationRootId,
    ownerRecordTypeId: input.ownerRecordTypeId,
    ownerRecordId: input.ownerRecordId,
  };
  if (input.holds.some((hold) => matchesProtectedLegalHold(hold, fileScope))) {
    return refused("matching_legal_hold", input, decidedAt);
  }

  const decision = fileRemovalEligibilityDecisionSchema.parse({
    eligible: true,
    status: "eligible",
    reason: null,
    fileId: input.fileId,
    organizationId: input.organizationId,
    evaluatedRevision: input.currentRevision,
    decidedAt,
  }) as FileRemovalEligibilityEvidence;
  issuedEligibilityEvidence.set(decision, { input, decidedAtMilliseconds: now.getTime() });
  return Object.freeze(decision);
};

/**
 * Verifies that the candidate is evidence produced by this server-side evaluator,
 * is within the credential boundary, and still binds the current file metadata.
 */
export const isCurrentFileRemovalEligibilityEvidence = (
  candidate: unknown,
  fileRecord: FileRecord,
  now: Date,
): candidate is FileRemovalEligibilityEvidence => {
  if (candidate === null || typeof candidate !== "object" || !Number.isFinite(now.getTime())) {
    return false;
  }
  const facts = issuedEligibilityEvidence.get(candidate);
  if (facts === undefined || now.getTime() - facts.decidedAtMilliseconds < 0) {
    return false;
  }
  if (
    now.getTime() - facts.decidedAtMilliseconds >
    MAXIMUM_FILE_STORAGE_OPERATION_SECONDS * 1_000
  ) {
    return false;
  }

  const decision = fileRemovalEligibilityDecisionSchema.safeParse(candidate);
  if (!decision.success || !decision.data.eligible) return false;
  const { input } = facts;
  return (
    input.organizationId === fileRecord.organizationId &&
    input.sourceOrganizationId === fileRecord.organizationId &&
    input.fileId === fileRecord.fileId &&
    input.lifecycleState === fileRecord.lifecycleState &&
    input.applicationRootId === fileRecord.applicationRootId &&
    input.ownerRecordTypeId === fileRecord.ownerRecordTypeId &&
    input.ownerRecordId === fileRecord.ownerRecordId &&
    input.ownerFieldId === fileRecord.ownerFieldId &&
    decision.data.fileId === fileRecord.fileId &&
    decision.data.organizationId === fileRecord.organizationId &&
    decision.data.evaluatedRevision === input.currentRevision
  );
};

export type BuildFileRemovalEligibilityInputOptions = Readonly<{
  expectedRevision: number;
  currentRevision: number;
  recoveryDeadline?: string | null;
  activeAttachmentReferences?: readonly PlatformId[];
  activeShareReferences: readonly PlatformId[];
  holds: readonly ProtectedLegalHoldReference[];
  holdPolicyAvailable: boolean;
  recoveryPolicyAvailable: boolean;
}>;

/** Builds an explicit input from current source-owned metadata and policy facts. */
export const buildFileRemovalEligibilityInput = (
  fileRecord: FileRecord,
  options: BuildFileRemovalEligibilityInputOptions,
): FileRemovalEligibilityInput =>
  fileRemovalEligibilityInputSchema.parse({
    organizationId: fileRecord.organizationId,
    sourceOrganizationId: fileRecord.organizationId,
    fileId: fileRecord.fileId,
    applicationRootId: fileRecord.applicationRootId,
    ownerRecordTypeId: fileRecord.ownerRecordTypeId,
    ownerRecordId: fileRecord.ownerRecordId,
    ownerFieldId: fileRecord.ownerFieldId,
    lifecycleState: fileRecord.lifecycleState,
    recoveryDeadline: options.recoveryDeadline ?? fileRecord.removalDueAt ?? null,
    activeAttachmentReferences: [
      ...(options.activeAttachmentReferences ?? fileRecord.owningAttachmentReferences),
    ],
    activeShareReferences: [...options.activeShareReferences],
    expectedRevision: options.expectedRevision,
    currentRevision: options.currentRevision,
    holds: [...options.holds],
    holdPolicyAvailable: options.holdPolicyAvailable,
    recoveryPolicyAvailable: options.recoveryPolicyAvailable,
  });
