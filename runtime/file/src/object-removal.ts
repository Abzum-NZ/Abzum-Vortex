import "server-only";

import { randomUUID } from "node:crypto";
import {
  fileObjectRemovalPartialStateSchema,
  fileObjectRemovalReceiptSchema,
  fileObjectRemovalRequestSchema,
  fileRemovalStageSchema,
  type FileId,
  type FileObjectRemovalPartialState,
  type FileObjectRemovalReceipt,
  type FileObjectRemovalRequest,
  type FileRecord,
  type FileRemovalStage,
  type OrganizationId,
  type PlatformId,
} from "@vortex/contracts";
import {
  isValidFileLifecycleTransition,
  transitionFileLifecycleState,
} from "./file-metadata";

export type FileRemovalPersistedRecord =
  | FileObjectRemovalPartialState
  | FileObjectRemovalReceipt;

/**
 * Injected durable store for file removal intent, partial progress, and terminal receipts.
 * Keeps persistence behind an injected boundary without inventing schema ownership.
 */
export type FileRemovalStateStore = Readonly<{
  get(deletionKey: string): Promise<FileRemovalPersistedRecord | null>;
  savePartial(state: FileObjectRemovalPartialState): Promise<void>;
  saveTerminal(receipt: FileObjectRemovalReceipt): Promise<void>;
}>;

/**
 * Injected store for retrieving and updating canonical FileRecord metadata.
 */
export type FileMetadataStore = Readonly<{
  getFileRecord(fileId: FileId): Promise<FileRecord | null>;
  updateFileRecord(fileRecord: FileRecord): Promise<void>;
}>;

/**
 * Injected interface for private storage object deletion.
 */
export type FileStorageDeleter = Readonly<{
  deleteObject(input: Readonly<{
    organizationId: OrganizationId;
    bucketId: string;
    objectPath: string;
  }>): Promise<void>;
}>;

/**
 * Injected interface for cleaning previews and active derived copies owned by this boundary.
 */
export type FilePreviewDeleter = Readonly<{
  deletePreviews(input: Readonly<{
    organizationId: OrganizationId;
    fileId: FileId;
    previewReferences: readonly string[];
  }>): Promise<void>;
}>;

export type FileObjectRemovalResult =
  | FileObjectRemovalReceipt
  | FileObjectRemovalPartialState;

export type FileRemovalResult = FileObjectRemovalResult;

export type FileObjectRemovalCoordinatorDependencies = Readonly<{
  stateStore: FileRemovalStateStore;
  metadataStore: FileMetadataStore;
  storageDeleter: FileStorageDeleter;
  previewDeleter?: FilePreviewDeleter;
  clock?: () => Date;
  idGenerator?: () => PlatformId;
}>;

export type FileRemovalCoordinatorDependencies =
  FileObjectRemovalCoordinatorDependencies;

export type FileObjectRemovalCoordinator = Readonly<{
  coordinateFileRemoval(candidate: unknown): Promise<FileObjectRemovalResult>;
}>;

export type FileRemovalCoordinator = FileObjectRemovalCoordinator;

/**
 * Creates an in-memory removal state store suitable for testing or isolated executions.
 */
export const createInMemoryFileRemovalStateStore = (): FileRemovalStateStore => {
  const records = new Map<string, FileRemovalPersistedRecord>();
  return Object.freeze({
    get: async (deletionKey: string): Promise<FileRemovalPersistedRecord | null> => {
      const record = records.get(deletionKey);
      return record ? Object.freeze({ ...record }) : null;
    },
    savePartial: async (state: FileObjectRemovalPartialState): Promise<void> => {
      records.set(state.deletionKey, Object.freeze({ ...state }));
    },
    saveTerminal: async (receipt: FileObjectRemovalReceipt): Promise<void> => {
      records.set(receipt.deletionKey, Object.freeze({ ...receipt }));
    },
  });
};

const ALL_REMOVAL_STAGES: readonly FileRemovalStage[] = Object.freeze([
  "previews",
  "storage_object",
  "metadata",
]);

/**
 * Creates a bounded, duplicate-safe and resumable coordinator for permanent file removal.
 * Coordinates durable removal intent and outcome across file metadata, previews or other
 * active derived copies owned by this boundary, and the private storage object.
 */
export const createFileObjectRemovalCoordinator = (
  dependencies: FileObjectRemovalCoordinatorDependencies,
): FileObjectRemovalCoordinator => {
  if (!dependencies || typeof dependencies !== "object") {
    throw new Error("File removal coordinator requires dependencies");
  }
  if (!dependencies.stateStore || typeof dependencies.stateStore.get !== "function") {
    throw new Error("File removal coordinator requires a stateStore dependency");
  }
  if (!dependencies.metadataStore || typeof dependencies.metadataStore.getFileRecord !== "function") {
    throw new Error("File removal coordinator requires a metadataStore dependency");
  }
  if (!dependencies.storageDeleter || typeof dependencies.storageDeleter.deleteObject !== "function") {
    throw new Error("File removal coordinator requires a storageDeleter dependency");
  }

  const {
    stateStore,
    metadataStore,
    storageDeleter,
    previewDeleter,
    clock = () => new Date(),
    idGenerator = () => randomUUID() as PlatformId,
  } = dependencies;

  return Object.freeze({
    coordinateFileRemoval: async (
      candidate: unknown,
    ): Promise<FileObjectRemovalResult> => {
      let now: Date;
      try {
        now = clock();
      } catch {
        throw new Error("Clock returned an unavailable time");
      }
      const nowMilliseconds = now.getTime();
      if (!Number.isFinite(nowMilliseconds)) {
        throw new Error("Clock returned an invalid time");
      }
      const nowIso = now.toISOString();

      const parseResult = fileObjectRemovalRequestSchema.safeParse(candidate);
      if (!parseResult.success) {
        throw new Error(
          `Invalid file removal request: ${parseResult.error.message}`,
        );
      }
      const request = parseResult.data;

      // 1. Check existing durable state under the stable deletion key.
      let existing: FileRemovalPersistedRecord | null = null;
      try {
        existing = await stateStore.get(request.deletionKey);
      } catch (error) {
        throw new Error(
          `Failed to check removal state store: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (existing !== null) {
        // Repeated calls with the same deletion key must match the original target and binding.
        if (
          existing.fileId.toLowerCase() !== request.fileId.toLowerCase() ||
          existing.authorityFingerprint !== request.decision.binding.authorityFingerprint
        ) {
          throw new Error(
            `Conflict: deletion key '${request.deletionKey}' was already used for a different file or authority binding`,
          );
        }

        // Exact retry after completion converges on original terminal receipt without repeating effects.
        if (existing.status === "completed") {
          return existing;
        }
      }

      // 2. Fetch canonical file metadata.
      let fileRecord: FileRecord | null = null;
      try {
        fileRecord = await metadataStore.getFileRecord(request.fileId);
      } catch (error) {
        throw new Error(
          `Failed to load file metadata: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (fileRecord === null) {
        throw new Error(`File '${request.fileId}' not found`);
      }

      if (
        request.organizationId !== undefined &&
        request.organizationId.toLowerCase() !== fileRecord.organizationId.toLowerCase()
      ) {
        throw new Error(
          `Organisation mismatch: request specified '${request.organizationId}', file belongs to '${fileRecord.organizationId}'`,
        );
      }

      // If not already removed, verify the lifecycle transition to 'removed' is valid.
      if (
        fileRecord.lifecycleState !== "removed" &&
        !isValidFileLifecycleTransition(fileRecord.lifecycleState, "removed")
      ) {
        throw new Error(
          `Cannot remove file '${request.fileId}': invalid lifecycle state '${fileRecord.lifecycleState}' for removal`,
        );
      }

      // 3. Initialize or resume stage state.
      let completedStages: FileRemovalStage[] = [];
      let remainingStages: FileRemovalStage[] = [...ALL_REMOVAL_STAGES];

      if (existing !== null && existing.status !== "completed") {
        // Resuming from interrupted state.
        completedStages = [...existing.completedStages];
        remainingStages = [...existing.remainingStages];
      } else {
        // Record initial durable removal intent before executing side-effects.
        const initialPartialState: FileObjectRemovalPartialState =
          fileObjectRemovalPartialStateSchema.parse({
            fileId: fileRecord.fileId,
            organizationId: fileRecord.organizationId,
            deletionKey: request.deletionKey,
            status: "in_progress",
            completedStages,
            remainingStages,
            authorityFingerprint: request.decision.binding.authorityFingerprint,
            startedAt: nowIso,
            updatedAt: nowIso,
          });
        try {
          await stateStore.savePartial(initialPartialState);
        } catch (error) {
          throw new Error(
            `Failed to persist removal intent: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const recordInterruption = async (): Promise<FileObjectRemovalPartialState> => {
        let updateNowIso: string;
        try {
          updateNowIso = clock().toISOString();
        } catch {
          updateNowIso = new Date().toISOString();
        }
        const interruptedState: FileObjectRemovalPartialState =
          fileObjectRemovalPartialStateSchema.parse({
            fileId: fileRecord.fileId,
            organizationId: fileRecord.organizationId,
            deletionKey: request.deletionKey,
            status: "interrupted",
            completedStages: [...completedStages],
            remainingStages: [...remainingStages],
            authorityFingerprint: request.decision.binding.authorityFingerprint,
            startedAt: existing?.startedAt ?? nowIso,
            updatedAt: updateNowIso,
          });
        try {
          await stateStore.savePartial(interruptedState);
        } catch {
          // In case stateStore fails during interruption recording, return the assembled state.
        }
        return Object.freeze(interruptedState);
      };

      // Stage 1: Previews and active derived copies
      if (remainingStages.includes("previews")) {
        if (
          previewDeleter !== undefined &&
          fileRecord.previewReferences.length > 0
        ) {
          try {
            await previewDeleter.deletePreviews({
              organizationId: fileRecord.organizationId,
              fileId: fileRecord.fileId,
              previewReferences: fileRecord.previewReferences,
            });
          } catch {
            return await recordInterruption();
          }
        }
        completedStages = Array.from(new Set([...completedStages, "previews"]));
        remainingStages = remainingStages.filter((stage) => stage !== "previews");
        try {
          await stateStore.savePartial(
            fileObjectRemovalPartialStateSchema.parse({
              fileId: fileRecord.fileId,
              organizationId: fileRecord.organizationId,
              deletionKey: request.deletionKey,
              status: "in_progress",
              completedStages: [...completedStages],
              remainingStages: [...remainingStages],
              authorityFingerprint: request.decision.binding.authorityFingerprint,
              startedAt: existing?.startedAt ?? nowIso,
              updatedAt: clock().toISOString(),
            }),
          );
        } catch {
          return await recordInterruption();
        }
      }

      // Stage 2: Private storage object
      if (remainingStages.includes("storage_object")) {
        try {
          await storageDeleter.deleteObject({
            organizationId: fileRecord.organizationId,
            bucketId: fileRecord.bucketId,
            objectPath: fileRecord.storageKey,
          });
        } catch {
          return await recordInterruption();
        }
        completedStages = Array.from(new Set([...completedStages, "storage_object"]));
        remainingStages = remainingStages.filter((stage) => stage !== "storage_object");
        try {
          await stateStore.savePartial(
            fileObjectRemovalPartialStateSchema.parse({
              fileId: fileRecord.fileId,
              organizationId: fileRecord.organizationId,
              deletionKey: request.deletionKey,
              status: "in_progress",
              completedStages: [...completedStages],
              remainingStages: [...remainingStages],
              authorityFingerprint: request.decision.binding.authorityFingerprint,
              startedAt: existing?.startedAt ?? nowIso,
              updatedAt: clock().toISOString(),
            }),
          );
        } catch {
          return await recordInterruption();
        }
      }

      // Stage 3: File metadata tombstone transition
      if (remainingStages.includes("metadata")) {
        try {
          if (fileRecord.lifecycleState !== "removed") {
            const transitioned = transitionFileLifecycleState(
              fileRecord,
              "removed",
              { clock },
            );
            const tombstoneRecord: FileRecord = {
              ...transitioned,
              previewReferences: [],
            };
            await metadataStore.updateFileRecord(tombstoneRecord);
          }
        } catch {
          return await recordInterruption();
        }
        completedStages = Array.from(new Set([...completedStages, "metadata"]));
        remainingStages = remainingStages.filter((stage) => stage !== "metadata");
      }

      // 4. Produce terminal receipt once all owned stages are complete
      let completedTime: string;
      try {
        completedTime = clock().toISOString();
      } catch {
        completedTime = new Date().toISOString();
      }

      const terminalReceipt: FileObjectRemovalReceipt =
        fileObjectRemovalReceiptSchema.parse({
          receiptId: idGenerator(),
          fileId: fileRecord.fileId,
          organizationId: fileRecord.organizationId,
          deletionKey: request.deletionKey,
          status: "completed",
          outcome: fileRecord.lifecycleState === "removed" ? "already_removed" : "removed",
          completedStages: ALL_REMOVAL_STAGES,
          authorityFingerprint: request.decision.binding.authorityFingerprint,
          completedAt: completedTime,
        });

      try {
        await stateStore.saveTerminal(terminalReceipt);
      } catch (error) {
        throw new Error(
          `Failed to persist terminal removal receipt: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      return Object.freeze(terminalReceipt);
    },
  });
};

export const createFileRemovalCoordinator = createFileObjectRemovalCoordinator;
