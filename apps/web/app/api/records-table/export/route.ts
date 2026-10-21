import { NextResponse, type NextRequest } from "next/server";
import {
  logRefusal,
  recordsTableExportRequestSchema,
  type RecordsTableExportRefusal,
} from "@vortex/platform/schema";
import { privateJsonResponse, privateResponse } from "../../../_lib/private-response";
import { createPlacementReadServices } from "../../../_lib/application-page/placement-services";
import { humanOrganizationRequestDependencies } from "../../../_lib/server-composition";
import { getQueryContinuationKey } from "../../../_lib/query-continuation-key";
import { recordsTableExportService, resolveBulkRequest } from "../_lib/bulk-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const route = "/api/records-table/export";

const statusOf = (refusal: RecordsTableExportRefusal): number =>
  refusal.kind === "unavailable"
    ? 503
    : refusal.reason === "request_invalid"
      ? 400
      : refusal.reason === "too_many"
        ? 413
        : refusal.reason === "changed"
          ? 409
          : 403;

/**
 * Downloads the records a person selected in a Records table as a file: the rows they ticked, the
 * records of their current view, or every matching record. The route is thin: it checks the
 * request came from this site's signed-in person, hands the request to the export authority, and
 * streams the file it opens. Everything else (the Export feature, the person's export permission,
 * the columns, the rows, the row limit) is decided by the authority on every request. A refusal
 * before the first byte is a safe JSON message; a failure after it ends the stream, so a file cut
 * short is never saved as a success. The request's abort signal stops the server reading.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const resolved = await resolveBulkRequest(request, route, recordsTableExportRequestSchema);
    if (resolved.kind === "response") return resolved.response;
    const services = createPlacementReadServices({
      session: resolved.session,
      selection: resolved.address.selection,
      dependencies: humanOrganizationRequestDependencies(),
      continuationKey: getQueryContinuationKey(),
      ...resolved.names,
    });
    const result = await recordsTableExportService().prepare(
      resolved.session,
      resolved.address,
      resolved.body,
      services.recordLinkResolver,
      request.signal,
    );
    if (result.kind !== "ready") return privateJsonResponse(result, statusOf(result));
    return privateResponse(
      new NextResponse(result.stream, {
        status: 200,
        headers: {
          "Content-Type": result.mediaType,
          "Content-Disposition": `attachment; filename="${result.filename}"`,
          "X-Content-Type-Options": "nosniff",
          "X-Vortex-Export-Records": String(result.expected),
        },
      }),
    );
  } catch (error) {
    logRefusal(route, "records table export", "export_failed", error);
    return privateJsonResponse({ kind: "unavailable" }, 503);
  }
}
