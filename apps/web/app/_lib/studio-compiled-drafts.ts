import "server-only";

import {
  createBuilderAuthority,
  createDatabaseDefinitionPublicationService,
  DefinitionError,
  readLiveHumanContext,
  requireBuilderAuthority,
  type StoredApplicationDefinitionDraft,
} from "@vortex/platform/server";
import type { ApplicationContent, IdentitySession, OrganizationId } from "@vortex/platform/schema";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { humanOrganizationRequests } from "./server-composition";
import { platformPermissionSource } from "./platform-permission-source";
import { studioDraftTargetFacts } from "./studio-application-draft";

/**
 * The compiled content of recent saved draft revisions, by organisation, Application, revision and
 * source fingerprint. A saved revision never changes, so Studio compiles it once when it opens it
 * after a save, and the canvas reads its records against that same compile. It holds definition
 * content only; every reader still checks the builder's authority and the saved draft first.
 */
const compiled = new Map<string, ApplicationContent>();
const capacity = 64;

const keyOf = (organizationId: string, draft: Pick<StoredApplicationDefinitionDraft, "rootId" | "draftRevision" | "sourceFingerprint">) =>
  `${organizationId}|${draft.rootId}|${draft.draftRevision}|${draft.sourceFingerprint}`.toLowerCase();

/** Keeps the compiled content of one saved draft revision. */
export const rememberCompiledDraft = (
  organizationId: string,
  draft: Pick<StoredApplicationDefinitionDraft, "rootId" | "draftRevision" | "sourceFingerprint">,
  content: ApplicationContent,
): void => {
  const key = keyOf(organizationId, draft);
  compiled.delete(key);
  compiled.set(key, content);
  while (compiled.size > capacity) compiled.delete(compiled.keys().next().value!);
};

/**
 * The compiled content of a saved draft revision the caller has already read under the builder's
 * authority: the one Studio compiled when it opened it, or compiled now.
 */
export const compiledDraftContent = async (
  session: IdentitySession,
  organizationId: OrganizationId,
  draft: StoredApplicationDefinitionDraft,
): Promise<ApplicationContent | "refused" | "temporarily_unavailable" | "conflict"> => {
  const known = compiled.get(keyOf(organizationId, draft));
  if (known !== undefined) return known;
  const result = await humanOrganizationRequests().run(session, { organizationId },
    async (transaction, scope, issuedAt) => {
      const authority = createBuilderAuthority({ transaction, scope, targetFacts: studioDraftTargetFacts,
        permissions: platformPermissionSource });
      await requireBuilderAuthority(authority, { kind: "draft_change", rootId: draft.rootId });
      const context = await readLiveHumanContext(transaction, { scope, session, issuedAt });
      try {
        return (await createDatabaseDefinitionPublicationService(installedReleaseCatalogue, transaction, authority)
          .compileApplicationDraft(context, { rootId: draft.rootId, expectedDraftRevision: draft.draftRevision }))
          .compilation.canonical.content;
      } catch (error) {
        // A newer save replaced this revision while it was read: the newer one's own read follows.
        if (error instanceof DefinitionError && error.code === "DEFINITION_DRAFT_STALE_OR_MISSING") return "conflict" as const;
        throw error;
      }
    });
  if (result.kind !== "available") return result.kind === "temporarily_unavailable" ? "temporarily_unavailable" : "refused";
  if (result.value === "conflict") return "conflict";
  rememberCompiledDraft(organizationId, draft, result.value);
  return result.value;
};
