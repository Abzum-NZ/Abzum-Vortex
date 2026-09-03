import "server-only";

export * from "./identity-verification-error";
export { createIdentityVerifier, type IdentityVerifier } from "./identity-verifier";

export const IdentityService = Object.freeze({
  key: "identity",
  boundary: "@vortex/identity",
});
