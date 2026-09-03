import { describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

import { IdentityVerificationError } from "../src/identity-verification-error";
import { createIdentityVerifier, createIdentityVerifierWithClient } from "../src/identity-verifier";

const testingApiUrl = process.env.VORTEX_TESTING_AUTH_API_URL;
const testingPublishableKey = process.env.VORTEX_TESTING_AUTH_PUBLISHABLE_KEY;
const testingAccessToken = process.env.VORTEX_TESTING_AUTH_ACCESS_TOKEN;
const expectedIdentityId = process.env.VORTEX_TESTING_AUTH_EXPECTED_IDENTITY_ID;
const expectedEmail = process.env.VORTEX_TESTING_AUTH_EXPECTED_EMAIL;
const productionApiUrl = process.env.VORTEX_PRODUCTION_AUTH_API_URL;
const hasLiveProofInput = Boolean(
  testingApiUrl &&
  testingPublishableKey &&
  testingAccessToken &&
  expectedIdentityId &&
  expectedEmail &&
  productionApiUrl,
);

describe.runIf(hasLiveProofInput)("Hosted Testing Vortex identity verification", () => {
  const testingAuthority = {
    authorityId: "00000000-0000-4000-8000-000000000025",
    environment: "testing" as const,
    issuer: `${testingApiUrl}/auth/v1`,
    jwksUrl: `${testingApiUrl}/auth/v1/.well-known/jwks.json`,
    audience: "authenticated",
    signingAlgorithm: "ES256" as const,
  };

  it("projects one live Testing token identically through independent verifier instances", async () => {
    const firstVerifier = createIdentityVerifier(testingAuthority, testingPublishableKey!);
    const secondVerifier = createIdentityVerifier(testingAuthority, testingPublishableKey!);

    const [first, second] = await Promise.all([
      firstVerifier.verifyAccessToken(testingAccessToken!),
      secondVerifier.verifyAccessToken(testingAccessToken!),
    ]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      identityId: expectedIdentityId,
      verifiedPrimaryEmail: expectedEmail,
      audience: "authenticated",
      issuer: testingAuthority.issuer,
    });
  });

  it("refuses the Testing token at the Production authority boundary", async () => {
    const testingClaimsClient = createClient(testingApiUrl!, testingPublishableKey!, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    });
    const productionVerifier = createIdentityVerifierWithClient(
      {
        ...testingAuthority,
        environment: "production",
        issuer: `${productionApiUrl}/auth/v1`,
        jwksUrl: `${productionApiUrl}/auth/v1/.well-known/jwks.json`,
      },
      testingClaimsClient,
    );

    await expect(productionVerifier.verifyAccessToken(testingAccessToken!)).rejects.toEqual(
      new IdentityVerificationError("vortex.identity.untrusted_issuer"),
    );
  });
});
