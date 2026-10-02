import "server-only";

import { randomUUID } from "node:crypto";
import {
  correlationIdSchema,
  identitySessionResolutionSchema,
  type IdentitySessionResolution,
} from "@vortex/contracts";
import {
  createDefaultIdentitySessionService,
  createIdentityVerifier,
  type VerifiedSignInResult,
  type IdentityVerificationExecution,
} from "@vortex/identity";
import { isAuthRefreshDiscardedError, isAuthRetryableFetchError } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import {
  identitySessionCookieDeletions,
  type SessionCookie,
  type SessionCookieMutation,
  type SessionCookieProfile,
} from "./session-cookie";
import { createIdentitySessionClient, type IdentitySessionClient } from "./supabase-session-client";
import { identitySessionProxyHeader } from "./session-request-state";
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
  return createDefaultIdentitySessionService(
    createIdentityVerifier(getIdentityAuthorityConfiguration(), journey.publishableKey,
      execution === undefined ? {} : { execution }),
  );
};

const unavailable = (): IdentitySessionResolution =>
  identitySessionResolutionSchema.parse({ kind: "temporarily_unavailable" });
const invalid = (): IdentitySessionResolution =>
  identitySessionResolutionSchema.parse({ kind: "invalid_session_state" });
const revoked = (): IdentitySessionResolution =>
  identitySessionResolutionSchema.parse({ kind: "expired_or_revoked" });

const providerFailure = (error: unknown): IdentitySessionResolution =>
  isAuthRetryableFetchError(error) || isAuthRefreshDiscardedError(error)
    ? unavailable()
    : revoked();

const revokeIssuedProviderSession = async (
  signedIn: Extract<VerifiedSignInResult, { ok: true }>,
): Promise<void> => {
  try {
    const cleanup = createIdentitySessionClient([]);
    await cleanup.client.auth
      .setSession({ access_token: signedIn.accessToken, refresh_token: signedIn.refreshToken })
      .catch(() => undefined);
    await cleanup.client.auth.signOut({ scope: "local" }).catch(() => undefined);
  } catch {
    // Revocation is best effort; the failed pair is never committed to the browser.
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
      outcome = providerFailure(setResult.error);
    } else {
      const currentToken = setResult.data.session.access_token;
      const live = await boundary.client.auth.getUser(currentToken);
      if (live.error || !live.data.user) {
        outcome = providerFailure(live.error);
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
  } catch {
    outcome = unavailable();
  }

  if (!committed) await revokeIssuedProviderSession(signedIn);
  return outcome;
};

type RequestIdentityResolution = Readonly<{
  resolution: IdentitySessionResolution;
  /** Present only when this exact token passed Identity resolution. Server request only. */
  accessToken?: string;
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
      verificationOnly: true, ...(execution === undefined ? {} : { execution }),
    });
  } catch {
    return { resolution: unavailable() };
  }
  if (boundary.stage.initialState.kind === "missing")
    return { resolution: identitySessionResolutionSchema.parse({ kind: "missing" }) };
  if (boundary.stage.initialState.kind === "invalid") return { resolution: invalid() };

  const beforeRead = boundary.stage.snapshot();
  if (beforeRead.refused || beforeRead.mutations.length > 0)
    return { resolution: unavailable() };
  execution?.checkpoint();
  const current = await boundary.client.auth.getSession();
  execution?.checkpoint();
  if (boundary.verificationRefused()) return { resolution: unavailable() };
  if (current.error) return { resolution: providerFailure(current.error) };
  if (!current.data.session?.access_token)
    return { resolution: identitySessionResolutionSchema.parse({ kind: "missing" }) };
  const staged = boundary.stage.snapshot();
  if (staged.refused || staged.mutations.length > 0) return { resolution: unavailable() };
  const accessToken = current.data.session.access_token;
  const resolution = await sessionService(execution).resolve(accessToken);
  execution?.checkpoint();
  return resolution.kind === "active" ? { resolution, accessToken } : { resolution };
};

export const resolveIdentitySession = async (): Promise<IdentitySessionResolution> =>
  (await resolveRequestIdentity()).resolution;

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
  } catch {
    return undefined;
  }
  try {
    if (boundary.stage.initialState.kind === "valid")
      await boundary.client.auth.signOut({ scope: "local" });
  } catch {
    // Revocation is best effort; the cookies are cleared regardless.
  }
  return boundary.profile;
};

export const endIdentitySession = async (): Promise<void> => {
  const profile = await revokeIdentitySession(await requestCookies());
  if (profile) await applyMutations(identitySessionCookieDeletions(profile));
};
