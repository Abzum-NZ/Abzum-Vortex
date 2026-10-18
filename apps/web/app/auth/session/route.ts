import { NextResponse, type NextRequest } from "next/server";
import { getIdentityJourneyConfiguration } from "../_lib/authority-configuration";
import { refreshIdentitySession, resolveIdentitySession } from "../_lib/session-server";
import { requestMatchesConfiguredSite } from "../_lib/session-request-state";
import { privateResponse } from "../../_lib/private-response";
import { mapWebError } from "../../_lib/web-error-mapper";

// Routes update HttpOnly cookies without re-rendering Studio's layouts or replacing its history.
async function sessionResponse(request: NextRequest, operation: "read" | "refresh") {
  try {
    const configuration = getIdentityJourneyConfiguration();
    if (
      !requestMatchesConfiguredSite(request.headers, request.nextUrl, configuration.siteUrl) ||
      (operation !== "read" &&
        request.headers.get("origin") !== new URL(configuration.siteUrl).origin)
    )
      return privateResponse(NextResponse.json({ kind: "refused" }, { status: 403 }));
    const result =
      operation === "refresh" ? await refreshIdentitySession() : await resolveIdentitySession();
    return privateResponse(NextResponse.json({ kind: result.kind }));
  } catch (error) {
    return mapWebError(error, {
      route: "auth/session",
      operation,
      code: "SESSION_REQUEST_FAILED",
      fallback: privateResponse(
        NextResponse.json({ kind: "temporarily_unavailable" }, { status: 503 }),
      ),
    });
  }
}

export async function GET(request: NextRequest) {
  return sessionResponse(request, "read");
}
export async function POST(request: NextRequest) {
  return sessionResponse(request, "refresh");
}
