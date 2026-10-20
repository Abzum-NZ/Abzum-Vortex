import type { NextRequest, NextResponse } from "next/server";
import { logRefusal, recordsSelectionCountRequestSchema } from "@vortex/platform/schema";
import { privateJsonResponse as privateResponse } from "../../../_lib/private-response";
import { recordsTableBulkService, resolveBulkRequest } from "../_lib/bulk-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const route = "/api/records-table/selection-count";

/**
 * The count behind "Select all matching records": one capped count of the records a Records table's
 * sealed selection descriptor matches now, read only when the person asks for it.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const resolved = await resolveBulkRequest(request, route, recordsSelectionCountRequestSchema);
    if (resolved.kind === "response") return resolved.response;
    const result = await recordsTableBulkService().count(
      resolved.session,
      resolved.address,
      resolved.body,
    );
    return privateResponse(
      result,
      result.kind === "refused" ? 404 : result.kind === "unavailable" ? 503 : 200,
    );
  } catch (error) {
    logRefusal(route, "records selection count", "selection_count_failed", error);
    return privateResponse({ kind: "unavailable" }, 503);
  }
}
