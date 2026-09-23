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
  createFileRemovalCoordinator,
  type FilePreviewDeleter,
  type FileRemovalCoordinator,
  type FileRemovalCoordinatorDependencies,
  type FileRemovalRepository,
  type FileRemovalResult,
  type FileStorageDeleter,
} from "./object-removal";
export {
  runUploadCapabilityAdmission,
  type UploadCapabilityAdmissionRequest,
  type UploadCapabilityAdmissionResult,
  type UploadCapabilityReservationPorts,
} from "./upload-capability-admission";
export {
  PENDING_UPLOAD_WINDOW_SECONDS,
  activateUploadedFile,
  completeFileUpload,
  createFileUploadCoordinator,
  createUploadStorageAuthorityResolver,
  renewPendingUpload,
  reservePendingUpload,
  type ClaimedUploadGrant,
  type FileUploadActivationInput,
  type FileUploadActivationResult,
  type FileUploadAdmissionInput,
  type FileUploadAdmissionResult,
  type FileUploadCompletionInput,
  type FileUploadCompletionResult,
  type FileUploadCoordinator,
  type FileUploadCoordinatorDependencies,
  type FileUploadRenewalInput,
  type FileUploadRenewalResult,
  type FileUploadRepository,
  type IsolatedFileScanner,
  type PendingUploadReservation,
  type PendingUploadState,
  type UploadAttachmentSettings,
  type UploadedObjectInspector,
  type UploadedObjectLocation,
} from "./upload";
export {
  cleanupAbandonedPendingObjects,
  composeStorageAuthorityResolvers,
  createDefaultUpstreamStorageReader,
  createFileReadCoordinator,
  createReadStorageAuthorityResolver,
  fileReadRefusalHttpStatus,
  isExecutableOrActiveBrowserContent,
  parseRangeHeader,
  resolveSafeContentDisposition,
  type AbandonedObjectStorageDeleter,
  type ClaimedDownloadGrant,
  type CleanupAbandonedPendingObjectsDependencies,
  type CleanupAbandonedPendingObjectsResult,
  type CurrentReadAuthority,
  type FileAbandonmentCleanupRepository,
  type FilePreviewGenerator,
  type FileReadCoordinator,
  type FileReadCoordinatorDependencies,
  type FileReadPurpose,
  type FileReadRefusal,
  type FileReadRefusalReason,
  type FileReadRequest,
  type FileReadResult,
  type FileReadStreamResponse,
  type ParsedByteRange,
  type RangeParseResult,
  type SharedRecordFileGrant,
  type UpstreamStorageReader,
  type UpstreamStorageReadOptions,
  type UpstreamStorageReadResult,
} from "./read";
