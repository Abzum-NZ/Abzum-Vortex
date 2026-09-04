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
  acceptInvitation,
  createOrganizationAccountStore,
  ensureIdentityProjection,
  listOrganizationAccounts,
  OrganizationAccountError,
  organizationAccountErrorCodes,
  type CreatedOrganizationInvitation,
  type InvitationAcceptanceResult,
  type OrganizationAccountErrorCode,
} from "./organization-accounts";

export const IdentityService = Object.freeze({
  key: "identity",
  boundary: "@vortex/identity",
});
