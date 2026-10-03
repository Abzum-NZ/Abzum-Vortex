import "server-only";

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { IdentityVerificationExecution } from "@vortex/identity";
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
  verificationRefused(): boolean;
}>;

export const createIdentitySessionClient = (
  initialCookies: readonly SessionCookie[],
  options: Readonly<{ verificationOnly?: boolean; execution?: IdentityVerificationExecution }> = {},
): IdentitySessionClient => {
  const configuration = getIdentityJourneyConfiguration();
  const profile = identitySessionCookieProfile(configuration.siteUrl);
  const stage = createSessionCookieStage(initialCookies, profile);
  let refused = false;
  const verificationFetch: typeof fetch = async (input, init) => {
    const staged = stage.snapshot();
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (stage.initialState.kind !== "valid" || staged.refused || staged.mutations.length > 0 ||
        method.toUpperCase() !== "GET" || url.origin !== new URL(configuration.supabaseUrl).origin ||
        (url.pathname !== "/auth/v1/user" && url.pathname !== "/auth/v1/.well-known/jwks.json") ||
        url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
      // A finite provider refusal prevents the SDK from retrying refresh with backoff.
      // This irrevocable flag also refuses an SDK fallback to its old access token.
      refused = true;
      return new Response(JSON.stringify({ code: "verification_only", message: "Unavailable" }),
        { status: 400, headers: { "Content-Type": "application/json" } });
    }
    options.execution?.checkpoint();
    const result = await (options.execution?.fetch ?? fetch)(input, init);
    options.execution?.checkpoint();
    return result;
  };
  const client = createServerClient(configuration.supabaseUrl, configuration.publishableKey, {
    ...(options.verificationOnly ? { global: { fetch: verificationFetch } } : {}),
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
  return { client, profile, stage, verificationRefused: () => refused };
};
