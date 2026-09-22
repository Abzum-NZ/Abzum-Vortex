import "server-only";

export const FileService = Object.freeze({
  key: "file",
  boundary: "@vortex/file",
});

export * from "./file-metadata";
export * from "./storage-policy";
export * from "./content-safety";
export * from "./attachment-authority";
export * from "./storage-credentials";
export {
  createFileRemovalEligibilityService,
  matchesProtectedLegalHold,
  type FileHoldEvaluationScope,
  type FileRemovalAuthorityResolution,
  type FileRemovalEligibilityDecision,
  type FileRemovalEligibilityRequest,
  type FileRemovalEligibilityService,
  type FileRemovalRefusalReason,
  type ResolveCurrentFileRemovalAuthority,
} from "./removal-eligibility";
export {
  createFileObjectRemovalCoordinator,
  createFileRemovalCoordinator,
  createInMemoryFileRemovalStateStore,
  type FileMetadataStore,
  type FileObjectRemovalCoordinator,
  type FileObjectRemovalCoordinatorDependencies,
  type FileObjectRemovalResult,
  type FilePreviewDeleter,
  type FileRemovalCoordinator,
  type FileRemovalCoordinatorDependencies,
  type FileRemovalPersistedRecord,
  type FileRemovalResult,
  type FileRemovalStateStore,
  type FileStorageDeleter,
} from "./object-removal";
