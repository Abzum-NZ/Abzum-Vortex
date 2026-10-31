import type { NextRequest } from "next/server";
import { logRefusal } from "@vortex/platform/schema";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import {
  runStudioFlowTest,
  studioFlowTestRunRequestSchema,
} from "../../../_lib/studio-flow-test-run";
import { privateJsonResponse } from "../../../_lib/private-response";
import { isOwnSiteJsonRequest, readJsonBody } from "../../_lib/own-site-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A builder's test run of one flow in their preview; the run itself is always rolled back. */
export async function POST(request: NextRequest) {
  try {
    if (!isOwnSiteJsonRequest(request)) return privateJsonResponse({ kind: "refused" }, 403);
    const identity = await resolveIdentitySession();
    if (identity.kind !== "active")
      return privateJsonResponse(
        {
          kind: identity.kind === "temporarily_unavailable" ? "temporarily_unavailable" : "refused",
        },
        identity.kind === "temporarily_unavailable" ? 503 : 401,
      );
    const body = await readJsonBody(request, 65_536, studioFlowTestRunRequestSchema);
    if (body.kind === "too_large") return privateJsonResponse({ kind: "refused" }, 413);
    if (body.kind !== "read") return privateJsonResponse({ kind: "refused" }, 400);
    return privateJsonResponse(await runStudioFlowTest(identity.session, body.value), 200);
  } catch (error) {
    logRefusal("studio/flow-test-run", "run", "STUDIO_FLOW_TEST_RUN_FAILED", error);
    return privateJsonResponse({ kind: "temporarily_unavailable" }, 503);
  }
}
