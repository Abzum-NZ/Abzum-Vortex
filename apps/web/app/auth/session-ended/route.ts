import { NextResponse, type NextRequest } from "next/server";
import { getIdentityJourneyConfiguration } from "../_lib/authority-configuration";
import {
  identitySessionCookieDeletions,
  identitySessionCookieProfile,
} from "../_lib/session-cookie";
import { requestMatchesConfiguredSite } from "../_lib/session-request-state";

export function GET(request: NextRequest): NextResponse {
  const destination = new URL("/auth/sign-in?status=session-ended", request.url);
  const response = NextResponse.redirect(destination, 303);
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Expires", "0");
  response.headers.set("Pragma", "no-cache");

  try {
    const configuration = getIdentityJourneyConfiguration();
    if (!requestMatchesConfiguredSite(request.headers, request.nextUrl, configuration.siteUrl))
      return response;
    const profile = identitySessionCookieProfile(configuration.siteUrl);
    for (const mutation of identitySessionCookieDeletions(profile))
      response.cookies.set(mutation.name, mutation.value, mutation.options);
  } catch {
    // A fixed safe redirect remains available when configuration is unavailable.
  }
  return response;
}
