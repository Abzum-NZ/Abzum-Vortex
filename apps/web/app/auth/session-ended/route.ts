import { after, NextResponse, type NextRequest } from "next/server";
import { getIdentityJourneyConfiguration } from "../_lib/authority-configuration";
import { verifiesSessionCleanupProof } from "../_lib/session-cleanup-proof";
import {
  identitySessionCookieDeletions,
  identitySessionCookieProfile,
} from "../_lib/session-cookie";
import { requestMatchesConfiguredSite } from "../_lib/session-request-state";
import { revokeIdentitySession } from "../_lib/session-server";
import { privateResponse } from "../../_lib/private-response";

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

  const response = privateResponse(NextResponse.redirect(destination, 303));
  response.headers.set("Referrer-Policy", "no-referrer");

  // A fixed safe redirect remains available when configuration is unavailable.
  if (siteUrl === undefined) return response;
  try {
    // A redirect from a protected page carries proof bound to this browser's current cookies.
    // Fetch Metadata stays cross-site through redirects, so that proof is required for that case.
    const sessionCookies = request.cookies.getAll().map(({ name, value }) => ({ name, value }));
    if (
      !allowsSessionEnd(request, siteUrl) &&
      !verifiesSessionCleanupProof(request.nextUrl.searchParams.get("proof"), sessionCookies, siteUrl)
    )
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
