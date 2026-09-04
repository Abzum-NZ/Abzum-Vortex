import "server-only";

import { identityAuthoritySchema, type IdentityAuthority } from "@vortex/contracts";
import type { IdentityJourneyConfiguration } from "@vortex/identity";

const requiredEnvironmentValue = (name: string): string => {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required server configuration: ${name}`);
  }
  return value;
};

export const getIdentityJourneyConfiguration = (): IdentityJourneyConfiguration => ({
  supabaseUrl: requiredEnvironmentValue("VORTEX_SUPABASE_URL"),
  publishableKey: requiredEnvironmentValue("VORTEX_SUPABASE_PUBLISHABLE_KEY"),
  siteUrl: requiredEnvironmentValue("VORTEX_SITE_URL"),
});

export const getIdentityAuthorityConfiguration = (): IdentityAuthority => {
  const journey = getIdentityJourneyConfiguration();
  const environment = requiredEnvironmentValue("VORTEX_ENVIRONMENT");
  const authorityUrl = new URL(journey.supabaseUrl);
  const siteUrl = new URL(journey.siteUrl);
  const isLoopback = ["127.0.0.1", "localhost", "[::1]"].includes(siteUrl.hostname);
  if (
    (environment === "local" && (siteUrl.protocol !== "http:" || !isLoopback)) ||
    (environment !== "local" && siteUrl.protocol !== "https:")
  )
    throw new Error("Identity environment and site URL do not match");
  const origin = authorityUrl.origin;
  return identityAuthoritySchema.parse({
    authorityId: requiredEnvironmentValue("VORTEX_IDENTITY_AUTHORITY_ID"),
    environment,
    issuer: `${origin}/auth/v1`,
    jwksUrl: `${origin}/auth/v1/.well-known/jwks.json`,
    audience: "authenticated",
    signingAlgorithm: "ES256",
  });
};
