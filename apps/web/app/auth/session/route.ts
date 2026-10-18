import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { signInWithPassword } from "@vortex/platform/server";
import { getIdentityJourneyConfiguration } from "../_lib/authority-configuration";
import {
  bootstrapIdentitySession,
  refreshIdentitySession,
  resolveIdentitySession,
} from "../_lib/session-server";
import { requestMatchesConfiguredSite } from "../_lib/session-request-state";
import { privateResponse } from "../../_lib/private-response";
import { mapWebError } from "../../_lib/web-error-mapper";

const credentialsSchema = z
  .object({ email: z.string().max(320), password: z.string().max(1024) })
  .strict();

// Routes update HttpOnly cookies without re-rendering Studio's layouts or replacing its history.
async function sessionResponse(request: NextRequest, operation: "read" | "refresh" | "sign-in") {
  try {
    const configuration = getIdentityJourneyConfiguration();
    if (
      !requestMatchesConfiguredSite(request.headers, request.nextUrl, configuration.siteUrl) ||
      (operation !== "read" &&
        request.headers.get("origin") !== new URL(configuration.siteUrl).origin)
    )
      return privateResponse(NextResponse.json({ kind: "refused" }, { status: 403 }));
    if (operation === "sign-in") {
      const body = credentialsSchema.safeParse(await request.json());
      if (!body.success)
        return privateResponse(NextResponse.json({ kind: "invalid_credentials" }, { status: 400 }));
      const signedIn = await signInWithPassword(
        configuration,
        body.data.email.trim(),
        body.data.password,
      );
      if (!signedIn.ok)
        return privateResponse(
          NextResponse.json({
            kind:
              signedIn.code === "vortex.identity.authority_unavailable"
                ? "temporarily_unavailable"
                : "invalid_credentials",
          }),
        );
      const result = await bootstrapIdentitySession(signedIn);
      return privateResponse(NextResponse.json({ kind: result.kind }));
    }
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
export async function PUT(request: NextRequest) {
  return sessionResponse(request, "sign-in");
}
