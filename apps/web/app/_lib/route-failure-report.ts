"use server";

import { resolveIdentitySession } from "../auth/_lib/session-server";

const reportableRoutes: ReadonlySet<string> = new Set(["app", "studio", "application-address"]);
const digestPattern = /^[0-9A-Za-z_-]{1,32}$/;

/**
 * Records, server side, that a route's error boundary caught a failure. The browser only knows the
 * route and the digest Next.js assigned to the original error, which the framework's own server
 * log line carries, so the two lines can be matched without exposing the error's content. Both
 * arguments are browser-controlled, so only a signed-in caller, a known route and a plain digest
 * are ever logged: a post without a session is dropped without a line.
 */
export async function reportRouteFailure(route: string, digest: string | undefined): Promise<void> {
  if (!reportableRoutes.has(route)) return;
  if ((await resolveIdentitySession()).kind !== "active") return;
  const safeDigest = digest !== undefined && digestPattern.test(digest) ? digest : "none";
  // A route that failed to render is a platform fault, not a refusal: one line at error.
  console.error(`[${route}] render failed: code=ROUTE_RENDER_FAILED digest=${safeDigest}`);
}
