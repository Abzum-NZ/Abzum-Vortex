import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { flowBindingInvocationSchema } from "@vortex/platform/schema";
import { invokeInstalledFlow } from "@web/platform-server";
import { resolveApplicationAddress } from "../../../_lib/application-address";
import { flowInvocationAdapters } from "../../../_lib/flow-invocation-adapters";
import { readBoundedRequestText } from "../../_lib/bounded-request-body";
import { getIdentityJourneyConfiguration } from "../../../auth/_lib/authority-configuration";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import { privateJsonResponse as privateResponse } from "../../../_lib/private-response";
import { mapWebError } from "../../../_lib/web-error-mapper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maximumRequestBodyLength = 131_072;
const requestSchema = z
  .object({
    tenantShortName: z.string().min(1).max(200),
    organizationShortName: z.string().min(1).max(200),
    applicationKey: z.string().min(1).max(200),
    pageKey: z.string().min(1).max(200),
    invocation: flowBindingInvocationSchema,
  })
  .strict();

const refusedResponse = (): NextResponse => privateResponse({ kind: "refused" }, 404);

/** Cookie-backed flow starts must originate from this site's JSON client. */
const fromOwnSite = (request: NextRequest): boolean => {
  const origin = request.headers.get("origin");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return (
    origin !== null &&
    origin === new URL(getIdentityJourneyConfiguration().siteUrl).origin &&
    contentType === "application/json"
  );
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    if (!fromOwnSite(request)) return privateResponse({ kind: "refused" }, 403);
    const identity = await resolveIdentitySession();
    if (identity.kind === "temporarily_unavailable")
      return privateResponse({ kind: "unavailable" }, 503);
    if (identity.kind !== "active") return privateResponse({ kind: "refused" }, 401);

    const read = await readBoundedRequestText(request, maximumRequestBodyLength);
    if (read.kind === "too_large") return privateResponse({ kind: "refused" }, 413);
    if (read.kind === "unreadable") return refusedResponse();
    let parsedBody: z.ZodSafeParseResult<z.infer<typeof requestSchema>>;
    try {
      parsedBody = requestSchema.safeParse(JSON.parse(read.text));
    } catch {
      return refusedResponse();
    }
    if (!parsedBody.success) return refusedResponse();
    const body = parsedBody.data;
    const address = await resolveApplicationAddress(
      identity.session,
      body.tenantShortName,
      body.organizationShortName,
      body.applicationKey,
      body.pageKey,
    );
    if (address.kind === "temporarily_unavailable")
      return privateResponse({ kind: "unavailable" }, 503);
    if (address.kind !== "application_page") return refusedResponse();

    const result = await invokeInstalledFlow(
      identity.session,
      body,
      address,
      flowInvocationAdapters(address, body),
    );
    if (result.kind === "refused") return refusedResponse();
    return privateResponse(result, result.kind === "reload" ? 409 : 200);
  } catch (error) {
    return mapWebError(error, {
      route: "/api/flows/invoke",
      operation: "invoke",
      code: "FLOW_INVOCATION_FAILED",
      fallback: privateResponse({ kind: "unavailable" }, 503),
    });
  }
}
