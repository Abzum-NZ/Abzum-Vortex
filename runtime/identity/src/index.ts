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

export const IdentityService = Object.freeze({
  key: "identity",
  boundary: "@vortex/identity",
});
