import "server-only";

import {
  identityAuthoritySchema,
  isLoopbackHostname,
  type IdentityAuthority,
} from "@vortex/contracts";
import {
  localDevelopmentSignInAvailable,
  type IdentityJourneyConfiguration,
  type LocalDevelopmentSignInConfiguration,
} from "@vortex/identity";
import { optionalEnvironmentValue, requiredEnvironmentValue } from "../../_lib/server-configuration";

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
  const isLoopback = isLoopbackHostname(siteUrl.hostname);
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

export const getLocalDevelopmentSignInConfiguration = (): LocalDevelopmentSignInConfiguration | undefined => {
  if (optionalEnvironmentValue("VORTEX_LOCAL_DEVELOPMENT_SIGN_IN_ENABLED") !== "true")
    return undefined;
  try {
    const configuration: LocalDevelopmentSignInConfiguration = {
      enabled: true,
      journey: getIdentityJourneyConfiguration(),
      authority: getIdentityAuthorityConfiguration(),
      identityId: requiredEnvironmentValue("VORTEX_LOCAL_DEVELOPMENT_IDENTITY_ID"),
      adminKey: requiredEnvironmentValue("VORTEX_LOCAL_SUPABASE_AUTH_ADMIN_KEY"),
    };
    return localDevelopmentSignInAvailable(configuration) ? configuration : undefined;
  } catch {
    return undefined;
  }
};
