import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createIdentityVerifier } from "../src/identity-verifier";

const apiUrl = process.env.VORTEX_LOCAL_AUTH_API_URL;
const publishableKey = process.env.VORTEX_LOCAL_AUTH_PUBLISHABLE_KEY;
const accessToken = process.env.VORTEX_LOCAL_AUTH_ACCESS_TOKEN;
const expectedIdentityId = process.env.VORTEX_LOCAL_AUTH_EXPECTED_IDENTITY_ID;
const expectedEmail = process.env.VORTEX_LOCAL_AUTH_EXPECTED_EMAIL;
const hasLiveProofInput = Boolean(
  apiUrl && publishableKey && accessToken && expectedIdentityId && expectedEmail,
);

describe.runIf(hasLiveProofInput)("Local Vortex identity verification", () => {
  it("projects the live Supabase access token through the Vortex verifier", async () => {
    const verifier = createIdentityVerifier(
      {
        authorityId: "00000000-0000-4000-8000-000000000025",
        environment: "local",
        issuer: `${apiUrl}/auth/v1`,
        jwksUrl: `${apiUrl}/auth/v1/.well-known/jwks.json`,
        audience: "authenticated",
        signingAlgorithm: "ES256",
      },
      publishableKey!,
    );

    await expect(verifier.verifyAccessToken(accessToken!)).resolves.toMatchObject({
      identityId: expectedIdentityId,
      verifiedPrimaryEmail: expectedEmail,
      audience: "authenticated",
    });
  });
});
