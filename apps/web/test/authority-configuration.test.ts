import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getIdentityAuthorityConfiguration } from "../app/auth/_lib/authority-configuration";

const id = "00000000-0000-4000-8000-000000000025";

const configure = (environment: string, siteUrl: string, supabaseUrl: string) => {
  vi.stubEnv("VORTEX_ENVIRONMENT", environment);
  vi.stubEnv("VORTEX_IDENTITY_AUTHORITY_ID", id);
  vi.stubEnv("VORTEX_SITE_URL", siteUrl);
  vi.stubEnv("VORTEX_SUPABASE_URL", supabaseUrl);
  vi.stubEnv("VORTEX_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test-value");
};

describe("identity authority deployment configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("derives the standard issuer and JWKS endpoint for hosted Testing", () => {
    configure("testing", "https://vortex.example.test", "https://identity.example.test");

    expect(getIdentityAuthorityConfiguration()).toEqual({
      authorityId: id,
      environment: "testing",
      issuer: "https://identity.example.test/auth/v1",
      jwksUrl: "https://identity.example.test/auth/v1/.well-known/jwks.json",
      audience: "authenticated",
      signingAlgorithm: "ES256",
    });
  });

  it("accepts HTTP only for a declared exact Local loopback site", () => {
    configure("local", "http://127.0.0.1:3000", "http://127.0.0.1:54321");
    expect(getIdentityAuthorityConfiguration()).toMatchObject({
      environment: "local",
      issuer: "http://127.0.0.1:54321/auth/v1",
    });
  });

  it.each([
    ["testing", "http://127.0.0.1:3000", "http://127.0.0.1:54321"],
    ["local", "https://vortex.example.test", "https://identity.example.test"],
    ["preview", "https://vortex.example.test", "https://identity.example.test"],
  ])("refuses an environment and site mismatch", (environment, siteUrl, supabaseUrl) => {
    configure(environment, siteUrl, supabaseUrl);
    expect(() => getIdentityAuthorityConfiguration()).toThrow();
  });

  it("requires the stable environment-owned authority identifier", () => {
    configure("testing", "https://vortex.example.test", "https://identity.example.test");
    vi.stubEnv("VORTEX_IDENTITY_AUTHORITY_ID", "");
    expect(() => getIdentityAuthorityConfiguration()).toThrow(
      "Missing required server configuration: VORTEX_IDENTITY_AUTHORITY_ID",
    );
  });
});
