import { after, NextResponse, type NextRequest } from "next/server";
import { getIdentityJourneyConfiguration } from "../_lib/authority-configuration";
import {
  identitySessionCookieDeletions,
  identitySessionCookieProfile,
} from "../_lib/session-cookie";
import { requestMatchesConfiguredSite } from "../_lib/session-request-state";
import { revokeIdentitySession } from "../_lib/session-server";

const destinationPath = "/auth/sign-in?status=session-ended";

const allowsSessionEnd = (request: NextRequest, siteUrl: string): boolean => {
  const configuredOrigin = new URL(siteUrl).origin;
  const fetchSite = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== configuredOrigin) return false;
  if (fetchSite === "same-origin" || fetchSite === "none") return true;
  return origin === configuredOrigin && (fetchSite === null || fetchSite === "same-site");
};

export function GET(request: NextRequest): NextResponse {
  // The destination is a fixed path on the configured site URL, never on `request.url`: Next dev
  // reports a loopback request as localhost while the configured origin is 127.0.0.1, and the
  // proxy's site match would then fail. The configured value is trusted, so this stays closed
  // against open redirects; the request URL is only the fallback when configuration is missing
  // or invalid, and then only for the same fixed path.
  let siteUrl: string | undefined;
  let destination: URL;
  try {
    siteUrl = getIdentityJourneyConfiguration().siteUrl;
    destination = new URL(destinationPath, siteUrl);
  } catch {
    siteUrl = undefined;
    destination = new URL(destinationPath, request.url);
  }

  const response = NextResponse.redirect(destination, 303);
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Expires", "0");
  response.headers.set("Pragma", "no-cache");

  // A fixed safe redirect remains available when configuration is unavailable.
  if (siteUrl === undefined) return response;
  try {
    // Browser cross-site navigations and form submissions cannot clear this browser's session.
    // Internal session-expiry redirects are same-origin navigations; direct visits use "none".
    if (!allowsSessionEnd(request, siteUrl))
      return new NextResponse(null, { status: 403, headers: { "Cache-Control": "no-store" } });
    if (!requestMatchesConfiguredSite(request.headers, request.nextUrl, siteUrl)) return response;
    const profile = identitySessionCookieProfile(siteUrl);
    for (const mutation of identitySessionCookieDeletions(profile))
      response.cookies.set(mutation.name, mutation.value, mutation.options);
  } catch {
    // A fixed safe redirect remains available when configuration is invalid.
    return response;
  }

  // Attempt to revoke this browser's provider refresh token after the redirect is sent, so a slow
  // or unreachable provider never delays or fails local sign-out. The attempt is limited to this
  // browser's own session and only runs for an allowed navigation.
  const sessionCookies = request.cookies.getAll().map(({ name, value }) => ({ name, value }));
  try {
    after(() => revokeIdentitySession(sessionCookies).then(() => undefined));
  } catch {
    // Outside a request scope nothing can be scheduled; the cookies are still cleared.
  }
  return response;
}
