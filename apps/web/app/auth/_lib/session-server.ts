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
} from "@vortex/identity";
import { isAuthRefreshDiscardedError, isAuthRetryableFetchError } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import {
  identitySessionCookieDeletions,
  type SessionCookie,
  type SessionCookieMutation,
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

const sessionService = () => {
  const journey = getIdentityJourneyConfiguration();
  return createDefaultIdentitySessionService(
    createIdentityVerifier(getIdentityAuthorityConfiguration(), journey.publishableKey),
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
  let boundary: IdentitySessionClient;
  try {
    boundary = createIdentitySessionClient(await requestCookies());
  } catch {
    return unavailable();
  }

  if (boundary.stage.initialState.kind === "invalid") {
    await revokeIssuedProviderSession(signedIn);
    return invalid();
  }
  const setResult = await boundary.client.auth.setSession({
    access_token: signedIn.accessToken,
    refresh_token: signedIn.refreshToken,
  });
  if (setResult.error || !setResult.data.session) {
    await revokeIssuedProviderSession(signedIn);
    return providerFailure(setResult.error);
  }

  const currentToken = setResult.data.session.access_token;
  const live = await boundary.client.auth.getUser(currentToken);
  if (live.error || !live.data.user) {
    await revokeIssuedProviderSession(signedIn);
    return providerFailure(live.error);
  }

  const result = await sessionService().bootstrap(
    currentToken,
    correlationIdSchema.parse(randomUUID()),
  );
  const staged = boundary.stage.snapshot();
  if (result.kind === "active" && !staged.refused) {
    await applyMutations(staged.mutations);
    return result;
  }

  await revokeIssuedProviderSession(signedIn);
  return staged.refused ? invalid() : result;
};

export const resolveIdentitySession = async (): Promise<IdentitySessionResolution> => {
  const proxyState = (await headers()).get(identitySessionProxyHeader);
  if (proxyState === "missing") return identitySessionResolutionSchema.parse({ kind: "missing" });
  if (proxyState === "invalid") return invalid();
  if (proxyState !== "verified") return unavailable();

  let boundary: IdentitySessionClient;
  try {
    boundary = createIdentitySessionClient(await requestCookies());
  } catch {
    return unavailable();
  }
  if (boundary.stage.initialState.kind === "missing")
    return identitySessionResolutionSchema.parse({ kind: "missing" });
  if (boundary.stage.initialState.kind === "invalid") return invalid();

  const current = await boundary.client.auth.getSession();
  if (current.error) return providerFailure(current.error);
  if (!current.data.session?.access_token)
    return identitySessionResolutionSchema.parse({ kind: "missing" });
  const staged = boundary.stage.snapshot();
  if (staged.refused || staged.mutations.length > 0) return unavailable();
  return sessionService().resolve(current.data.session.access_token);
};

export const endIdentitySession = async (): Promise<void> => {
  let boundary: IdentitySessionClient | undefined;
  try {
    boundary = createIdentitySessionClient(await requestCookies());
    if (boundary.stage.initialState.kind === "valid")
      await boundary.client.auth.signOut({ scope: "local" });
  } catch {
    // Local clearing is authoritative for this browser even after a provider failure.
  }
  if (boundary) await applyMutations(identitySessionCookieDeletions(boundary.profile));
};
