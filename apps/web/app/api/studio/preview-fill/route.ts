import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  applicationRootIdSchema,
  organizationIdSchema,
  previewInstallationIdSchema,
  revisionSchema,
  logRefusal,
  sameId,
} from "@vortex/platform/schema";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import {
  readStudioPreviewState,
  studioPreviewRunsDraft,
} from "../../../_lib/studio-application-preview";
import { fillStudioPreviewWhenIdle } from "../../../_lib/studio-preview-work";
import { privateJsonResponse } from "../../../_lib/private-response";
import { isOwnSiteJsonRequest, readJsonBody } from "../../_lib/own-site-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const requestSchema = z
  .object({
    organizationId: organizationIdSchema,
    rootId: applicationRootIdSchema,
    draftRevision: revisionSchema,
    previewInstallationId: previewInstallationIdSchema,
  })
  .strict();

/** A cancellable idle lease, opened by a reader only after its visible result has arrived. */
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
    const body = await readJsonBody(request, 1024, requestSchema);
    if (body.kind === "too_large") return privateJsonResponse({ kind: "refused" }, 413);
    if (body.kind !== "read") return privateJsonResponse({ kind: "refused" }, 400);
    const { organizationId, rootId, draftRevision, previewInstallationId } = body.value;
    const state = await readStudioPreviewState(
      identity.session,
      organizationId,
      rootId,
      draftRevision,
    );
    request.signal.throwIfAborted();
    if (state.kind !== "read") return privateJsonResponse(state, 200);
    if (
      state.preview === undefined ||
      studioPreviewRunsDraft(state.draft, state.preview) !== "ready"
    )
      return privateJsonResponse({ kind: "following" }, 200);
    // Only the preview the caller is viewing may be filled on its behalf.
    if (!sameId(state.preview.previewInstallationId, previewInstallationId))
      return privateJsonResponse({ kind: "conflict" }, 200);
    const result = await fillStudioPreviewWhenIdle(
      identity.session,
      organizationId,
      rootId,
      state.preview,
      request.signal,
    );
    return privateJsonResponse(result, 200);
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    logRefusal("studio/preview-fill", "fill", "STUDIO_PREVIEW_FILL_FAILED", error);
    return privateJsonResponse({ kind: "temporarily_unavailable" }, 503);
  }
}
