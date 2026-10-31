import type { NextRequest } from "next/server";
import { z } from "zod";
import { logRefusal } from "@vortex/platform/schema";
import { storeConnectionSecret } from "@vortex/platform/server";
import { resolveApplicationAddress } from "../../_lib/application-address";
import { pageAddressSchema } from "../../_lib/page-address-schema";
import { privateJsonResponse } from "../../_lib/private-response";
import { humanOrganizationRequests } from "../../_lib/server-composition";
import { resolveIdentitySession } from "../../auth/_lib/session-server";
import { isOwnSiteJsonRequest, readJsonBody } from "../_lib/own-site-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = pageAddressSchema
  .pick({ tenantShortName: true, organizationShortName: true, applicationKey: true })
  .extend({ secret: z.string().min(1).max(8192) })
  .strict();

const refuse = (code: string, status = 403, cause?: unknown) => {
  logRefusal("connection", "store secret", code, cause);
  return privateJsonResponse({ outcome: "refused" }, status);
};

export async function POST(request: NextRequest) {
  try {
    if (!isOwnSiteJsonRequest(request)) return refuse("request_not_from_own_site");
    const identity = await resolveIdentitySession();
    if (identity.kind !== "active")
      return refuse("identity_not_active", identity.kind === "temporarily_unavailable" ? 503 : 401);
    const body = await readJsonBody(request, 65_536, requestSchema);
    if (body.kind === "too_large") return refuse("body_too_large", 413);
    if (body.kind !== "read") return refuse(`body_${body.kind}`, 400);
    const input = body.value;
    const address = await resolveApplicationAddress(
      identity.session,
      input.tenantShortName,
      input.organizationShortName,
      input.applicationKey,
    );
    if (address.kind !== "application_page") return refuse(`address_${address.kind}`);
    const result = await humanOrganizationRequests().runChange(
      identity.session,
      {
        organizationId: address.read.organizationId,
        applicationRootId: address.application.applicationRootId,
      },
      (transaction) => storeConnectionSecret(transaction, input.secret),
    );
    if (result.kind !== "available") return refuse(`protected_${result.kind}`);
    return privateJsonResponse({ reference: result.value }, 200);
  } catch {
    // A request body may contain a secret; never log an exception that could include its contents.
    return refuse("secret_storage_unavailable", 503);
  }
}
