import "server-only";

import { createClient, isAuthRetryableFetchError } from "@supabase/supabase-js";
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

type ClaimsVerificationOptions = Readonly<{
  allowExpired: true;
}>;

type IdentityClaimsClient = {
  auth: {
    getClaims(
      accessToken: string,
      options: ClaimsVerificationOptions,
    ): Promise<ClaimsVerificationResult>;
  };
};

type IdentityVerifierOptions = Readonly<{
  clock?: () => Date;
}>;

export const identityVerifierMaximumClockSkewSeconds = 60;

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

  const issuer = new URL(result.data.issuer);
  const jwks = new URL(result.data.jwksUrl);
  if (
    issuer.username.length > 0 ||
    issuer.password.length > 0 ||
    issuer.search.length > 0 ||
    issuer.hash.length > 0 ||
    jwks.username.length > 0 ||
    jwks.password.length > 0 ||
    jwks.search.length > 0 ||
    jwks.hash.length > 0
  )
    return refuse("vortex.identity.invalid_authority_configuration");

  return result.data;
};

const parsePublishableKey = (input: string): string => {
  if (input.length > 512 || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(input))
    return refuse("vortex.identity.invalid_public_api_key");
  return input;
};

const audienceContains = (audience: string | string[], expected: string): boolean =>
  typeof audience === "string" ? audience === expected : audience.includes(expected);

const primaryAuthenticationMethods = new Set(["password", "magiclink"]);
const multiFactorAuthenticationMethods = new Set(["totp", "mfa/phone", "mfa/webauthn"]);

const authenticationEvidence = (
  claims: ReturnType<typeof supabaseIdentityClaimsSchema.parse>,
  nowSeconds: number,
): Readonly<{
  primaryAuthenticatedAt?: string;
  multiFactorAuthenticatedAt?: string;
}> => {
  if (claims.amr === undefined || claims.amr.every((entry) => typeof entry === "string")) return {};

  let primaryAuthenticatedAt: number | undefined;
  let multiFactorAuthenticatedAt: number | undefined;
  for (const entry of claims.amr) {
    if (typeof entry === "string") continue;
    if (entry.timestamp > claims.iat || entry.timestamp > nowSeconds) continue;

    if (primaryAuthenticationMethods.has(entry.method))
      primaryAuthenticatedAt = Math.max(primaryAuthenticatedAt ?? 0, entry.timestamp);

    if (claims.aal === "aal2" && multiFactorAuthenticationMethods.has(entry.method))
      multiFactorAuthenticatedAt = Math.max(multiFactorAuthenticatedAt ?? 0, entry.timestamp);
  }

  return {
    ...(primaryAuthenticatedAt === undefined
      ? {}
      : { primaryAuthenticatedAt: new Date(primaryAuthenticatedAt * 1_000).toISOString() }),
    ...(multiFactorAuthenticatedAt === undefined
      ? {}
      : {
          multiFactorAuthenticatedAt: new Date(multiFactorAuthenticatedAt * 1_000).toISOString(),
        }),
  };
};

const projectVerifiedIdentity = (
  authority: IdentityAuthority,
  result: NonNullable<ClaimsVerificationResult["data"]>,
  clock: () => Date,
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

  let nowSeconds: number;
  try {
    nowSeconds = clock().getTime() / 1_000;
  } catch {
    return refuse("vortex.identity.token_verification_failed");
  }
  if (!Number.isFinite(nowSeconds)) return refuse("vortex.identity.token_verification_failed");

  const latestAcceptedFutureTime = nowSeconds + identityVerifierMaximumClockSkewSeconds;
  const earliestAcceptedExpiry = nowSeconds - identityVerifierMaximumClockSkewSeconds;
  if (parsedClaims.data.exp < earliestAcceptedExpiry)
    return refuse("vortex.identity.expired_access_token");
  if (parsedClaims.data.nbf !== undefined && parsedClaims.data.nbf > latestAcceptedFutureTime)
    return refuse("vortex.identity.not_yet_valid_access_token");
  if (parsedClaims.data.iat > latestAcceptedFutureTime)
    return refuse("vortex.identity.future_issued_access_token");

  const verifiedIdentity = verifiedIdentitySchema.safeParse({
    identityId: parsedClaims.data.sub,
    verifiedPrimaryEmail: parsedClaims.data.email,
    issuer: parsedClaims.data.iss,
    audience: authority.audience,
    sessionId: parsedClaims.data.session_id,
    issuedAt: new Date(parsedClaims.data.iat * 1_000).toISOString(),
    expiresAt: new Date(parsedClaims.data.exp * 1_000).toISOString(),
    authenticationStrength: parsedClaims.data.aal === "aal2" ? "multi_factor" : "single_factor",
    ...authenticationEvidence(parsedClaims.data, nowSeconds),
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
  options: IdentityVerifierOptions = {},
): IdentityVerifier => {
  const authority = parseAuthority(authorityInput);
  const clock = options.clock ?? (() => new Date());

  return Object.freeze({
    authority,
    async verifyAccessToken(accessToken: string) {
      if (accessToken.trim().length === 0) return refuse("vortex.identity.missing_access_token");

      let result: ClaimsVerificationResult;
      try {
        // `jwksUrl` remains explicit authority evidence and is constrained by the
        // contract to Supabase's standard discovery path. The official client
        // derives and fetches that same path from the issuer origin. We allow the
        // SDK to skip only its zero-skew expiry check so this boundary can apply
        // one deterministic, bounded clock policy after signature verification.
        result = await client.auth.getClaims(accessToken, { allowExpired: true });
      } catch (error) {
        return refuse(
          isAuthRetryableFetchError(error)
            ? "vortex.identity.authority_unavailable"
            : "vortex.identity.token_verification_failed",
        );
      }

      if (result.error !== null || result.data === null)
        return refuse(
          isAuthRetryableFetchError(result.error)
            ? "vortex.identity.authority_unavailable"
            : "vortex.identity.token_verification_failed",
        );
      return projectVerifiedIdentity(authority, result.data, clock);
    },
  });
};

export const createIdentityVerifier = (
  authorityInput: unknown,
  publishableKey: string,
  options: IdentityVerifierOptions = {},
): IdentityVerifier => {
  const authority = parseAuthority(authorityInput);
  const publicApiKey = parsePublishableKey(publishableKey);

  const client = createClient(new URL(authority.issuer).origin, publicApiKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return createIdentityVerifierWithClient(authority, client, options);
};
