import "server-only";

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getIdentityJourneyConfiguration } from "./authority-configuration";
import {
  createSessionCookieStage,
  identitySessionCookieProfile,
  type SessionCookie,
  type SessionCookieProfile,
} from "./session-cookie";

export type IdentitySessionClient = Readonly<{
  client: SupabaseClient;
  profile: SessionCookieProfile;
  stage: ReturnType<typeof createSessionCookieStage>;
}>;

export const createIdentitySessionClient = (
  initialCookies: readonly SessionCookie[],
): IdentitySessionClient => {
  const configuration = getIdentityJourneyConfiguration();
  const profile = identitySessionCookieProfile(configuration.siteUrl);
  const stage = createSessionCookieStage(initialCookies, profile);
  const client = createServerClient(configuration.supabaseUrl, configuration.publishableKey, {
    cookieOptions: {
      name: profile.name,
      secure: profile.secure,
      httpOnly: profile.httpOnly,
      sameSite: profile.sameSite,
      path: profile.path,
      priority: profile.priority,
    },
    cookieEncoding: "base64url",
    cookies: {
      encode: "tokens-only",
      getAll: stage.getAll,
      setAll: stage.setAll,
    },
  });
  return { client, profile, stage };
};
