import type { NextRequest } from "next/server";
import { logRefusal } from "@vortex/platform/schema";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import { getIdentityJourneyConfiguration } from "../../../auth/_lib/authority-configuration";
import {
  runStudioFlowTest,
  studioFlowTestRunRequestSchema,
} from "../../../_lib/studio-flow-test-run";
import { privateJsonResponse } from "../../../_lib/private-response";
import { readBoundedRequestText } from "../../_lib/bounded-request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A builder's test run of one flow in their preview; the run itself is always rolled back. */
export async function POST(request: NextRequest) {
  try {
    if (
      request.headers.get("origin") !== new URL(getIdentityJourneyConfiguration().siteUrl).origin ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
    )
      return privateJsonResponse({ kind: "refused" }, 403);
    const identity = await resolveIdentitySession();
    if (identity.kind !== "active")
      return privateJsonResponse(
        {
          kind: identity.kind === "temporarily_unavailable" ? "temporarily_unavailable" : "refused",
        },
        200,
      );
    const body = await readBoundedRequestText(request, 65_536);
    if (body.kind !== "read") return privateJsonResponse({ kind: "refused" }, 413);
    let candidate: unknown;
    try {
      candidate = JSON.parse(body.text);
    } catch (error) {
      if (error instanceof SyntaxError) return privateJsonResponse({ kind: "refused" }, 400);
      throw error;
    }
    const parsed = studioFlowTestRunRequestSchema.safeParse(candidate);
    if (!parsed.success) return privateJsonResponse({ kind: "refused" }, 400);
    return privateJsonResponse(await runStudioFlowTest(identity.session, parsed.data), 200);
  } catch (error) {
    logRefusal("studio/flow-test-run", "run", "STUDIO_FLOW_TEST_RUN_FAILED", error);
    return privateJsonResponse({ kind: "temporarily_unavailable" }, 503);
  }
}
