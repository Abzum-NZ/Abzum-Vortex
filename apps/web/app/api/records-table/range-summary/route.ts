import type { NextRequest, NextResponse } from "next/server";
import { logRefusal, recordsRangeSummaryRequestSchema } from "@vortex/platform/schema";
import { createRecordsRangeSummaryService } from "@vortex/platform/server";
import { getQueryContinuationKey } from "../../../_lib/query-continuation-key";
import { humanOrganizationRequestDependencies } from "../../../_lib/server-composition";
import { privateJsonResponse as privateResponse } from "../../../_lib/private-response";
import { resolveBulkRequest } from "../_lib/bulk-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const route = "/api/records-table/range-summary";

/** The one range summary service of a Records table, composed for this request. */
const rangeSummaryService = () =>
  createRecordsRangeSummaryService({
    ...humanOrganizationRequestDependencies(),
    channel: "web",
    continuationKey: getQueryContinuationKey(),
  });

/**
 * The status bar totals of a selected range: one protected read of the shown page, totalled on the
 * server for the selected rows of that page. Everything is decided again per request.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const resolved = await resolveBulkRequest(request, route, recordsRangeSummaryRequestSchema);
    if (resolved.kind === "response") return resolved.response;
    const result = await rangeSummaryService().summarise(
      resolved.session,
      resolved.address,
      resolved.body,
    );
    return privateResponse(
      result,
      result.kind === "refused" ? 404 : result.kind === "unavailable" ? 503 : 200,
    );
  } catch (error) {
    logRefusal(route, "records range summary", "range_summary_failed", error);
    return privateResponse({ kind: "unavailable" }, 503);
  }
}
