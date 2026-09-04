import "server-only";

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
