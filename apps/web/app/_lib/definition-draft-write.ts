import "server-only";

import {
  createHumanApplicationDraftWriter,
  type HumanApplicationDraftWriteResult,
} from "@vortex/access";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { humanOrganizationRequests } from "./server-composition";

const writeApplicationDraft = async (
  organizationId: string,
  candidate: unknown,
  mode: "create" | "save",
): Promise<HumanApplicationDraftWriteResult> => {
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return resolved.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable" }
        : { kind: "refused" };
    const writer = createHumanApplicationDraftWriter({ requests: humanOrganizationRequests() });
    return mode === "create"
      ? await writer.createRoot(resolved.session, organizationId, candidate)
      : await writer.saveDraft(resolved.session, organizationId, candidate);
  } catch {
    return { kind: "temporarily_unavailable" };
  }
};

/** Resolves its own current session; callers supply only organization selection and authored source. */
export const createHumanApplicationDraft = (
  organizationId: string,
  candidate: unknown,
): Promise<HumanApplicationDraftWriteResult> =>
  writeApplicationDraft(organizationId, candidate, "create");

/** A stale save is a visible neutral conflict; no browser identity or authority enters this writer. */
export const saveHumanApplicationDraft = (
  organizationId: string,
  candidate: unknown,
): Promise<HumanApplicationDraftWriteResult> =>
  writeApplicationDraft(organizationId, candidate, "save");
