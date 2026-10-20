import type { NextRequest, NextResponse } from "next/server";
import { logRefusal, namedActionAvailabilityRequestSchema } from "@vortex/platform/schema";
import { readRecordsTableNamedActionAvailability } from "@vortex/platform/server";
import { privateJsonResponse } from "../../../_lib/private-response";
import { getQueryContinuationKey } from "../../../_lib/query-continuation-key";
import { humanOrganizationRequestDependencies } from "../../../_lib/server-composition";
import { resolveBulkRequest } from "../_lib/bulk-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const route = "/api/records-table/action-availability";

/** One bounded read on selection intent; matching descriptors remain execution-only decisions. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const resolved = await resolveBulkRequest(request, route, namedActionAvailabilityRequestSchema);
    if (resolved.kind === "response") return resolved.response;
    const result = await readRecordsTableNamedActionAvailability(
      {
        ...humanOrganizationRequestDependencies(),
        channel: "web",
        continuationKey: getQueryContinuationKey(),
      },
      resolved.session,
      resolved.address,
      resolved.body,
    );
    return privateJsonResponse(
      result,
      result.kind === "refused" ? 404 : result.kind === "unavailable" ? 503 : 200,
    );
  } catch (error) {
    logRefusal(route, "records table action availability", "availability_failed", error);
    return privateJsonResponse({ kind: "unavailable" }, 503);
  }
}
