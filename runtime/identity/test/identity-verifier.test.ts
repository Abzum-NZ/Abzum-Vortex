import { describe, expect, it, vi } from "vitest";
import { identityAuthoritySchema } from "@vortex/contracts";
import {
  IdentityVerificationError,
  createIdentityVerifier,
  identityVerificationRefusalCodes,
  isIdentityVerificationRefusalCode,
} from "../src";
import { createIdentityVerifierWithClient } from "../src/identity-verifier";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

const testingAuthority = identityAuthoritySchema.parse({
  authorityId: id(1),
  environment: "testing",
  issuer: "https://identity.example.test/auth/v1",
  jwksUrl: "https://identity.example.test/auth/v1/.well-known/jwks.json",
  audience: "authenticated",
  signingAlgorithm: "ES256",
});

const claims = {
  iss: testingAuthority.issuer,
  aud: "authenticated",
  exp: 1_800_000_000,
  iat: 1_799_996_400,
  sub: id(2),
  role: "authenticated",
  aal: "aal1",
  session_id: id(3),
  email: "person@example.test",
  phone: "",
  is_anonymous: false,
  app_metadata: { provider: "email", invented_role: "administrator" },
  user_metadata: { invented_permission: "everything" },
};

const accepted = (claimOverrides: Record<string, unknown> = {}, headerOverrides = {}) => ({
  data: {
    claims: { ...claims, ...claimOverrides },
    header: { alg: "ES256", kid: "testing-key", typ: "JWT", ...headerOverrides },
    signature: new Uint8Array(),
  },
  error: null,
});

const clientReturning = (result: ReturnType<typeof accepted>) => ({
  auth: { getClaims: vi.fn(async () => result) },
});

describe("identity token verification", () => {
  it("uses two independently configured verifiers to produce the same closed identity", async () => {
    const firstClient = clientReturning(accepted());
    const secondClient = clientReturning(accepted());
    const first = createIdentityVerifierWithClient({ ...testingAuthority }, firstClient);
    const second = createIdentityVerifierWithClient({ ...testingAuthority }, secondClient);

    const [firstResult, secondResult] = await Promise.all([
      first.verifyAccessToken("same-testing-token"),
      second.verifyAccessToken("same-testing-token"),
    ]);

    expect(firstResult).toEqual(secondResult);
    expect(firstResult).toEqual({
      identityId: claims.sub,
      verifiedPrimaryEmail: claims.email,
      issuer: claims.iss,
      audience: "authenticated",
      sessionId: claims.session_id,
      issuedAt: "2027-01-15T07:00:00.000Z",
      expiresAt: "2027-01-15T08:00:00.000Z",
      authenticationStrength: "single_factor",
      keyId: "testing-key",
    });
    expect(firstResult).not.toHaveProperty("role");
    expect(firstResult).not.toHaveProperty("app_metadata");
    expect(firstResult).not.toHaveProperty("user_metadata");
    expect(firstClient.auth.getClaims).toHaveBeenCalledWith("same-testing-token");
    expect(secondClient.auth.getClaims).toHaveBeenCalledWith("same-testing-token");
  });

  it("refuses a token issued by another environment", async () => {
    const productionAuthority = {
      ...testingAuthority,
      authorityId: id(4),
      environment: "production",
      issuer: "https://identity.example.com/auth/v1",
      jwksUrl: "https://identity.example.com/auth/v1/.well-known/jwks.json",
    };
    const verifier = createIdentityVerifierWithClient(
      productionAuthority,
      clientReturning(accepted()),
    );

    await expect(verifier.verifyAccessToken("testing-token")).rejects.toMatchObject({
      refusalCode: "vortex.identity.untrusted_issuer",
    });
  });

  it.each([
    ["vortex.identity.missing_access_token", "", accepted()],
    ["vortex.identity.missing_access_token", "   ", accepted()],
    ["vortex.identity.unsupported_signing_algorithm", "token", accepted({}, { alg: "RS256" })],
    ["vortex.identity.missing_key_identifier", "token", accepted({}, { kid: "" })],
    ["vortex.identity.missing_key_identifier", "token", accepted({}, { kid: "   " })],
    ["vortex.identity.verified_primary_email_unavailable", "token", accepted({ email: undefined })],
    ["vortex.identity.invalid_claims", "token", accepted({ is_anonymous: true })],
    ["vortex.identity.untrusted_audience", "token", accepted({ aud: "another-audience" })],
  ] as const)("returns the safe refusal %s", async (refusalCode, token, response) => {
    const verifier = createIdentityVerifierWithClient(testingAuthority, clientReturning(response));

    await expect(verifier.verifyAccessToken(token)).rejects.toEqual(
      new IdentityVerificationError(refusalCode),
    );
  });

  it("converts SDK errors and thrown details into one safe verification refusal", async () => {
    const sdkErrorClient = {
      auth: {
        getClaims: vi.fn(async () => ({
          data: null,
          error: new Error("provider detail must not cross the boundary"),
        })),
      },
    };
    const thrownClient = {
      auth: {
        getClaims: vi.fn(async () => {
          throw new Error("network detail must not cross the boundary");
        }),
      },
    };

    for (const client of [sdkErrorClient, thrownClient]) {
      const verifier = createIdentityVerifierWithClient(testingAuthority, client);
      await expect(verifier.verifyAccessToken("token")).rejects.toEqual(
        new IdentityVerificationError("vortex.identity.token_verification_failed"),
      );
    }
  });

  it("constructs only from valid Supabase authority and public-key configuration", () => {
    expect(createIdentityVerifier(testingAuthority, "publishable-key").authority).toEqual(
      testingAuthority,
    );
    expect(() => createIdentityVerifier(testingAuthority, "")).toThrowError(
      "vortex.identity.invalid_public_api_key",
    );
    expect(() =>
      createIdentityVerifier(
        { ...testingAuthority, issuer: "https://identity.example.test" },
        "key",
      ),
    ).toThrowError("vortex.identity.invalid_authority_configuration");
  });

  it("keeps every refusal inside the closed catalogue", () => {
    expect(new Set(identityVerificationRefusalCodes).size).toBe(
      identityVerificationRefusalCodes.length,
    );
    expect(identityVerificationRefusalCodes.every(isIdentityVerificationRefusalCode)).toBe(true);
    expect(isIdentityVerificationRefusalCode("vortex.identity.provider_internal_detail")).toBe(
      false,
    );
  });
});
