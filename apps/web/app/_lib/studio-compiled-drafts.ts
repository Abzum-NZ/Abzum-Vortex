import "server-only";

import {
  createBuilderAuthority,
  createDatabaseDefinitionPublicationService,
  DefinitionError,
  readLiveHumanContext,
  requireBuilderAuthority,
  type StoredApplicationDefinitionDraft,
  type ApplicationDraftCompilation,
} from "@vortex/platform/server";
import type { IdentitySession, OrganizationId } from "@vortex/platform/schema";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { humanOrganizationRequests } from "./server-composition";
import { platformPermissionSource } from "./platform-permission-source";
import { studioDraftTargetFacts } from "./studio-application-draft";

/**
 * Read compiled content through the platform's one draft compilation cache. Its lookup checks
 * current authority and dependency revisions, even when the saved source itself has not changed.
 */
export const compiledStudioDraft = async (
  session: IdentitySession,
  organizationId: OrganizationId,
  draft: Pick<StoredApplicationDefinitionDraft, "rootId" | "draftRevision">,
): Promise<ApplicationDraftCompilation | "refused" | "temporarily_unavailable" | "conflict"> => {
  const result = await humanOrganizationRequests().run(
    session,
    { organizationId },
    async (transaction, scope, issuedAt) => {
      const authority = createBuilderAuthority({
        transaction,
        scope,
        targetFacts: studioDraftTargetFacts,
        permissions: platformPermissionSource,
      });
      await requireBuilderAuthority(authority, { kind: "draft_change", rootId: draft.rootId });
      const context = await readLiveHumanContext(transaction, { scope, session, issuedAt });
      try {
        return await createDatabaseDefinitionPublicationService(
          installedReleaseCatalogue,
          transaction,
          authority,
        ).compileApplicationDraft(context, {
          rootId: draft.rootId,
          expectedDraftRevision: draft.draftRevision,
        });
      } catch (error) {
        // A newer save replaced this revision while it was read: the newer one's own read follows.
        if (error instanceof DefinitionError && error.code === "DEFINITION_DRAFT_STALE_OR_MISSING")
          return "conflict" as const;
        throw error;
      }
    },
  );
  if (result.kind !== "available")
    return result.kind === "temporarily_unavailable" ? "temporarily_unavailable" : "refused";
  if (result.value === "conflict") return "conflict";
  return result.value;
};
