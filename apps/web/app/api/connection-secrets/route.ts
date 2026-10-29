import type { NextRequest } from "next/server";
import { z } from "zod";
import { logRefusal } from "@vortex/platform/schema";
import { storeConnectionSecret } from "@vortex/platform/server";
import { resolveApplicationAddress } from "../../_lib/application-address";
import { privateJsonResponse } from "../../_lib/private-response";
import { humanOrganizationRequests } from "../../_lib/server-composition";
import { getIdentityJourneyConfiguration } from "../../auth/_lib/authority-configuration";
import { resolveIdentitySession } from "../../auth/_lib/session-server";
import { readBoundedRequestBytes } from "../_lib/bounded-request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const commandSchema = z.object({ secret: z.string().min(1).max(8192) }).strict();
const refuse = (code: string, status = 403) => {
  logRefusal("connection", "store secret", code);
  return privateJsonResponse({ outcome: "refused" }, status);
};

export async function POST(request: NextRequest) {
  try {
    const origin = new URL(getIdentityJourneyConfiguration().siteUrl).origin;
    if (request.headers.get("origin") !== origin) return refuse("origin_refused");
    const referer = request.headers.get("referer");
    if (referer === null) return refuse("address_missing");
    const source = new URL(referer);
    if (source.origin !== origin) return refuse("address_refused");
    const [tenant, organization, application] = source.pathname.split("/").slice(1, 4);
    if (!tenant || !organization || !application) return refuse("address_invalid", 400);
    const identity = await resolveIdentitySession();
    if (identity.kind !== "active") return refuse("identity_not_active", 401);
    const address = await resolveApplicationAddress(
      identity.session,
      decodeURIComponent(tenant),
      decodeURIComponent(organization),
      decodeURIComponent(application),
    );
    if (address.kind !== "application_page") return refuse("address_refused");
    const bytes = await readBoundedRequestBytes(request, 65536);
    if (bytes.kind !== "read")
      return refuse(`body_${bytes.kind}`, bytes.kind === "too_large" ? 413 : 400);
    let candidate: unknown;
    try {
      candidate = JSON.parse(new TextDecoder().decode(bytes.bytes));
    } catch {
      return refuse("body_invalid", 400);
    }
    const command = commandSchema.safeParse(candidate);
    if (!command.success) return refuse("command_invalid", 400);
    const result = await humanOrganizationRequests().runChange(
      identity.session,
      {
        organizationId: address.read.organizationId,
        applicationRootId: address.application.applicationRootId,
      },
      (transaction) => storeConnectionSecret(transaction, command.data.secret),
    );
    if (result.kind !== "available") return refuse(`protected_${result.kind}`);
    return privateJsonResponse({ reference: result.value }, 200);
  } catch {
    // A request body may contain a secret; never log an exception that could include its contents.
    return refuse("secret_storage_unavailable", 503);
  }
}
