import "server-only";

import type { IdentitySessionResolution } from "@vortex/contracts";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getIdentityJourneyConfiguration } from "./authority-configuration";
import {
  serializeApplicationHomeContinuation,
  type ApplicationHomeContinuation,
} from "./application-home-continuation";
import { issueSessionCleanupProof } from "./session-cleanup-proof";
import { identitySessionProxyHeader } from "./session-request-state";

/** The one route that ends a browser session: it clears the session cookies, then shows sign-in. */
export const SESSION_ENDED_PATH = "/auth/session-ended";
const sessionEndedDestination = "/auth/sign-in?status=session-ended";

const directSignInDestination = (
  applicationHome?: ApplicationHomeContinuation,
): string => {
  if (applicationHome === undefined) return sessionEndedDestination;
  const query = new URLSearchParams({ status: "session-ended" });
  query.set("applicationHome", serializeApplicationHomeContinuation(applicationHome));
  return `/auth/sign-in?${query.toString()}`;
};

/** Carry first-party evidence across redirects, including a cross-site initiated redirect chain. */
export const redirectToSessionEnd = async (
  applicationHome?: ApplicationHomeContinuation,
): Promise<never> => {
  // The proxy has already cleared an invalid cookie family on its response.
  if ((await headers()).get(identitySessionProxyHeader) === "invalid")
    redirect(directSignInDestination(applicationHome));
  let proof: string | undefined;
  try {
    const siteUrl = getIdentityJourneyConfiguration().siteUrl;
    const sessionCookies = (await cookies()).getAll().map(({ name, value }) => ({ name, value }));
    proof = issueSessionCleanupProof(sessionCookies, siteUrl);
  } catch {}
  if (proof !== undefined) {
    const query = new URLSearchParams({ proof });
    if (applicationHome !== undefined)
      query.set("applicationHome", serializeApplicationHomeContinuation(applicationHome));
    redirect(`${SESSION_ENDED_PATH}?${query.toString()}`);
  }
  // No session cookie remains to clear, or configuration is unavailable.
  redirect(directSignInDestination(applicationHome));
};

/** The identity-session results a signed-in surface continues with. */
export type ContinuingIdentitySession = Extract<
  IdentitySessionResolution,
  { kind: "active" | "temporarily_unavailable" }
>;

/**
 * The one mapping from an identity-session result to its redirect. Settled non-active results
 * (missing, inactive, invalid, expired or revoked) clear any remaining session cookies through
 * the cleanup route. When the proxy has already cleared an invalid cookie family, or there are no
 * cookies, the person goes directly to the session-ended sign-in state. An active session and a
 * temporarily unavailable read are returned for the caller to answer, since only the caller knows
 * where to retry.
 */
export const continueSessionOrEnd = async (
  result: IdentitySessionResolution,
  applicationHome?: ApplicationHomeContinuation,
): Promise<ContinuingIdentitySession> => {
  if (result.kind === "active" || result.kind === "temporarily_unavailable") return result;
  return redirectToSessionEnd(applicationHome);
};
