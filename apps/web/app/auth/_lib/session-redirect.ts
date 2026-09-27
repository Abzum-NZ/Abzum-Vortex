import "server-only";

import type { IdentitySessionResolution } from "@vortex/contracts";
import { redirect } from "next/navigation";

/** The one route that ends a browser session: it clears the session cookies, then shows sign-in. */
export const SESSION_ENDED_PATH = "/auth/session-ended";

/** The identity-session results a signed-in surface continues with. */
export type ContinuingIdentitySession = Extract<
  IdentitySessionResolution,
  { kind: "active" | "temporarily_unavailable" }
>;

/**
 * The one mapping from an identity-session result to its redirect. Every settled non-active result
 * (missing, inactive, invalid, expired or revoked) ends the session through the route that clears
 * its cookies. A bare sign-in redirect would leave a verified token for an inactive or missing
 * identity in place, and the sign-in page would send it straight back, looping. An active session
 * and a temporarily unavailable read are returned for the caller to answer, since only the caller
 * knows where to retry.
 */
export const continueSessionOrEnd = (
  result: IdentitySessionResolution,
): ContinuingIdentitySession => {
  if (result.kind === "active" || result.kind === "temporarily_unavailable") return result;
  redirect(SESSION_ENDED_PATH);
};
