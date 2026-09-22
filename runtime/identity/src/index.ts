import "server-only";

export * from "./identity-verification-error";
export {
  completePasswordRecovery,
  confirmEmail,
  requestPasswordRecovery,
  requestRegistration,
  signInWithPassword,
  type IdentityJourneyConfiguration,
  type IdentityJourneyFailure,
  type IdentityJourneyResult,
  type VerifiedSignInResult,
} from "./auth-journeys";
export { createIdentityVerifier, type IdentityVerifier } from "./identity-verifier";
export {
  adoptOrganization,
  adoptTenant,
  closeClusterIdentity,
  createConfiguredTenantAdministrationService,
  provisionTenant,
  reactivateClusterIdentity,
  reactivateTenant,
  suspendClusterIdentity,
  suspendTenant,
  type ConfiguredTenantAdministrationDependencies,
} from "./configured-tenant-administration";
export {
  createDefaultIdentitySessionService,
  createIdentitySessionService,
  type IdentitySessionServiceDependencies,
} from "./identity-session";
export {
  createOrganizationAccountStore,
  ensureIdentityProjection,
  readIdentityProjection,
  listOffboardingOwnedRecords,
  transferOffboardingOwnedRecords,
  OrganizationAccountError,
  organizationAccountErrorCodes,
  type CreatedOrganizationInvitation,
  type IdentityProjectionReader,
  type OrganizationAccountErrorCode,
  type OffboardingApplicationPageCount,
  type OffboardingClassification,
  type OffboardingInstallationState,
  type OffboardingInventoryCursor,
  type OffboardingInventoryPage,
  type OffboardingInventoryQuery,
  type OffboardingInventoryResult,
  type OffboardingInventorySectionKind,
  type OffboardingInventoryTargetKind,
  type OffboardingLifecycleState,
  type OffboardingOwnedRecordItem,
  type OffboardingRecordTypePageCount,
  type OffboardingSectionKind,
  type OffboardingSharedPageImpact,
  type OffboardingStorageScope,
  type OffboardingTransferBatchCommand,
  type OffboardingTransferBatchRecordOutcome,
  type OffboardingTransferBatchRecordResult,
  type OffboardingTransferBatchResult,
} from "./organization-accounts";
export {
  createOrganizationLauncherService,
  listOrganizationLauncher,
  type OrganizationLauncherServiceDependencies,
} from "./organization-launcher";
export {
  createOrganizationRuntimeSettingsStore,
  initializeOrganizationRuntimeSettings,
  stageOrganizationRuntimeSettingsUpdate,
  OrganizationRuntimeSettingsError,
  organizationRuntimeSettingsErrorCodes,
  type OrganizationRuntimeSettingsErrorCode,
  type OrganizationRuntimeSettingsStoreDependencies,
} from "./organization-runtime-settings";
export {
  archiveTenantOrganization,
  changeTenantAdministrator,
  createTenantOrganization,
  createTenantGovernanceService,
  grantTenantAdministrator,
  listTenantAdministratorAssignments,
  listTenantHierarchy,
  listTenantLauncher,
  readTenantOrganization,
  reactivateTenantOrganization,
  renameTenantOrganization,
  reparentTenantOrganization,
  suspendTenantOrganization,
  revokeTenantAdministrator,
  type TenantGovernanceServiceDependencies,
} from "./tenant-governance";

export const IdentityService = Object.freeze({
  key: "identity",
  boundary: "@vortex/identity",
});
