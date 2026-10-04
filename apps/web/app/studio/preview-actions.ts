"use server";

import { resolveIdentitySession } from "../auth/_lib/session-server";
import {
  previewSavedStudioApplication,
  type StudioApplicationPreviewResult,
} from "../_lib/studio-application-preview";

/** Returns an inert artifact for the saved homepage, never browser source or unsaved edits. */
export async function previewStudioApplicationHomepage(
  organizationId: string,
  candidate: unknown,
): Promise<StudioApplicationPreviewResult> {
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return resolved.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable" } : { kind: "refused", reason: "context_refused" };
    return await previewSavedStudioApplication(resolved.session, organizationId, candidate);
  } catch {
    return { kind: "temporarily_unavailable" };
  }
}
