import "server-only";

import { randomUUID } from "node:crypto";
import {
  correlationIdSchema,
  identitySessionResolutionSchema,
  type IdentitySessionResolution,
  type VerifiedIdentity,
} from "@vortex/platform/schema";
import {
  createIdentitySessionService,
  createIdentityVerifier,
  type VerifiedSignInResult,
  type IdentityVerificationExecution,
} from "@vortex/platform/server";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import {
  identitySessionCookieDeletions,
  type SessionCookie,
  type SessionCookieMutation,
  type SessionCookieProfile,
} from "./session-cookie";
import {
  createIdentitySessionClient,
  identitySessionProviderFailure,
  readIdentitySessionProvider,
  type IdentitySessionClient,
} from "./supabase-session-client";
import { identitySessionProxyHeader } from "./session-request-state";
import { mapWebError } from "../../_lib/web-error-mapper";
import {
  getIdentityAuthorityConfiguration,
  getIdentityJourneyConfiguration,
} from "./authority-configuration";

const applyMutations = async (mutations: readonly SessionCookieMutation[]): Promise<void> => {
  const store = await cookies();
  for (const mutation of mutations) store.set(mutation.name, mutation.value, mutation.options);
};

const requestCookies = async (): Promise<readonly SessionCookie[]> => {
  const store = await cookies();
  return store.getAll().map(({ name, value }) => ({ name, value }));
};

const staleCookieDeletions = (
  previous: readonly SessionCookie[],
  written: readonly SessionCookieMutation[],
  profile: SessionCookieProfile,
): readonly SessionCookieMutation[] => {
  const kept = new Set(written.map(({ name }) => name));
  return identitySessionCookieDeletions(profile).filter(
    ({ name }) => !kept.has(name) && previous.some((cookie) => cookie.name === name),
  );
};

const sessionService = (execution?: IdentityVerificationExecution) => {
  const journey = getIdentityJourneyConfiguration();
  return createIdentitySessionService(
    createIdentityVerifier(
      getIdentityAuthorityConfiguration(),
      journey.publishableKey,
      execution === undefined ? {} : { execution },
    ),
  );
};

const unavailable = (): IdentitySessionResolution =>
  identitySessionResolutionSchema.parse({ kind: "temporarily_unavailable" });
const invalid = (): IdentitySessionResolution =>
  identitySessionResolutionSchema.parse({ kind: "invalid_session_state" });
const revoked = (): IdentitySessionResolution =>
  identitySessionResolutionSchema.parse({ kind: "expired_or_revoked" });

const providerFailure = (error: unknown, operation: string): IdentitySessionResolution =>
  identitySessionProviderFailure(error, operation) === "invalid" ? revoked() : unavailable();

const revokeIssuedProviderSession = async (
  signedIn: Extract<VerifiedSignInResult, { ok: true }>,
): Promise<void> => {
  // Revocation is best effort; the failed pair is never committed to the browser.
  const logRevokeFailure = (error: unknown): void => {
    mapWebError(error, {
      route: "auth/session",
      operation: "revoke-uncommitted-provider-session",
      code: "SESSION_PROVIDER_REVOKE_FAILED",
      fallback: undefined,
    });
  };
  try {
    const cleanup = createIdentitySessionClient([]);
    const set = await cleanup.client.auth.setSession({
      access_token: signedIn.accessToken,
      refresh_token: signedIn.refreshToken,
    });
    if (set.error) logRevokeFailure(set.error);
    const out = await cleanup.client.auth.signOut({ scope: "local" });
    if (out.error) logRevokeFailure(out.error);
  } catch (error) {
    logRevokeFailure(error);
  }
};

export const bootstrapIdentitySession = async (
  signedIn: Extract<VerifiedSignInResult, { ok: true }>,
): Promise<IdentitySessionResolution> => {
  let outcome: IdentitySessionResolution = unavailable();
  let committed = false;
  try {
    // A fresh sign-in supersedes whatever session cookies the browser still holds. Starting from
    // them would make the provider client try to refresh a stale pair (for example after a
    // database reset) and discard or race the new session, so it starts empty and the old
    // cookies are replaced or deleted when the new pair is committed.
    const previous = await requestCookies();
    const boundary = createIdentitySessionClient([]);
    const setResult = await boundary.client.auth.setSession({
      access_token: signedIn.accessToken,
      refresh_token: signedIn.refreshToken,
    });
    if (setResult.error || !setResult.data.session) {
      outcome = providerFailure(setResult.error, "set-session");
    } else {
      const currentToken = setResult.data.session.access_token;
      const live = await boundary.client.auth.getUser(currentToken);
      if (live.error || !live.data.user) {
        outcome = providerFailure(live.error, "get-user");
      } else {
        outcome = await sessionService().bootstrap(
          currentToken,
          correlationIdSchema.parse(randomUUID()),
        );
        const staged = boundary.stage.snapshot();
        if (staged.refused) {
          outcome = invalid();
        } else if (outcome.kind === "active") {
          await applyMutations([
            ...staged.mutations,
            ...staleCookieDeletions(previous, staged.mutations, boundary.profile),
          ]);
          committed = true;
        }
      }
    }
  } catch (error) {
    outcome = mapWebError(error, {
      route: "auth/session",
      operation: "bootstrap-identity-session",
      code: "SESSION_BOOTSTRAP_FAILED",
      fallback: unavailable(),
    });
  }

  if (!committed) await revokeIssuedProviderSession(signedIn);
  return outcome;
};

type RequestIdentityResolution = Readonly<{
  resolution: IdentitySessionResolution;
  /** Present only when this exact token passed Identity resolution. Server request only. */
  accessToken?: string;
  /** The identity that passed resolution; present with `accessToken`. Server request only. */
  verified?: VerifiedIdentity;
}>;

const resolveRequestIdentity = async (
  execution?: IdentityVerificationExecution,
): Promise<RequestIdentityResolution> => {
  execution?.checkpoint();
  const proxyState = (await headers()).get(identitySessionProxyHeader);
  if (proxyState === "missing")
    return { resolution: identitySessionResolutionSchema.parse({ kind: "missing" }) };
  if (proxyState === "invalid") return { resolution: invalid() };
  if (proxyState !== "verified") return { resolution: unavailable() };

  let boundary: IdentitySessionClient;
  try {
    boundary = createIdentitySessionClient(await requestCookies(), {
      verificationOnly: true,
      ...(execution === undefined ? {} : { execution }),
    });
  } catch (error) {
    return {
      resolution: mapWebError(error, {
        route: "auth/session",
        operation: "create-session-client",
        code: "SESSION_CLIENT_UNAVAILABLE",
        fallback: unavailable(),
      }),
    };
  }
  if (boundary.stage.initialState.kind === "missing")
    return { resolution: identitySessionResolutionSchema.parse({ kind: "missing" }) };
  if (boundary.stage.initialState.kind === "invalid") return { resolution: invalid() };

  const beforeRead = boundary.stage.snapshot();
  if (beforeRead.refused || beforeRead.mutations.length > 0) return { resolution: unavailable() };
  execution?.checkpoint();
  const current = await readIdentitySessionProvider("get-session", () =>
    boundary.client.auth.getSession(),
  );
  execution?.checkpoint();
  if (boundary.verificationRefused()) return { resolution: unavailable() };
  if (!current.ok) return { resolution: current.state === "invalid" ? revoked() : unavailable() };
  if (!current.data.session?.access_token)
    return { resolution: identitySessionResolutionSchema.parse({ kind: "missing" }) };
  const staged = boundary.stage.snapshot();
  if (staged.refused || staged.mutations.length > 0) return { resolution: unavailable() };
  const accessToken = current.data.session.access_token;
  const { resolution, identity } = await sessionService(execution).resolveVerified(accessToken);
  execution?.checkpoint();
  if (resolution.kind !== "active" || identity === undefined) return { resolution };
  return { resolution, accessToken, verified: identity };
};

/**
 * The ordinary resolution, made once per server render: the layout, the page and their loaders in
 * one request share it instead of verifying the same session again. A call that carries its own
 * execution deadline (private invalidation) still resolves on its own.
 */
const resolveRenderIdentity = cache(() => resolveRequestIdentity());

export const resolveIdentitySession = async (): Promise<IdentitySessionResolution> =>
  (await resolveRenderIdentity()).resolution;

/** Explicit recovery after a refused save; the route commits the pair before the browser retries. */
export const refreshIdentitySession = async (): Promise<IdentitySessionResolution> => {
  try {
    const boundary = createIdentitySessionClient(await requestCookies());
    if (boundary.stage.initialState.kind !== "valid") return revoked();
    const refreshed = await boundary.client.auth.refreshSession();
    if (refreshed.error || !refreshed.data.session)
      return providerFailure(refreshed.error, "refresh-session");
    const result = await sessionService().resolve(refreshed.data.session.access_token);
    const staged = boundary.stage.snapshot();
    if (staged.refused) return invalid();
    if (result.kind === "active") await applyMutations(staged.mutations);
    return result;
  } catch (error) {
    return mapWebError(error, {
      route: "auth/session",
      operation: "refresh-identity-session",
      code: "SESSION_REFRESH_FAILED",
      fallback: unavailable(),
    });
  }
};

/** The ordinary resolution plus the signed-in person's email, for pages that show who is signed in. */
export const resolveIdentitySessionWithEmail = async (): Promise<
  Readonly<{ resolution: IdentitySessionResolution; email?: string }>
> => {
  const { resolution, verified } = await resolveRenderIdentity();
  return verified === undefined
    ? { resolution }
    : { resolution, email: verified.verifiedPrimaryEmail };
};

/**
 * The verified identity of this request's active session, for actions a person takes before they
 * have an organisation (listing and accepting invitations). Never serialize or cache it.
 */
export const resolveVerifiedIdentity = async (): Promise<VerifiedIdentity | undefined> =>
  (await resolveRenderIdentity()).verified;

/**
 * Private delivery composition only. This shares every ordinary resolution guard
 * and retains the very token Identity verified, without changing the public union.
 * Never serialize this result, cache it, or use it outside its live Web request.
 */
export const resolveIdentitySessionForPrivateInvalidation = resolveRequestIdentity;

/**
 * Revokes the browser's own provider session (its refresh token) from the given session cookies,
 * best effort. The scope is this one session only, never the person's other sessions. The caller
 * clears the cookies itself; local clearing stays authoritative for this browser even when the
 * provider cannot be reached or the session is already gone (for example after a database reset).
 * It returns the cookie profile so the caller can delete exactly the session cookies.
 */
export const revokeIdentitySession = async (
  sessionCookies: readonly SessionCookie[],
): Promise<SessionCookieProfile | undefined> => {
  let boundary: IdentitySessionClient;
  try {
    boundary = createIdentitySessionClient(sessionCookies);
  } catch (error) {
    return mapWebError(error, {
      route: "auth/session",
      operation: "create-revocation-client",
      code: "SESSION_REVOKE_CLIENT_UNAVAILABLE",
      fallback: undefined,
    });
  }
  try {
    if (boundary.stage.initialState.kind === "valid") {
      const signedOut = await boundary.client.auth.signOut({ scope: "local" });
      if (signedOut.error)
        mapWebError(signedOut.error, {
          route: "auth/session",
          operation: "revoke-provider-session",
          code: "SESSION_PROVIDER_REVOKE_FAILED",
          fallback: undefined,
        });
    }
  } catch (error) {
    // Revocation is best effort; the cookies are cleared regardless.
    mapWebError(error, {
      route: "auth/session",
      operation: "revoke-provider-session",
      code: "SESSION_PROVIDER_REVOKE_FAILED",
      fallback: undefined,
    });
  }
  return boundary.profile;
};

export const endIdentitySession = async (): Promise<void> => {
  const profile = await revokeIdentitySession(await requestCookies());
  if (profile) await applyMutations(identitySessionCookieDeletions(profile));
};

/** A factor operation uses the same verified session and staged cookie boundary as sign-in. */
const mfaBoundary = async () => {
  const previous = await requestCookies();
  const boundary = createIdentitySessionClient(previous);
  if (boundary.stage.initialState.kind !== "valid") throw new Error("MFA session is unavailable");
  const current = await boundary.client.auth.getSession();
  if (current.error || !current.data.session)
    throw current.error ?? new Error("MFA session is missing");
  const checked = await sessionService().resolveVerified(current.data.session.access_token);
  const staged = boundary.stage.snapshot();
  if (
    checked.resolution.kind !== "active" ||
    !checked.identity ||
    staged.refused ||
    staged.mutations.length
  )
    throw new Error("MFA session could not be verified without refreshing");
  return { boundary, previous, identity: checked.identity };
};

export const readMfaFactor = async (): Promise<
  { kind: "challenge"; factorId: string } | { kind: "setup" } | { kind: "unavailable" }
> => {
  try {
    const { boundary } = await mfaBoundary();
    const factors = await boundary.client.auth.mfa.listFactors();
    if (factors.error) throw factors.error;
    const staged = boundary.stage.snapshot();
    if (staged.refused || staged.mutations.length)
      throw new Error("MFA factor read changed the session");
    const factor = factors.data.totp[0];
    return factor ? { kind: "challenge", factorId: factor.id } : { kind: "setup" };
  } catch (error) {
    return mapWebError(error, {
      route: "auth/mfa",
      operation: "read-factors",
      code: "MFA_READ_FAILED",
      fallback: { kind: "unavailable" } as const,
    });
  }
};

export const enrollMfaFactor = async (): Promise<
  { kind: "enrolled"; factorId: string; secret: string } | { kind: "unavailable" }
> => {
  try {
    const { boundary } = await mfaBoundary();
    const factors = await boundary.client.auth.mfa.listFactors();
    if (factors.error) throw factors.error;
    if (factors.data.all.some((item) => item.status === "verified"))
      throw new Error("A verified authenticator already exists");
    for (const factor of factors.data.all.filter(
      (item) => item.status === "unverified" && item.factor_type === "totp",
    )) {
      const removed = await boundary.client.auth.mfa.unenroll({ factorId: factor.id });
      if (removed.error) throw removed.error;
    }
    const enrolled = await boundary.client.auth.mfa.enroll({ factorType: "totp" });
    if (enrolled.error) throw enrolled.error;
    if (enrolled.data.type !== "totp") throw new Error("Unexpected MFA factor type");
    const staged = boundary.stage.snapshot();
    if (staged.refused || staged.mutations.length)
      throw new Error("MFA enrolment changed the session");
    return { kind: "enrolled", factorId: enrolled.data.id, secret: enrolled.data.totp.secret };
  } catch (error) {
    return mapWebError(error, {
      route: "auth/mfa",
      operation: "enroll-factor",
      code: "MFA_ENROLL_FAILED",
      fallback: { kind: "unavailable" } as const,
    });
  }
};

export const verifyMfaFactor = async (factorId: string, code: string): Promise<boolean> => {
  try {
    const { boundary, previous, identity } = await mfaBoundary();
    const verified = await boundary.client.auth.mfa.challengeAndVerify({ factorId, code });
    if (verified.error) throw verified.error;
    const checked = await sessionService().resolveVerified(verified.data.access_token);
    const staged = boundary.stage.snapshot();
    if (
      checked.resolution.kind !== "active" ||
      checked.identity?.identityId !== identity.identityId ||
      checked.identity.sessionId !== identity.sessionId ||
      checked.identity.authenticationStrength !== "multi_factor" ||
      staged.refused ||
      !staged.mutations.length
    )
      throw new Error("MFA verification did not produce a verified multi-factor session");
    await applyMutations([
      ...staged.mutations,
      ...staleCookieDeletions(previous, staged.mutations, boundary.profile),
    ]);
    return true;
  } catch (error) {
    return mapWebError(error, {
      route: "auth/mfa",
      operation: "verify-factor",
      code: "MFA_VERIFY_FAILED",
      fallback: false,
    });
  }
};
