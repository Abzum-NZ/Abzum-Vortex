"use server";

import { logRefusal } from "@vortex/platform/schema";

/**
 * Records, server side, that a route's error boundary caught a failure. The browser only knows the
 * route and the digest Next.js assigned to the original error, which the framework's own server
 * log line carries, so the two lines can be matched without exposing the error's content.
 */
export async function reportRouteFailure(route: string, digest: string | undefined): Promise<void> {
  logRefusal(route.slice(0, 64), `render digest=${(digest ?? "none").slice(0, 64)}`, "ROUTE_RENDER_FAILED");
}
