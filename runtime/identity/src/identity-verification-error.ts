export const identityVerificationRefusalCodes = Object.freeze([
  "vortex.identity.invalid_authority_configuration",
  "vortex.identity.invalid_public_api_key",
  "vortex.identity.missing_access_token",
  "vortex.identity.token_verification_failed",
  "vortex.identity.authority_unavailable",
  "vortex.identity.unsupported_signing_algorithm",
  "vortex.identity.missing_key_identifier",
  "vortex.identity.invalid_claims",
  "vortex.identity.untrusted_issuer",
  "vortex.identity.untrusted_audience",
  "vortex.identity.expired_access_token",
  "vortex.identity.not_yet_valid_access_token",
  "vortex.identity.future_issued_access_token",
  "vortex.identity.verified_primary_email_unavailable",
  "vortex.identity.invalid_verified_identity",
] as const);

export type IdentityVerificationRefusalCode = (typeof identityVerificationRefusalCodes)[number];

const identityVerificationRefusalCodeSet: ReadonlySet<string> = new Set(
  identityVerificationRefusalCodes,
);

export const isIdentityVerificationRefusalCode = (
  value: string,
): value is IdentityVerificationRefusalCode => identityVerificationRefusalCodeSet.has(value);

export class IdentityVerificationError extends Error {
  readonly refusalCode: IdentityVerificationRefusalCode;

  constructor(refusalCode: IdentityVerificationRefusalCode) {
    super(refusalCode);
    this.name = "IdentityVerificationError";
    this.refusalCode = refusalCode;
  }
}
