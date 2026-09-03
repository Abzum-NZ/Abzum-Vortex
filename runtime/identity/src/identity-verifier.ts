import "server-only";

import { createClient } from "@supabase/supabase-js";
import {
  identityAuthoritySchema,
  supabaseIdentityClaimsSchema,
  verifiedIdentitySchema,
  type IdentityAuthority,
  type VerifiedIdentity,
} from "@vortex/contracts";
import {
  IdentityVerificationError,
  type IdentityVerificationRefusalCode,
} from "./identity-verification-error";

type ClaimsVerificationResult = {
  data: {
    claims: unknown;
    header: { alg: unknown; kid: unknown };
  } | null;
  error: unknown | null;
};

type IdentityClaimsClient = {
  auth: {
    getClaims(accessToken: string): Promise<ClaimsVerificationResult>;
  };
};

export type IdentityVerifier = Readonly<{
  authority: IdentityAuthority;
  verifyAccessToken(accessToken: string): Promise<VerifiedIdentity>;
}>;

const refuse = (refusalCode: IdentityVerificationRefusalCode): never => {
  throw new IdentityVerificationError(refusalCode);
};

const parseAuthority = (input: unknown): IdentityAuthority => {
  const result = identityAuthoritySchema.safeParse(input);
  if (!result.success) return refuse("vortex.identity.invalid_authority_configuration");
  return result.data;
};

const audienceContains = (audience: string | string[], expected: string): boolean =>
  typeof audience === "string" ? audience === expected : audience.includes(expected);

const projectVerifiedIdentity = (
  authority: IdentityAuthority,
  result: NonNullable<ClaimsVerificationResult["data"]>,
): VerifiedIdentity => {
  if (result.header.alg !== authority.signingAlgorithm)
    return refuse("vortex.identity.unsupported_signing_algorithm");
  if (typeof result.header.kid !== "string" || result.header.kid.trim().length === 0)
    return refuse("vortex.identity.missing_key_identifier");

  const providerEmail =
    typeof result.claims === "object" && result.claims !== null
      ? (result.claims as { email?: unknown }).email
      : undefined;
  if (typeof providerEmail !== "string" || providerEmail.length === 0)
    return refuse("vortex.identity.verified_primary_email_unavailable");

  const parsedClaims = supabaseIdentityClaimsSchema.safeParse(result.claims);
  if (!parsedClaims.success) return refuse("vortex.identity.invalid_claims");
  if (parsedClaims.data.iss !== authority.issuer) return refuse("vortex.identity.untrusted_issuer");
  if (!audienceContains(parsedClaims.data.aud, authority.audience))
    return refuse("vortex.identity.untrusted_audience");

  const verifiedIdentity = verifiedIdentitySchema.safeParse({
    identityId: parsedClaims.data.sub,
    verifiedPrimaryEmail: parsedClaims.data.email,
    issuer: parsedClaims.data.iss,
    audience: authority.audience,
    sessionId: parsedClaims.data.session_id,
    issuedAt: new Date(parsedClaims.data.iat * 1_000).toISOString(),
    expiresAt: new Date(parsedClaims.data.exp * 1_000).toISOString(),
    authenticationStrength: parsedClaims.data.aal === "aal2" ? "multi_factor" : "single_factor",
    keyId: result.header.kid,
  });
  if (!verifiedIdentity.success) return refuse("vortex.identity.invalid_verified_identity");
  return verifiedIdentity.data;
};

/**
 * Internal construction seam used by contract tests. Production callers use
 * createIdentityVerifier, which supplies the official Supabase client.
 */
export const createIdentityVerifierWithClient = (
  authorityInput: unknown,
  client: IdentityClaimsClient,
): IdentityVerifier => {
  const authority = parseAuthority(authorityInput);

  return Object.freeze({
    authority,
    async verifyAccessToken(accessToken: string) {
      if (accessToken.trim().length === 0) return refuse("vortex.identity.missing_access_token");

      let result: ClaimsVerificationResult;
      try {
        result = await client.auth.getClaims(accessToken);
      } catch {
        return refuse("vortex.identity.token_verification_failed");
      }

      if (result.error !== null || result.data === null)
        return refuse("vortex.identity.token_verification_failed");
      return projectVerifiedIdentity(authority, result.data);
    },
  });
};

export const createIdentityVerifier = (
  authorityInput: unknown,
  publishableKey: string,
): IdentityVerifier => {
  const authority = parseAuthority(authorityInput);
  if (publishableKey.trim().length === 0) return refuse("vortex.identity.invalid_public_api_key");

  const client = createClient(new URL(authority.issuer).origin, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return createIdentityVerifierWithClient(authority, client);
};
