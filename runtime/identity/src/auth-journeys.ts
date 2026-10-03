import "server-only";

import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import {
  identityAuthoritySchema,
  identityIdSchema,
  isLoopbackHostname,
  type IdentityAuthority,
} from "@vortex/contracts";
import { createIdentityVerifier } from "./identity-verifier";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const MINIMUM_PASSWORD_LENGTH = 8;
const EMAIL_OTP_PATTERN = /^\d{6}$/u;

export type IdentityJourneyConfiguration = Readonly<{
  supabaseUrl: string;
  publishableKey: string;
  siteUrl: string;
}>;

/** Explicit server configuration for the existing local development account only. */
export type LocalDevelopmentSignInConfiguration = Readonly<{
  enabled: boolean;
  journey: IdentityJourneyConfiguration;
  authority: IdentityAuthority;
  identityId: string;
  adminKey: string;
}>;

export type IdentityJourneyFailure =
  | "vortex.identity.invalid_input"
  | "vortex.identity.invalid_credentials"
  | "vortex.identity.invalid_or_expired_link"
  | "vortex.identity.authority_unavailable";

export type IdentityJourneyResult =
  Readonly<{ ok: true }> | Readonly<{ ok: false; code: IdentityJourneyFailure }>;

export type VerifiedSignInResult =
  | Readonly<{ ok: true; accessToken: string; refreshToken: string }>
  | Readonly<{ ok: false; code: IdentityJourneyFailure }>;

const validUrl = (value: string, allowLoopback: boolean): URL => {
  const url = new URL(value);
  const isLoopback = allowLoopback && url.protocol === "http:" && isLoopbackHostname(url.hostname);

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

export const localDevelopmentSignInAvailable = (
  configuration: LocalDevelopmentSignInConfiguration,
): boolean => {
  if (process.env.NODE_ENV !== "development" || configuration.enabled !== true) return false;
  try {
    validateConfiguration(configuration.journey);
    const authority = identityAuthoritySchema.safeParse(configuration.authority);
    return (
      authority.success &&
      authority.data.environment === "local" &&
      identityIdSchema.safeParse(configuration.identityId).success &&
      new URL(configuration.journey.siteUrl).href === "http://127.0.0.1:3000/" &&
      new URL(configuration.journey.supabaseUrl).href === "http://127.0.0.1:54321/" &&
      authority.data.issuer === "http://127.0.0.1:54321/auth/v1" &&
      authority.data.jwksUrl === "http://127.0.0.1:54321/auth/v1/.well-known/jwks.json" &&
      configuration.adminKey.length <= 512 &&
      /^sb_secret_[A-Za-z0-9_-]+$/u.test(configuration.adminKey)
    );
  } catch {
    return false;
  }
};

type ConfirmedLocalDevelopmentUser = User & Readonly<{ email: string }>;

const confirmedLocalDevelopmentUser = (
  user: User | null,
  identityId: string,
): user is ConfirmedLocalDevelopmentUser =>
  user !== null &&
  user.id === identityId &&
  user.is_anonymous !== true &&
  user.deleted_at === undefined &&
  typeof user.email === "string" &&
  validEmail(user.email) &&
  typeof user.email_confirmed_at === "string" &&
  Number.isFinite(Date.parse(user.email_confirmed_at)) &&
  Date.parse(user.email_confirmed_at) <= Date.now() &&
  (user.banned_until === undefined ||
    (Number.isFinite(Date.parse(user.banned_until)) && Date.parse(user.banned_until) <= Date.now()));

export const signInWithLocalDevelopmentAccount = async (
  configuration: LocalDevelopmentSignInConfiguration,
): Promise<VerifiedSignInResult> => {
  if (!localDevelopmentSignInAvailable(configuration))
    return { ok: false, code: "vortex.identity.authority_unavailable" };

  let sessionClient: SupabaseClient | undefined;
  let accepted = false;
  try {
    const admin = createClient(configuration.journey.supabaseUrl, configuration.adminKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    });
    const existing = await admin.auth.admin.getUserById(configuration.identityId);
    if (existing.error || !confirmedLocalDevelopmentUser(existing.data.user, configuration.identityId))
      return { ok: false, code: "vortex.identity.authority_unavailable" };

    // Recovery refuses absent users. Magic-link generation can create an account.
    const generated = await admin.auth.admin.generateLink({
      type: "recovery",
      email: existing.data.user.email,
    });
    if (
      generated.error ||
      !confirmedLocalDevelopmentUser(generated.data.user, configuration.identityId) ||
      generated.data.user.email !== existing.data.user.email ||
      generated.data.properties?.verification_type !== "recovery" ||
      !generated.data.properties.hashed_token ||
      generated.data.properties.hashed_token.length > 2_048
    )
      return { ok: false, code: "vortex.identity.authority_unavailable" };

    sessionClient = createAuthorityClient(configuration.journey);
    const verified = await sessionClient.auth.verifyOtp({
      token_hash: generated.data.properties.hashed_token,
      type: "recovery",
    });
    const session = verified.data.session;
    if (
      verified.error ||
      !confirmedLocalDevelopmentUser(verified.data.user, configuration.identityId) ||
      !session ||
      !confirmedLocalDevelopmentUser(session.user, configuration.identityId) ||
      !validAccessToken(session.access_token) ||
      !validRefreshToken(session.refresh_token)
    )
      return { ok: false, code: "vortex.identity.authority_unavailable" };

    const identity = await createIdentityVerifier(
      configuration.authority,
      configuration.journey.publishableKey,
    ).verifyAccessToken(session.access_token);
    if (identity.identityId !== configuration.identityId)
      return { ok: false, code: "vortex.identity.authority_unavailable" };

    accepted = true;
    return { ok: true, accessToken: session.access_token, refreshToken: session.refresh_token };
  } catch {
    return { ok: false, code: "vortex.identity.authority_unavailable" };
  } finally {
    if (!accepted && sessionClient !== undefined) {
      try {
        await sessionClient.auth.signOut({ scope: "local" });
      } catch {
        // Best-effort revocation; rejected credentials never reach cookie bootstrap.
      }
    }
  }
};

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

    if (
      error ||
      !data.session?.access_token ||
      !data.session.refresh_token ||
      !validAccessToken(data.session.access_token) ||
      !validRefreshToken(data.session.refresh_token)
    ) {
      return { ok: false, code: "vortex.identity.invalid_credentials" };
    }

    return {
      ok: true,
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
    };
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
  email: string,
  token: string,
): Promise<IdentityJourneyResult> => {
  if (!validEmail(email) || !EMAIL_OTP_PATTERN.test(token)) {
    return { ok: false, code: "vortex.identity.invalid_or_expired_link" };
  }

  try {
    const authority = createAuthorityClient(configuration);
    const { data, error } = await authority.auth.verifyOtp({ email, token, type: "email" });
    return error || !data.user
      ? { ok: false, code: "vortex.identity.invalid_or_expired_link" }
      : { ok: true };
  } catch {
    return { ok: false, code: "vortex.identity.authority_unavailable" };
  }
};

export const completePasswordRecovery = async (
  configuration: IdentityJourneyConfiguration,
  email: string,
  token: string,
  password: string,
): Promise<IdentityJourneyResult> => {
  if (!validEmail(email) || !EMAIL_OTP_PATTERN.test(token)) {
    return { ok: false, code: "vortex.identity.invalid_or_expired_link" };
  }
  if (!validNewPassword(password)) {
    return { ok: false, code: "vortex.identity.invalid_input" };
  }

  try {
    const authority = createAuthorityClient(configuration);
    const { data, error: verificationError } = await authority.auth.verifyOtp({
      email,
      token,
      type: "recovery",
    });

    if (verificationError || !data.session) {
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
