import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  fileObjectRemovalPartialStateSchema,
  fileObjectRemovalReceiptSchema,
  fileObjectRemovalRequestSchema,
  fileRecordSchema,
  platformIdSchema,
  type CorrelationId,
  type FileId,
  type FileObjectRemovalPartialState,
  type FileObjectRemovalReceipt,
  type FileObjectRemovalRequest,
  type FileRecord,
  type FileRemovalEligibleDecision,
  type FileRemovalEligibilityDecision,
  type FileRemovalStage,
  type Fingerprint,
  type OrganizationId,
  type PlatformId,
  type Revision,
} from "@vortex/contracts";
import {
  isValidFileLifecycleTransition,
  transitionFileLifecycleState,
} from "./file-metadata";
import type { FileRemovalEligibilityService } from "./removal-eligibility";

const REMOVAL_STAGES: readonly FileRemovalStage[] = Object.freeze([
  "previews",
  "storage_object",
  "metadata",
]);

const STAGE_CLAIM_MILLISECONDS = 5 * 60 * 1_000;

export type FileRemovalIntent = Readonly<{
  intentFingerprint: Fingerprint;
  deletionKey: string;
  correlationId: CorrelationId;
  fileId: FileId;
  organizationId: OrganizationId;
  authorityFingerprint: Fingerprint;
  fileRevision: Revision;
  recordRevision: Revision | null;
  governingPolicyRevision: Revision;
  holdPolicyRevision: Revision;
  eligibleDecidedAt: string;
  fileRecord: FileRecord;
  startedAt: string;
}>;

export type FileRemovalStageClaim = Readonly<{
  claimId: PlatformId;
  operationKey: string;
  expiresAt: string;
}>;

export type FileRemovalProgressRecord = Readonly<{
  kind: "progress";
  intent: FileRemovalIntent;
  version: number;
  status: "ready" | "executing" | "interrupted";
  currentStage: FileRemovalStage;
  completedStages: readonly FileRemovalStage[];
  claim?: FileRemovalStageClaim;
  updatedAt: string;
}>;

export type FileRemovalTerminalRecord = Readonly<{
  kind: "terminal";
  intent: FileRemovalIntent;
  version: number;
  receipt: FileObjectRemovalReceipt;
}>;

export type FileRemovalPersistedRecord =
  | FileRemovalProgressRecord
  | FileRemovalTerminalRecord;

export type FileRemovalFileSnapshot = Readonly<{
  revision: Revision;
  fileRecord: FileRecord;
}>;

export type FileRemovalStageClaimResult =
  | Readonly<{
      outcome: "claimed";
      record: FileRemovalProgressRecord;
    }>
  | Readonly<{
      outcome: "busy" | "advanced";
      record: FileRemovalPersistedRecord;
    }>;

/**
 * Durable repository boundary for one removal job and its canonical FileRecord.
 *
 * `begin` atomically verifies that the canonical FileRecord still has the intent's
 * exact revision, organisation, bucket and object path, then performs a put-if-absent
 * by deletion key. It must return an existing immutable intent rather than overwrite
 * it. Stage operations are compare-and-set by intent fingerprint, record version,
 * current stage and claim. An expired claim may be reclaimed with the same stable
 * operation key. `finalize` atomically writes the removed FileRecord tombstone and
 * terminal receipt; it must write neither when the expected file revision or job
 * claim no longer matches.
 */
export type FileRemovalRepository = Readonly<{
  readFileSnapshot(fileId: FileId): Promise<FileRemovalFileSnapshot | null>;
  read(deletionKey: string): Promise<FileRemovalPersistedRecord | null>;
  begin(intent: FileRemovalIntent): Promise<FileRemovalPersistedRecord>;
  claimStage(input: Readonly<{
    deletionKey: string;
    intentFingerprint: Fingerprint;
    expectedVersion: number;
    stage: FileRemovalStage;
    claim: FileRemovalStageClaim;
    claimedAt: string;
  }>): Promise<FileRemovalStageClaimResult>;
  completeExternalStage(input: Readonly<{
    deletionKey: string;
    intentFingerprint: Fingerprint;
    expectedVersion: number;
    stage: "previews" | "storage_object";
    claimId: PlatformId;
    effectOutcome: "removed" | "already_absent";
    completedAt: string;
  }>): Promise<FileRemovalProgressRecord>;
  interruptStage(input: Readonly<{
    deletionKey: string;
    intentFingerprint: Fingerprint;
    expectedVersion: number;
    stage: FileRemovalStage;
    claimId: PlatformId;
    interruptedAt: string;
  }>): Promise<FileRemovalProgressRecord>;
  finalize(input: Readonly<{
    deletionKey: string;
    intentFingerprint: Fingerprint;
    expectedVersion: number;
    claimId: PlatformId;
    expectedFileRevision: Revision;
    expectedOrganizationId: OrganizationId;
    expectedBucketId: FileRecord["bucketId"];
    expectedObjectPath: FileRecord["storageKey"];
    tombstone: FileRecord;
    receipt: FileObjectRemovalReceipt;
  }>): Promise<FileRemovalTerminalRecord>;
}>;

export type FileRemovalEffectResult = Readonly<{
  outcome: "removed" | "already_absent";
}>;

export type FilePreviewDeleter = Readonly<{
  deletePreviews(input: Readonly<{
    organizationId: OrganizationId;
    fileId: FileId;
    previewReferences: FileRecord["previewReferences"];
    idempotencyKey: string;
  }>): Promise<FileRemovalEffectResult>;
}>;

export type FileStorageDeleter = Readonly<{
  deleteObject(input: Readonly<{
    organizationId: OrganizationId;
    bucketId: FileRecord["bucketId"];
    objectPath: FileRecord["storageKey"];
    idempotencyKey: string;
  }>): Promise<FileRemovalEffectResult>;
}>;

export type FileRemovalResult =
  | FileObjectRemovalReceipt
  | FileObjectRemovalPartialState;

export type FileRemovalCoordinatorDependencies = Readonly<{
  eligibilityService: Pick<
    FileRemovalEligibilityService,
    "decideFileRemovalEligibility"
  >;
  repository: FileRemovalRepository;
  previewDeleter: FilePreviewDeleter;
  storageDeleter: FileStorageDeleter;
  clock?: () => Date;
  idGenerator?: () => PlatformId;
}>;

export type FileRemovalCoordinator = Readonly<{
  coordinateFileRemoval(candidate: unknown): Promise<FileRemovalResult>;
}>;

const nowIso = (clock: () => Date): string => {
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("File removal clock returned an invalid time");
  }
  return now.toISOString();
};

const bindingsMatch = (
  left: FileRemovalEligibleDecision,
  right: FileRemovalEligibleDecision,
): boolean =>
  left.binding.authorityFingerprint === right.binding.authorityFingerprint &&
  left.binding.fileRevision === right.binding.fileRevision &&
  left.binding.recordRevision === right.binding.recordRevision &&
  left.binding.governingPolicyRevision === right.binding.governingPolicyRevision &&
  left.binding.holdPolicyRevision === right.binding.holdPolicyRevision;

const fingerprintIntent = (
  intent: Omit<FileRemovalIntent, "intentFingerprint">,
): Fingerprint => {
  const canonicalFileRecord = fileRecordSchema.parse(intent.fileRecord);
  const stableEvidence = {
    deletionKey: intent.deletionKey,
    correlationId: intent.correlationId,
    fileId: intent.fileId,
    organizationId: intent.organizationId,
    authorityFingerprint: intent.authorityFingerprint,
    fileRevision: intent.fileRevision,
    recordRevision: intent.recordRevision,
    governingPolicyRevision: intent.governingPolicyRevision,
    holdPolicyRevision: intent.holdPolicyRevision,
    eligibleDecidedAt: intent.eligibleDecidedAt,
    fileRecord: canonicalFileRecord,
  };
  return createHash("sha256")
    .update(JSON.stringify(stableEvidence))
    .digest("hex") as Fingerprint;
};

const operationKey = (
  intentFingerprint: Fingerprint,
  stage: FileRemovalStage,
): string => `file-removal:${intentFingerprint}:${stage}`;

const assertRecordMatchesIntent = (
  record: FileRemovalPersistedRecord,
  intent: FileRemovalIntent,
): void => {
  const persisted = record.intent;
  const persistedFileRecord = fileRecordSchema.parse(persisted.fileRecord);
  const expectedFileRecord = fileRecordSchema.parse(intent.fileRecord);
  if (
    persisted.intentFingerprint !== fingerprintIntent(persisted) ||
    persisted.deletionKey !== intent.deletionKey ||
    persisted.intentFingerprint !== intent.intentFingerprint ||
    persisted.fileId !== intent.fileId ||
    persisted.organizationId !== intent.organizationId ||
    persisted.correlationId !== intent.correlationId ||
    persisted.authorityFingerprint !== intent.authorityFingerprint ||
    persisted.fileRevision !== intent.fileRevision ||
    persisted.recordRevision !== intent.recordRevision ||
    persisted.governingPolicyRevision !== intent.governingPolicyRevision ||
    persisted.holdPolicyRevision !== intent.holdPolicyRevision ||
    persisted.eligibleDecidedAt !== intent.eligibleDecidedAt ||
    persisted.fileRecord.bucketId !== intent.fileRecord.bucketId ||
    persisted.fileRecord.storageKey !== intent.fileRecord.storageKey ||
    JSON.stringify(persistedFileRecord) !== JSON.stringify(expectedFileRecord)
  ) {
    throw new Error(
      "File removal refused: deletion key is already bound to different evidence",
    );
  }
};

const assertProgressRecord = (record: FileRemovalProgressRecord): void => {
  if (!Number.isSafeInteger(record.version) || record.version < 1) {
    throw new Error("File removal refused: repository returned an invalid version");
  }
  partialResult(record);
  if (
    (record.status === "executing") !== (record.claim !== undefined) ||
    (record.claim !== undefined && record.claim.operationKey !== operationKey(
      record.intent.intentFingerprint,
      record.currentStage,
    ))
  ) {
    throw new Error("File removal refused: repository returned an invalid stage state");
  }
};

const assertRequestMatchesRecord = (
  request: FileObjectRemovalRequest,
  record: FileRemovalPersistedRecord,
): void => {
  const intent = record.intent;
  const binding = request.decision.binding;
  if (
    request.deletionKey !== intent.deletionKey ||
    request.fileId !== intent.fileId ||
    request.correlationId !== intent.correlationId ||
    request.decision.decidedAt !== intent.eligibleDecidedAt ||
    binding.authorityFingerprint !== intent.authorityFingerprint ||
    binding.fileRevision !== intent.fileRevision ||
    binding.recordRevision !== intent.recordRevision ||
    binding.governingPolicyRevision !== intent.governingPolicyRevision ||
    binding.holdPolicyRevision !== intent.holdPolicyRevision
  ) {
    throw new Error(
      "File removal refused: deletion key is already bound to different evidence",
    );
  }
};

function partialResult(
  record: FileRemovalProgressRecord,
): FileObjectRemovalPartialState {
  return Object.freeze(
    fileObjectRemovalPartialStateSchema.parse({
      fileId: record.intent.fileId,
      organizationId: record.intent.organizationId,
      deletionKey: record.intent.deletionKey,
      status: record.status === "interrupted" ? "interrupted" : "in_progress",
      completedStages: [...record.completedStages],
      currentStage: record.currentStage,
      authorityFingerprint: record.intent.authorityFingerprint,
      startedAt: record.intent.startedAt,
      updatedAt: record.updatedAt,
    }),
  );
}

const terminalResult = (
  record: FileRemovalTerminalRecord,
): FileObjectRemovalReceipt => {
  if (!Number.isSafeInteger(record.version) || record.version < 1) {
    throw new Error("File removal refused: repository returned an invalid version");
  }
  const receipt = fileObjectRemovalReceiptSchema.parse(record.receipt);
  if (
    receipt.deletionKey !== record.intent.deletionKey ||
    receipt.fileId !== record.intent.fileId ||
    receipt.organizationId !== record.intent.organizationId ||
    receipt.authorityFingerprint !== record.intent.authorityFingerprint
  ) {
    throw new Error("File removal refused: terminal receipt does not match its intent");
  }
  return Object.freeze(receipt);
};

const asResult = (record: FileRemovalPersistedRecord): FileRemovalResult =>
  record.kind === "terminal" ? terminalResult(record) : partialResult(record);

/**
 * Coordinates one source-organisation-scoped, permanently authorised file
 * removal. Caller evidence is parsed, re-evaluated through the #657 authority
 * boundary, and then bound to the canonical versioned FileRecord before any
 * side effect occurs.
 */
export const createFileRemovalCoordinator = (
  dependencies: FileRemovalCoordinatorDependencies,
): FileRemovalCoordinator => {
  if (
    typeof dependencies?.eligibilityService?.decideFileRemovalEligibility !==
    "function"
  )
    throw new Error("File removal requires the #657 eligibility service");
  if (typeof dependencies?.repository?.begin !== "function")
    throw new Error("File removal requires a durable repository");
  if (
    typeof dependencies.repository.read !== "function" ||
    typeof dependencies.repository.readFileSnapshot !== "function" ||
    typeof dependencies.repository.claimStage !== "function" ||
    typeof dependencies.repository.completeExternalStage !== "function" ||
    typeof dependencies.repository.interruptStage !== "function" ||
    typeof dependencies.repository.finalize !== "function"
  )
    throw new Error("File removal repository is incomplete");
  if (typeof dependencies?.previewDeleter?.deletePreviews !== "function")
    throw new Error("File removal requires a preview deleter");
  if (typeof dependencies?.storageDeleter?.deleteObject !== "function")
    throw new Error("File removal requires a storage object deleter");

  const clock = dependencies.clock ?? (() => new Date());
  const idGenerator = dependencies.idGenerator ?? (() => randomUUID() as PlatformId);

  return Object.freeze({
    coordinateFileRemoval: async (candidate: unknown): Promise<FileRemovalResult> => {
      const parsedRequest = fileObjectRemovalRequestSchema.safeParse(candidate);
      if (!parsedRequest.success) {
        throw new Error("File removal refused: malformed request");
      }
      const request = parsedRequest.data;

      const existingRecord = await dependencies.repository.read(request.deletionKey);
      let record: FileRemovalPersistedRecord;
      let intent: FileRemovalIntent;
      if (existingRecord !== null) {
        assertRequestMatchesRecord(request, existingRecord);
        intent = existingRecord.intent;
        record = existingRecord;
        assertRecordMatchesIntent(existingRecord, intent);
      } else {
        let currentDecision: FileRemovalEligibilityDecision;
        try {
          currentDecision =
            await dependencies.eligibilityService.decideFileRemovalEligibility({
              fileId: request.fileId,
            });
        } catch {
          throw new Error("File removal refused: current eligibility is unavailable");
        }
        if (!currentDecision.eligible || !bindingsMatch(request.decision, currentDecision)) {
          throw new Error("File removal refused: eligible decision is not current");
        }

        const snapshot = await dependencies.repository.readFileSnapshot(request.fileId);
        if (snapshot === null) throw new Error("File removal refused: file is unavailable");
        const parsedFile = fileRecordSchema.safeParse(snapshot.fileRecord);
        if (!parsedFile.success || snapshot.revision !== currentDecision.binding.fileRevision) {
          throw new Error("File removal refused: canonical file revision is not current");
        }
        const fileRecord = parsedFile.data;
        if (
          fileRecord.fileId !== request.fileId ||
          !isValidFileLifecycleTransition(fileRecord.lifecycleState, "removed")
        ) {
          throw new Error("File removal refused: canonical file is not removable");
        }

        const startedAt = nowIso(clock);
        const intentWithoutFingerprint: Omit<
          FileRemovalIntent,
          "intentFingerprint"
        > = Object.freeze({
          deletionKey: request.deletionKey,
          correlationId: request.correlationId,
          fileId: fileRecord.fileId,
          organizationId: fileRecord.organizationId,
          authorityFingerprint: currentDecision.binding.authorityFingerprint,
          fileRevision: currentDecision.binding.fileRevision,
          recordRevision: currentDecision.binding.recordRevision,
          governingPolicyRevision: currentDecision.binding.governingPolicyRevision,
          holdPolicyRevision: currentDecision.binding.holdPolicyRevision,
          eligibleDecidedAt: request.decision.decidedAt,
          fileRecord: Object.freeze({ ...fileRecord }),
          startedAt,
        });
        intent = Object.freeze({
          ...intentWithoutFingerprint,
          intentFingerprint: fingerprintIntent(intentWithoutFingerprint),
        });

        record = await dependencies.repository.begin(intent);
        assertRecordMatchesIntent(record, intent);
        assertRequestMatchesRecord(request, record);
      }

      for (;;) {
        if (record.kind === "terminal") return terminalResult(record);
        assertProgressRecord(record);
        const stage = record.currentStage;
        const claimedAt = nowIso(clock);
        const claimId = platformIdSchema.parse(idGenerator());
        const claim: FileRemovalStageClaim = Object.freeze({
          claimId,
          operationKey: operationKey(intent.intentFingerprint, stage),
          expiresAt: new Date(
            Date.parse(claimedAt) + STAGE_CLAIM_MILLISECONDS,
          ).toISOString(),
        });
        const claimResult = await dependencies.repository.claimStage({
          deletionKey: intent.deletionKey,
          intentFingerprint: intent.intentFingerprint,
          expectedVersion: record.version,
          stage,
          claim,
          claimedAt,
        });
        assertRecordMatchesIntent(claimResult.record, intent);
        if (claimResult.outcome !== "claimed") {
          if (claimResult.record.kind === "progress") {
            assertProgressRecord(claimResult.record);
          }
          return asResult(claimResult.record);
        }

        const claimedRecord = claimResult.record;
        assertProgressRecord(claimedRecord);
        if (
          claimedRecord.currentStage !== stage ||
          claimedRecord.status !== "executing" ||
          claimedRecord.claim?.claimId !== claim.claimId
        ) {
          throw new Error("File removal refused: repository returned an invalid stage claim");
        }

        if (stage === "metadata") {
          const removedAt = nowIso(clock);
          const tombstone = transitionFileLifecycleState(
            intent.fileRecord,
            "removed",
            { clock: () => new Date(removedAt) },
          );
          const receipt = fileObjectRemovalReceiptSchema.parse({
            receiptId: platformIdSchema.parse(idGenerator()),
            fileId: intent.fileId,
            organizationId: intent.organizationId,
            deletionKey: intent.deletionKey,
            status: "completed",
            outcome: "removed",
            completedStages: REMOVAL_STAGES,
            authorityFingerprint: intent.authorityFingerprint,
            removedAt,
            completedAt: removedAt,
          });
          const terminal = await dependencies.repository.finalize({
            deletionKey: intent.deletionKey,
            intentFingerprint: intent.intentFingerprint,
            expectedVersion: claimedRecord.version,
            claimId: claim.claimId,
            expectedFileRevision: intent.fileRevision,
            expectedOrganizationId: intent.organizationId,
            expectedBucketId: intent.fileRecord.bucketId,
            expectedObjectPath: intent.fileRecord.storageKey,
            tombstone,
            receipt,
          });
          assertRecordMatchesIntent(terminal, intent);
          return terminalResult(terminal);
        }

        let effect: FileRemovalEffectResult;
        try {
          effect =
            stage === "previews"
              ? await dependencies.previewDeleter.deletePreviews({
                  organizationId: intent.organizationId,
                  fileId: intent.fileId,
                  previewReferences: [...intent.fileRecord.previewReferences],
                  idempotencyKey: claim.operationKey,
                })
              : await dependencies.storageDeleter.deleteObject({
                  organizationId: intent.organizationId,
                  bucketId: intent.fileRecord.bucketId,
                  objectPath: intent.fileRecord.storageKey,
                  idempotencyKey: claim.operationKey,
                });
          if (effect.outcome !== "removed" && effect.outcome !== "already_absent") {
            throw new Error("File removal effect returned an invalid outcome");
          }
        } catch {
          const interrupted = await dependencies.repository.interruptStage({
            deletionKey: intent.deletionKey,
            intentFingerprint: intent.intentFingerprint,
            expectedVersion: claimedRecord.version,
            stage,
            claimId: claim.claimId,
            interruptedAt: nowIso(clock),
          });
          assertRecordMatchesIntent(interrupted, intent);
          assertProgressRecord(interrupted);
          if (
            interrupted.status !== "interrupted" ||
            interrupted.currentStage !== stage
          ) {
            throw new Error(
              "File removal refused: repository did not persist the interrupted stage",
            );
          }
          return partialResult(interrupted);
        }

        record = await dependencies.repository.completeExternalStage({
          deletionKey: intent.deletionKey,
          intentFingerprint: intent.intentFingerprint,
          expectedVersion: claimedRecord.version,
          stage,
          claimId: claim.claimId,
          effectOutcome: effect.outcome,
          completedAt: nowIso(clock),
        });
        assertRecordMatchesIntent(record, intent);
        assertProgressRecord(record);
        const nextStage = REMOVAL_STAGES[REMOVAL_STAGES.indexOf(stage) + 1];
        if (
          nextStage === undefined ||
          record.currentStage !== nextStage ||
          record.status !== "ready"
        ) {
          throw new Error(
            "File removal refused: repository did not advance the completed stage",
          );
        }
      }
    },
  });
};
