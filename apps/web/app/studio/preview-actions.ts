"use server";

import { resolveIdentitySession } from "../auth/_lib/session-server";
import {
  provisionStudioApplicationPreview,
  type StudioApplicationPreviewResult,
} from "../_lib/studio-application-preview";

/** Provisions the running preview of the saved draft; never browser source or unsaved edits. */
export async function previewStudioApplication(
  organizationId: string,
  candidate: unknown,
): Promise<StudioApplicationPreviewResult> {
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return resolved.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable" }
        : { kind: "refused", reason: "permission_refused" };
    return await provisionStudioApplicationPreview(resolved.session, organizationId, candidate);
  } catch {
    return { kind: "temporarily_unavailable" };
  }
}
