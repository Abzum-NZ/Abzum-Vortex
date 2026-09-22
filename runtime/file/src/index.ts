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
