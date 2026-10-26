import "server-only";

import type { IdentitySessionResolution } from "@vortex/platform/schema";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getIdentityJourneyConfiguration } from "./authority-configuration";
import { serializeSignInContinuation, type SignInContinuation } from "./sign-in-continuation";
import { issueSessionCleanupProof } from "./session-cleanup-proof";
import { identitySessionProxyHeader } from "./session-request-state";
import { mapWebError } from "../../_lib/web-error-mapper";

/** The one route that ends a browser session: it clears the session cookies, then shows sign-in. */
const SESSION_ENDED_PATH = "/auth/session-ended";
const sessionEndedDestination = "/auth/sign-in?status=session-ended";

/** What the person is told after the cookies are cleared: their session ended, or plain sign-in. */
type SessionEndState = "session-ended" | "signed-out";

const directSignInDestination = (
  continuation: SignInContinuation | undefined,
  state: SessionEndState,
): string => {
  if (continuation === undefined && state === "session-ended") return sessionEndedDestination;
  const query = new URLSearchParams(state === "session-ended" ? { status: state } : {});
  if (continuation !== undefined)
    query.set("continuation", serializeSignInContinuation(continuation));
  return query.size === 0 ? "/auth/sign-in" : `/auth/sign-in?${query.toString()}`;
};

/** Carry first-party evidence across redirects, including a cross-site initiated redirect chain. */
export const redirectToSessionEnd = async (
  continuation?: SignInContinuation,
  state: SessionEndState = "session-ended",
): Promise<never> => {
  // The proxy has already cleared an invalid cookie family on its response.
  if ((await headers()).get(identitySessionProxyHeader) === "invalid")
    redirect(directSignInDestination(continuation, state));
  let proof: string | undefined;
  try {
    const siteUrl = getIdentityJourneyConfiguration().siteUrl;
    const sessionCookies = (await cookies()).getAll().map(({ name, value }) => ({ name, value }));
    proof = issueSessionCleanupProof(sessionCookies, siteUrl);
  } catch (error) {
    // Session cleanup proceeds without a proof; the cause is logged.
    mapWebError(error, {
      route: "auth/session-redirect",
      operation: "issue-cleanup-proof",
      code: "SESSION_CLEANUP_PROOF_UNAVAILABLE",
      fallback: undefined,
    });
  }
  if (proof !== undefined) {
    const query = new URLSearchParams({ proof });
    if (state === "signed-out") query.set("status", state);
    if (continuation !== undefined)
      query.set("continuation", serializeSignInContinuation(continuation));
    redirect(`${SESSION_ENDED_PATH}?${query.toString()}`);
  }
  // No session cookie remains to clear, or configuration is unavailable.
  redirect(directSignInDestination(continuation, state));
};

/** The identity-session results a signed-in surface continues with. */
type ContinuingIdentitySession = Extract<
  IdentitySessionResolution,
  { kind: "active" | "temporarily_unavailable" }
>;

/**
 * The one mapping from an identity-session result to its redirect. Settled non-active results
 * (missing, inactive, invalid, expired or revoked) clear any remaining session cookies through
 * the cleanup route. When the proxy has already cleared an invalid cookie family, or there are no
 * cookies, the person goes directly to sign-in. Nobody signed in (missing) leads to a plain
 * sign-in that returns to the address; every other result to the session-ended state. An active
 * session and a temporarily unavailable read are returned for the caller to answer, since only the
 * caller knows where to retry.
 */
export const continueSessionOrEnd = async (
  result: IdentitySessionResolution,
  continuation?: SignInContinuation,
): Promise<ContinuingIdentitySession> => {
  if (result.kind === "active" || result.kind === "temporarily_unavailable") return result;
  // Nobody was signed in: a plain sign-in that returns to the address, not "your session ended".
  // Cookies without a session token are still cleared on the way.
  return redirectToSessionEnd(
    continuation,
    result.kind === "missing" ? "signed-out" : "session-ended",
  );
};
