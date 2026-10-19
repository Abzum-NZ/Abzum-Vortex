import type { NextRequest } from "next/server";
import { z } from "zod";
import { organizationIdSchema, logRefusal } from "@vortex/platform/schema";
import { readStudioCanvasRecords } from "../../../_lib/studio-canvas-records";
import { readStudioDataRecords } from "../../../_lib/studio-data-records";
import { loadStudioApplicationDraft } from "../../../_lib/studio-application-draft";
import { privateJsonResponse } from "../../../_lib/private-response";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import { getIdentityJourneyConfiguration } from "../../../auth/_lib/authority-configuration";
import { readBoundedRequestText } from "../../_lib/bounded-request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  organizationId: organizationIdSchema,
  operation: z.enum(["canvas", "data", "compile"]),
  candidate: z.unknown(),
}).strict();

/** Read requests run independently of Next's serial mutation action queue. */
export async function POST(request: NextRequest) {
  try {
    if (request.headers.get("origin") !== new URL(getIdentityJourneyConfiguration().siteUrl).origin ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
      return privateJsonResponse({ kind: "refused" }, 403);
    const identity = await resolveIdentitySession();
    if (identity.kind !== "active")
      return privateJsonResponse({ kind: identity.kind === "temporarily_unavailable" ? "temporarily_unavailable" : "refused" }, 200);
    const body = await readBoundedRequestText(request, 131_072);
    if (body.kind !== "read") return privateJsonResponse({ kind: "refused" }, 413);
    const parsed = requestSchema.safeParse(JSON.parse(body.text));
    if (!parsed.success) return privateJsonResponse({ kind: "refused" }, 400);
    const { organizationId, operation, candidate } = parsed.data;
    const run = async () => operation === "canvas"
      ? await readStudioCanvasRecords(identity.session, organizationId, candidate)
      : operation === "data"
        ? await readStudioDataRecords(identity.session, organizationId, candidate)
        : await loadStudioApplicationDraft(organizationId, z.string().parse(candidate));
    let result = await run();
    if (result.kind === "temporarily_unavailable") {
      // The operation logs its cause. A preview moving during this read can invalidate its
      // installation context (40001); retry once with freshly resolved authority and context.
      console.info(`[studio] retrying unavailable ${operation} read: STUDIO_READ_RETRY`);
      result = await run();
    }
    return privateJsonResponse(result, 200);
  } catch (error) {
    logRefusal("studio/read", "read", "STUDIO_READ_FAILED", error);
    return privateJsonResponse({ kind: "temporarily_unavailable" }, 503);
  }
}
