import type { NextRequest, NextResponse } from "next/server";
import { logRefusal, recordsTableBatchEditRequestSchema } from "@vortex/platform/schema";
import { createRecordsTableBatchEditService } from "@vortex/platform/server";
import { humanOrganizationRequestDependencies } from "../../../_lib/server-composition";
import { privateJsonResponse as privateResponse } from "../../../_lib/private-response";
import { getQueryContinuationKey } from "../../../_lib/query-continuation-key";
import { prepareRuntimePreviewChoices } from "../../../_lib/runtime-preview-demand";
import { resolveBulkRequest } from "../_lib/bulk-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const route = "/api/records-table/batch-edit";

/** Room for 200 records of 50 values each; the schema bounds the rest. */
const maximumBatchBodyLength = 1_048_576;

/** The one batch edit service of a Records table, composed for this request. */
const batchEditService = () =>
  createRecordsTableBatchEditService({
    ...humanOrganizationRequestDependencies(),
    channel: "web",
    continuationKey: getQueryContinuationKey(),
    // A pasted link title is read from its target record type, which a Studio preview makes ready.
    prepareLinkTargets: async (session, installed, recordTypeIds) => {
      const demand = await prepareRuntimePreviewChoices(session, installed, recordTypeIds);
      return demand.kind === "ready"
        ? "ready"
        : demand.kind === "temporarily_unavailable"
          ? "temporarily_unavailable"
          : "refused";
    },
  });

/**
 * Pastes, fills or undoes cells of the shown page: one to 200 records, each with the revision the
 * person saw, saved all together or not at all. Every cell is decided again on the server per
 * request; a refusal lists each record and field that stopped the batch.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const resolved = await resolveBulkRequest(
      request,
      route,
      recordsTableBatchEditRequestSchema,
      maximumBatchBodyLength,
    );
    if (resolved.kind === "response") return resolved.response;
    const result = await batchEditService().run(resolved.session, resolved.address, resolved.body);
    return privateResponse(
      result,
      result.kind === "refused" ? 409 : result.kind === "unavailable" ? 503 : 200,
    );
  } catch (error) {
    logRefusal(route, "records table batch edit", "batch_edit_failed", error);
    return privateResponse({ kind: "unavailable" }, 503);
  }
}
