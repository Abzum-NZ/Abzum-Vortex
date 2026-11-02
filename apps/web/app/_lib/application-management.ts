import "server-only";

import { createBuilderAuthority } from "@vortex/platform/server";
import {
  organizationSelectionCandidateSchema,
  type IdentitySession,
} from "@vortex/platform/schema";
import { humanOrganizationRequests } from "./server-composition";
import { platformPermissionSource } from "./platform-permission-source";

/**
 * Whether the person may manage this organisation's applications (install, upgrade, remove): the
 * one decision the App Store makes before it shows an install control, so the editor's Install icon
 * and the flows' install action never disagree with it. Undefined when it cannot be decided now.
 * The protected operations decide again when the change is made.
 */
export const mayManageApplications = async (
  session: IdentitySession,
  organizationId: string,
): Promise<boolean | undefined> => {
  const selection = organizationSelectionCandidateSchema.parse({ organizationId });
  const decided = await humanOrganizationRequests().run(
    session,
    selection,
    async (transaction, scope) =>
      (
        await createBuilderAuthority({
          transaction,
          scope,
          targetFacts: async () => ({ isSystemApplication: false }),
          permissions: platformPermissionSource,
        }).require({ kind: "application_management" })
      ).outcome === "allowed",
  );
  return decided.kind === "available" ? decided.value : undefined;
};
