import type { NextRequest, NextResponse } from "next/server";
import { logRefusal, recordsTableRunRequestSchema } from "@vortex/platform/schema";
import { privateJsonResponse as privateResponse } from "../../../_lib/private-response";
import { recordsTableRunService, resolveBulkRequest } from "../_lib/bulk-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const route = "/api/records-table/run";

/**
 * Where a background run a table's action started has got to: read by the person who started it,
 * for the reference the start returned. It never returns what the run produced.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const resolved = await resolveBulkRequest(request, route, recordsTableRunRequestSchema);
    if (resolved.kind === "response") return resolved.response;
    const result = await recordsTableRunService().read(
      resolved.session,
      resolved.address,
      resolved.body,
    );
    return privateResponse(
      result,
      result.kind === "refused" ? 404 : result.kind === "unavailable" ? 503 : 200,
    );
  } catch (error) {
    logRefusal(route, "records table run read", "run_read_failed", error);
    return privateResponse({ kind: "unavailable" }, 503);
  }
}
