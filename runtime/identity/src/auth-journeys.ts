import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const MINIMUM_PASSWORD_LENGTH = 8;

export type IdentityJourneyConfiguration = Readonly<{
  supabaseUrl: string;
  publishableKey: string;
  siteUrl: string;
}>;

export type IdentityJourneyFailure =
  | "vortex.identity.invalid_input"
  | "vortex.identity.invalid_credentials"
  | "vortex.identity.invalid_or_expired_link"
  | "vortex.identity.authority_unavailable";

export type IdentityJourneyResult =
  Readonly<{ ok: true }> | Readonly<{ ok: false; code: IdentityJourneyFailure }>;

export type VerifiedSignInResult =
  | Readonly<{ ok: true; accessToken: string }>
  | Readonly<{ ok: false; code: IdentityJourneyFailure }>;

const validUrl = (value: string, allowLoopback: boolean): URL => {
  const url = new URL(value);
  const isLoopback =
    allowLoopback &&
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);

  if (
    (!isLoopback && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("Invalid Identity Authority URL");
  }

  return url;
};

const validateConfiguration = (configuration: IdentityJourneyConfiguration) => {
  validUrl(configuration.supabaseUrl, true);
  const siteUrl = validUrl(configuration.siteUrl, true);
  const isPublishableKey = configuration.publishableKey.startsWith("sb_publishable_");

  if (!isPublishableKey) {
    throw new Error("Identity Authority requires a public API key");
  }

  if (
    configuration.publishableKey.startsWith("sb_secret_") ||
    configuration.publishableKey.toLowerCase().includes("service_role")
  ) {
    throw new Error("Privileged API keys are not accepted by the Identity Authority journey");
  }

  if (siteUrl.pathname !== "/") {
    throw new Error("Identity Authority site URL must not contain a path");
  }
};

const createAuthorityClient = (configuration: IdentityJourneyConfiguration): SupabaseClient => {
  validateConfiguration(configuration);

  return createClient(configuration.supabaseUrl, configuration.publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
};

const validEmail = (value: string): boolean => value.length <= 320 && EMAIL_PATTERN.test(value);

const validPasswordLength = (value: string): boolean =>
  value.length >= MINIMUM_PASSWORD_LENGTH && value.length <= 1_024;

const validNewPassword = (value: string): boolean =>
  validPasswordLength(value) && /[A-Za-z]/u.test(value) && /\d/u.test(value);

const validAccessToken = (value: string): boolean =>
  value.length >= 64 &&
  value.length <= 8_192 &&
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value);

const validRefreshToken = (value: string): boolean =>
  value.length > 0 && value.length <= 2_048 && !/\s/u.test(value);

const confirmationUrl = (configuration: IdentityJourneyConfiguration): string =>
  new URL("/auth/confirm", configuration.siteUrl).toString();

const updatePasswordUrl = (configuration: IdentityJourneyConfiguration): string =>
  new URL("/auth/update-password", configuration.siteUrl).toString();

export const requestRegistration = async (
  configuration: IdentityJourneyConfiguration,
  email: string,
  password: string,
): Promise<IdentityJourneyResult> => {
  if (!validEmail(email) || !validNewPassword(password)) {
    return { ok: false, code: "vortex.identity.invalid_input" };
  }

  try {
    const authority = createAuthorityClient(configuration);
    await authority.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: confirmationUrl(configuration) },
    });

    // Registration acknowledgement is intentionally neutral. Existing and new addresses
    // receive the same result so this boundary cannot be used for identity discovery.
    return { ok: true };
  } catch {
    return { ok: false, code: "vortex.identity.authority_unavailable" };
  }
};

export const signInWithPassword = async (
  configuration: IdentityJourneyConfiguration,
  email: string,
  password: string,
): Promise<VerifiedSignInResult> => {
  if (!validEmail(email) || !validPasswordLength(password)) {
    return { ok: false, code: "vortex.identity.invalid_input" };
  }

  try {
    const authority = createAuthorityClient(configuration);
    const { data, error } = await authority.auth.signInWithPassword({ email, password });

    if (error || !data.session?.access_token) {
      return { ok: false, code: "vortex.identity.invalid_credentials" };
    }

    return { ok: true, accessToken: data.session.access_token };
  } catch {
    return { ok: false, code: "vortex.identity.authority_unavailable" };
  }
};

export const requestPasswordRecovery = async (
  configuration: IdentityJourneyConfiguration,
  email: string,
): Promise<IdentityJourneyResult> => {
  if (!validEmail(email)) {
    return { ok: false, code: "vortex.identity.invalid_input" };
  }

  try {
    const authority = createAuthorityClient(configuration);
    await authority.auth.resetPasswordForEmail(email, {
      redirectTo: updatePasswordUrl(configuration),
    });
  } catch {
    // Recovery acknowledgement never reveals whether an identity or authority call exists.
  }

  return { ok: true };
};

export const confirmEmail = async (
  configuration: IdentityJourneyConfiguration,
  accessToken: string,
): Promise<IdentityJourneyResult> => {
  if (!validAccessToken(accessToken)) {
    return { ok: false, code: "vortex.identity.invalid_or_expired_link" };
  }

  try {
    const authority = createAuthorityClient(configuration);
    const { error } = await authority.auth.getUser(accessToken);
    return error ? { ok: false, code: "vortex.identity.invalid_or_expired_link" } : { ok: true };
  } catch {
    return { ok: false, code: "vortex.identity.authority_unavailable" };
  }
};

export const completePasswordRecovery = async (
  configuration: IdentityJourneyConfiguration,
  accessToken: string,
  refreshToken: string,
  password: string,
): Promise<IdentityJourneyResult> => {
  if (!validAccessToken(accessToken) || !validRefreshToken(refreshToken)) {
    return { ok: false, code: "vortex.identity.invalid_or_expired_link" };
  }
  if (!validNewPassword(password)) {
    return { ok: false, code: "vortex.identity.invalid_input" };
  }

  try {
    const authority = createAuthorityClient(configuration);
    const { error: sessionError } = await authority.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    if (sessionError) {
      return { ok: false, code: "vortex.identity.invalid_or_expired_link" };
    }

    const { error: updateError } = await authority.auth.updateUser({ password });
    return updateError
      ? { ok: false, code: "vortex.identity.invalid_or_expired_link" }
      : { ok: true };
  } catch {
    return { ok: false, code: "vortex.identity.authority_unavailable" };
  }
};
