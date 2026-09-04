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
  createDefaultIdentitySessionService,
  createIdentitySessionService,
  type IdentitySessionServiceDependencies,
} from "./identity-session";
export {
  createOrganizationAccountStore,
  ensureIdentityProjection,
  readIdentityProjection,
  OrganizationAccountError,
  organizationAccountErrorCodes,
  type CreatedOrganizationInvitation,
  type IdentityProjectionReader,
  type OrganizationAccountErrorCode,
} from "./organization-accounts";
export {
  createOrganizationLauncherService,
  listOrganizationLauncher,
  type OrganizationLauncherServiceDependencies,
} from "./organization-launcher";

export const IdentityService = Object.freeze({
  key: "identity",
  boundary: "@vortex/identity",
});
