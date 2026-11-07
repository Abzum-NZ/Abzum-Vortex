import "server-only";

import { describeFailure, organizationIdSchema } from "@vortex/platform/schema";
import { logRefusal, readVisiblePersonLabels } from "@vortex/platform/server";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { humanOrganizationRequests } from "./server-composition";
import type { StudioPersonLabel } from "./studio-application-restore-contracts";

/**
 * Reads how the signed-in viewer may see one person in Studio: by display name, or restricted when
 * the viewer's directory projection does not include them. A failed read is `unavailable` and is
 * logged with its cause; it is never presented as a permission refusal.
 */
export async function readStudioPersonLabel(
  organizationId: string,
  organizationAccountId: string,
): Promise<StudioPersonLabel> {
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active") {
      // A missing or ended session is an expected refusal; an unavailable one is a platform fault.
      if (resolved.kind === "temporarily_unavailable")
        console.error("[studio] person label failed: session temporarily_unavailable");
      else logRefusal("studio", "person label", `session_${resolved.kind}`);
      return { kind: "unavailable" };
    }
    const result = await humanOrganizationRequests().run(
      resolved.session,
      { organizationId: organizationIdSchema.parse(organizationId) },
      async (transaction): Promise<ReadonlyMap<string, string>> =>
        readVisiblePersonLabels(transaction, [organizationAccountId]),
    );
    // The request runner logged an answer that is not available, once.
    if (result.kind !== "available") return { kind: "unavailable" };
    const name = result.value.get(organizationAccountId.toLowerCase());
    return name === undefined ? { kind: "restricted" } : { kind: "named", name };
  } catch (error) {
    console.error(
      `[studio] person label read failed: STUDIO_PERSON_LABEL_READ_FAILED cause=${describeFailure(error)}`,
    );
    return { kind: "unavailable" };
  }
}
