import { generateKeyPairSync, sign } from "node:crypto";
import { AuthRetryableFetchError, createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { identityAuthoritySchema } from "@vortex/contracts";
import {
  IdentityVerificationError,
  createIdentityVerifier,
  identityVerificationRefusalCodes,
  isIdentityVerificationRefusalCode,
} from "../src";
import {
  createIdentityVerifierWithClient,
  identityVerifierMaximumClockSkewSeconds,
} from "../src/identity-verifier";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

const testingAuthority = identityAuthoritySchema.parse({
  authorityId: id(1),
  environment: "testing",
  issuer: "https://identity.example.test/auth/v1",
  jwksUrl: "https://identity.example.test/auth/v1/.well-known/jwks.json",
  audience: "authenticated",
  signingAlgorithm: "ES256",
});

const nowSeconds = 1_800_000_000;
const fixedClock = vi.fn(() => new Date(nowSeconds * 1_000));
const verifierOptions = { clock: fixedClock };

const claims = {
  iss: testingAuthority.issuer,
  aud: "authenticated",
  exp: nowSeconds + 3_600,
  iat: nowSeconds - 100,
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
  auth: {
    getClaims: vi.fn(async () => result),
  },
});

const generateSigningKey = (kid: string) => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicJwk = {
    ...publicKey.export({ format: "jwk" }),
    alg: "ES256",
    kid,
    use: "sig",
  };
  return { kid, privateKey, publicJwk };
};

type GeneratedSigningKey = ReturnType<typeof generateSigningKey>;

const encodeJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const signAccessToken = (
  signingKey: GeneratedSigningKey,
  claimOverrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
): string => {
  const header = encodeJson({
    alg: "ES256",
    kid: signingKey.kid,
    typ: "JWT",
    ...headerOverrides,
  });
  const payload = encodeJson({ ...claims, ...claimOverrides });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: signingKey.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
};

const createOfficialClaimsClient = (
  publicKeys: JsonWebKey[],
  customFetch = vi.fn(async () => {
    throw new Error("The in-memory JWKS should avoid an external request");
  }),
) => {
  const client = createClient(
    new URL(testingAuthority.issuer).origin,
    "sb_publishable_identity_verifier_test",
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
      global: { fetch: customFetch },
    },
  );

  return {
    claimsClient: {
      auth: {
        getClaims: (accessToken: string, options: { allowExpired: true }) =>
          client.auth.getClaims(accessToken, { ...options, jwks: { keys: publicKeys } }),
      },
    },
    customFetch,
  };
};

describe("identity token verification", () => {
  it("uses two official clients and one generated ES256 token to derive the same closed identity", async () => {
    const signingKey = generateSigningKey("current-testing-key");
    const token = signAccessToken(signingKey);
    const firstClient = createOfficialClaimsClient([signingKey.publicJwk]);
    const secondClient = createOfficialClaimsClient([signingKey.publicJwk]);
    const first = createIdentityVerifierWithClient(
      testingAuthority,
      firstClient.claimsClient,
      verifierOptions,
    );
    const second = createIdentityVerifierWithClient(
      testingAuthority,
      secondClient.claimsClient,
      verifierOptions,
    );

    const [firstResult, secondResult] = await Promise.all([
      first.verifyAccessToken(token),
      second.verifyAccessToken(token),
    ]);

    expect(firstResult).toEqual(secondResult);
    expect(firstResult).toEqual({
      identityId: claims.sub,
      verifiedPrimaryEmail: claims.email,
      issuer: claims.iss,
      audience: "authenticated",
      sessionId: claims.session_id,
      issuedAt: new Date(claims.iat * 1_000).toISOString(),
      expiresAt: new Date(claims.exp * 1_000).toISOString(),
      authenticationStrength: "single_factor",
      keyId: signingKey.kid,
    });
    expect(firstResult).not.toHaveProperty("role");
    expect(firstResult).not.toHaveProperty("app_metadata");
    expect(firstResult).not.toHaveProperty("user_metadata");
    expect(firstClient.customFetch).not.toHaveBeenCalled();
    expect(secondClient.customFetch).not.toHaveBeenCalled();
  });

  it("pairwise refuses generated tokens issued by every other configured environment", async () => {
    const signingKey = generateSigningKey("shared-test-key");
    const authorities = [
      {
        ...testingAuthority,
        authorityId: id(4),
        environment: "local" as const,
        issuer: "http://127.0.0.1:54321/auth/v1",
        jwksUrl: "http://127.0.0.1:54321/auth/v1/.well-known/jwks.json",
      },
      testingAuthority,
      {
        ...testingAuthority,
        authorityId: id(5),
        environment: "production" as const,
        issuer: "https://identity.example.com/auth/v1",
        jwksUrl: "https://identity.example.com/auth/v1/.well-known/jwks.json",
      },
    ];

    for (const acceptingAuthority of authorities) {
      for (const issuingAuthority of authorities) {
        if (acceptingAuthority.environment === issuingAuthority.environment) continue;
        const { claimsClient, customFetch } = createOfficialClaimsClient([signingKey.publicJwk]);
        const verifier = createIdentityVerifierWithClient(
          acceptingAuthority,
          claimsClient,
          verifierOptions,
        );

        await expect(
          verifier.verifyAccessToken(signAccessToken(signingKey, { iss: issuingAuthority.issuer })),
        ).rejects.toEqual(new IdentityVerificationError("vortex.identity.untrusted_issuer"));
        expect(customFetch).not.toHaveBeenCalled();
      }
    }
  });

  it("refuses a malformed token through the official Supabase client", async () => {
    const signingKey = generateSigningKey("malformed-token-key");
    const { claimsClient, customFetch } = createOfficialClaimsClient([signingKey.publicJwk]);
    const verifier = createIdentityVerifierWithClient(
      testingAuthority,
      claimsClient,
      verifierOptions,
    );

    await expect(verifier.verifyAccessToken("not-a-jwt")).rejects.toEqual(
      new IdentityVerificationError("vortex.identity.token_verification_failed"),
    );
    expect(customFetch).not.toHaveBeenCalled();
  });

  it("refuses an invalid generated ES256 signature without leaking SDK detail", async () => {
    const trustedKey = generateSigningKey("trusted-key");
    const untrustedKey = generateSigningKey("trusted-key");
    const token = signAccessToken(untrustedKey);
    const { claimsClient, customFetch } = createOfficialClaimsClient([trustedKey.publicJwk]);
    const verifier = createIdentityVerifierWithClient(
      testingAuthority,
      claimsClient,
      verifierOptions,
    );

    await expect(verifier.verifyAccessToken(token)).rejects.toEqual(
      new IdentityVerificationError("vortex.identity.token_verification_failed"),
    );
    expect(customFetch).not.toHaveBeenCalled();
  });

  it("refuses an unknown generated signing key through one stable safe class", async () => {
    const trustedKey = generateSigningKey("trusted-key");
    const unknownKey = generateSigningKey("unknown-key");
    let requestCount = 0;
    const customFetch = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1)
        return new Response(JSON.stringify({ keys: [trustedKey.publicJwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      return new Response(JSON.stringify({ code: "bad_jwt", message: "provider detail" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    const { claimsClient } = createOfficialClaimsClient([trustedKey.publicJwk], customFetch);
    const verifier = createIdentityVerifierWithClient(
      testingAuthority,
      claimsClient,
      verifierOptions,
    );

    await expect(verifier.verifyAccessToken(signAccessToken(unknownKey))).rejects.toEqual(
      new IdentityVerificationError("vortex.identity.token_verification_failed"),
    );
    expect(customFetch).toHaveBeenCalled();
  });

  it("accepts old and new generated keys during a rotation overlap", async () => {
    const oldKey = generateSigningKey("old-key");
    const newKey = generateSigningKey("new-key");
    const { claimsClient, customFetch } = createOfficialClaimsClient([
      oldKey.publicJwk,
      newKey.publicJwk,
    ]);
    const verifier = createIdentityVerifierWithClient(
      testingAuthority,
      claimsClient,
      verifierOptions,
    );

    const [oldIdentity, newIdentity] = await Promise.all([
      verifier.verifyAccessToken(signAccessToken(oldKey)),
      verifier.verifyAccessToken(signAccessToken(newKey)),
    ]);

    expect(oldIdentity.identityId).toBe(claims.sub);
    expect(oldIdentity.keyId).toBe(oldKey.kid);
    expect(newIdentity.identityId).toBe(claims.sub);
    expect(newIdentity.keyId).toBe(newKey.kid);
    expect(customFetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "vortex.identity.expired_access_token",
      { iat: nowSeconds - 3_600, exp: nowSeconds - identityVerifierMaximumClockSkewSeconds - 1 },
    ],
    [
      "vortex.identity.not_yet_valid_access_token",
      { nbf: nowSeconds + identityVerifierMaximumClockSkewSeconds + 1 },
    ],
    [
      "vortex.identity.future_issued_access_token",
      { iat: nowSeconds + identityVerifierMaximumClockSkewSeconds + 1 },
    ],
  ] as const)("returns the deterministic temporal refusal %s", async (refusalCode, overrides) => {
    const signingKey = generateSigningKey(`temporal-${refusalCode}`);
    const { claimsClient } = createOfficialClaimsClient([signingKey.publicJwk]);
    const verifier = createIdentityVerifierWithClient(
      testingAuthority,
      claimsClient,
      verifierOptions,
    );

    await expect(
      verifier.verifyAccessToken(signAccessToken(signingKey, overrides)),
    ).rejects.toEqual(new IdentityVerificationError(refusalCode));
  });

  it.each([
    {
      iat: nowSeconds - 3_600,
      exp: nowSeconds - identityVerifierMaximumClockSkewSeconds,
    },
    { nbf: nowSeconds + identityVerifierMaximumClockSkewSeconds },
    {
      iat: nowSeconds + identityVerifierMaximumClockSkewSeconds,
      exp: nowSeconds + 3_600,
    },
  ])("accepts the documented 60-second clock-skew boundary", async (overrides) => {
    const signingKey = generateSigningKey(`boundary-${JSON.stringify(overrides)}`);
    const { claimsClient } = createOfficialClaimsClient([signingKey.publicJwk]);
    const verifier = createIdentityVerifierWithClient(
      testingAuthority,
      claimsClient,
      verifierOptions,
    );

    await expect(
      verifier.verifyAccessToken(signAccessToken(signingKey, overrides)),
    ).resolves.toMatchObject({
      identityId: claims.sub,
      verifiedPrimaryEmail: claims.email,
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
    const client = clientReturning(response);
    const verifier = createIdentityVerifierWithClient(testingAuthority, client, verifierOptions);

    await expect(verifier.verifyAccessToken(token)).rejects.toEqual(
      new IdentityVerificationError(refusalCode),
    );
    if (token.trim().length > 0)
      expect(client.auth.getClaims).toHaveBeenCalledWith(token, { allowExpired: true });
  });

  it("converts SDK, network and clock details into one safe verification refusal", async () => {
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
    const invalidClockClient = clientReturning(accepted());

    for (const verifier of [
      createIdentityVerifierWithClient(testingAuthority, sdkErrorClient, verifierOptions),
      createIdentityVerifierWithClient(testingAuthority, thrownClient, verifierOptions),
      createIdentityVerifierWithClient(testingAuthority, invalidClockClient, {
        clock: () => new Date(Number.NaN),
      }),
    ])
      await expect(verifier.verifyAccessToken("token")).rejects.toEqual(
        new IdentityVerificationError("vortex.identity.token_verification_failed"),
      );
  });

  it("classifies only the SDK's typed retryable fetch failure as authority unavailable", async () => {
    const returned = {
      auth: {
        getClaims: vi.fn(async () => ({
          data: null,
          error: new AuthRetryableFetchError("temporary provider outage", 503),
        })),
      },
    };
    const thrown = {
      auth: {
        getClaims: vi.fn(async () => {
          throw new AuthRetryableFetchError("temporary network outage", 0);
        }),
      },
    };

    for (const client of [returned, thrown])
      await expect(
        createIdentityVerifierWithClient(
          testingAuthority,
          client,
          verifierOptions,
        ).verifyAccessToken("token"),
      ).rejects.toEqual(new IdentityVerificationError("vortex.identity.authority_unavailable"));
  });

  it.each([
    "",
    "publishable-key",
    " sb_publishable_surrounding_whitespace ",
    "sb_publishable_",
    "sb_secret_server_only_key",
    "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature",
  ])("rejects non-publishable API key material", (apiKey) => {
    expect(() => createIdentityVerifier(testingAuthority, apiKey)).toThrowError(
      "vortex.identity.invalid_public_api_key",
    );
  });

  it("accepts current hosted and Local publishable-key contracts", () => {
    const localAuthority = identityAuthoritySchema.parse({
      ...testingAuthority,
      environment: "local",
      issuer: "http://127.0.0.1:54321/auth/v1",
      jwksUrl: "http://127.0.0.1:54321/auth/v1/.well-known/jwks.json",
    });

    expect(
      createIdentityVerifier(testingAuthority, "sb_publishable_hosted_test_key").authority,
    ).toEqual(testingAuthority);
    expect(
      createIdentityVerifier(localAuthority, "sb_publishable_local_cli_test_key").authority,
    ).toEqual(localAuthority);
  });

  it.each([
    {
      issuer: "https://user:password@identity.example.test/auth/v1",
      jwksUrl: "https://user:password@identity.example.test/auth/v1/.well-known/jwks.json",
    },
    {
      jwksUrl: "https://user:password@identity.example.test/auth/v1/.well-known/jwks.json",
    },
    { issuer: "https://identity.example.test/auth/v1?environment=testing" },
    { issuer: "https://identity.example.test/auth/v1#testing" },
    {
      jwksUrl: "https://identity.example.test/auth/v1/.well-known/jwks.json?environment=testing",
    },
    { jwksUrl: "https://identity.example.test/auth/v1/.well-known/jwks.json#testing" },
  ])("rejects authority URL credentials, queries and fragments", (overrides) => {
    expect(() =>
      createIdentityVerifierWithClient(
        { ...testingAuthority, ...overrides },
        clientReturning(accepted()),
        verifierOptions,
      ),
    ).toThrowError("vortex.identity.invalid_authority_configuration");
  });

  it("rejects a non-standard JWKS URL instead of silently ignoring it", () => {
    expect(() =>
      createIdentityVerifierWithClient(
        { ...testingAuthority, jwksUrl: "https://identity.example.test/keys.json" },
        clientReturning(accepted()),
        verifierOptions,
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
