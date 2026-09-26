import { NextResponse, type NextRequest } from "next/server";
import { getIdentityJourneyConfiguration } from "../_lib/authority-configuration";
import {
  identitySessionCookieDeletions,
  identitySessionCookieProfile,
} from "../_lib/session-cookie";
import { requestMatchesConfiguredSite } from "../_lib/session-request-state";

export function GET(request: NextRequest): NextResponse {
  let configuration: ReturnType<typeof getIdentityJourneyConfiguration> | undefined;
  try {
    configuration = getIdentityJourneyConfiguration();
  } catch {
    configuration = undefined;
  }

  // The destination is built from the configured site URL, never from `request.url`: Next dev
  // reports a loopback request as localhost while the configured origin is 127.0.0.1, and the
  // proxy's site match would then fail. The configured value is trusted, so this stays closed
  // against open redirects; the request URL is only the fallback when configuration is absent.
  const destination = new URL(
    "/auth/sign-in?status=session-ended",
    configuration?.siteUrl ?? request.url,
  );
  const response = NextResponse.redirect(destination, 303);
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Expires", "0");
  response.headers.set("Pragma", "no-cache");

  if (configuration === undefined)
    // A fixed safe redirect remains available when configuration is unavailable.
    return response;

  try {
    if (!requestMatchesConfiguredSite(request.headers, request.nextUrl, configuration.siteUrl))
      return response;
    const profile = identitySessionCookieProfile(configuration.siteUrl);
    for (const mutation of identitySessionCookieDeletions(profile))
      response.cookies.set(mutation.name, mutation.value, mutation.options);
  } catch {
    // A fixed safe redirect remains available when configuration is invalid.
  }
  return response;
}
