"use server";

import { logRefusal } from "@vortex/platform/schema";

const reportableRoutes: ReadonlySet<string> = new Set(["studio", "application-address"]);
const digestPattern = /^[0-9A-Za-z_-]{1,32}$/;

/**
 * Records, server side, that a route's error boundary caught a failure. The browser only knows the
 * route and the digest Next.js assigned to the original error, which the framework's own server
 * log line carries, so the two lines can be matched without exposing the error's content. Both
 * arguments are browser-controlled, so only a known route and a plain digest are ever logged.
 */
export async function reportRouteFailure(route: string, digest: string | undefined): Promise<void> {
  if (!reportableRoutes.has(route)) return;
  const safeDigest = digest !== undefined && digestPattern.test(digest) ? digest : "none";
  logRefusal(route, `render digest=${safeDigest}`, "ROUTE_RENDER_FAILED");
}
