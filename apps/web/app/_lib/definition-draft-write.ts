import "server-only";

import {
  createHumanApplicationDraftWriter,
  type HumanApplicationDraftWriteResult,
} from "@vortex/platform/server";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { humanOrganizationRequests } from "./server-composition";
import { mapWebError } from "./web-error-mapper";
import { platformPermissionSource } from "./platform-permission-source";

const writeApplicationDraft = async (
  organizationId: string,
  candidate: unknown,
  mode: "save",
): Promise<HumanApplicationDraftWriteResult> => {
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active") {
      console.error(
        `[studio] application draft ${mode} refused STUDIO_DRAFT_${mode.toUpperCase()}_SESSION_NOT_ACTIVE: ${resolved.kind}`,
      );
      return resolved.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable" }
        : { kind: "refused", reason: "session_ended" };
    }
    const writer = createHumanApplicationDraftWriter({
      requests: humanOrganizationRequests(),
      permissions: platformPermissionSource,
    });
    return await writer.saveDraft(resolved.session, organizationId, candidate);
  } catch (error) {
    return mapWebError(error, {
      route: "definition-draft-write",
      operation: "save",
      code: "DEFINITION_DRAFT_SAVE_FAILED",
      fallback: { kind: "temporarily_unavailable" },
    });
  }
};

/** Source validation belongs to the platform store; this boundary resolves only the live session. */
export const saveHumanApplicationDraft = (
  organizationId: string,
  candidate: unknown,
): Promise<HumanApplicationDraftWriteResult> =>
  writeApplicationDraft(organizationId, candidate, "save");
