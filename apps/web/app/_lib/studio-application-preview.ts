import "server-only";

import {
  createBuilderAuthority,
  createDatabaseDefinitionPublicationService,
  createPreviewInstallationCoordinator,
  DefinitionError,
  previewApplicationKey,
  type BuilderTargetFactsReader,
  type DatabaseRow,
} from "@vortex/platform/server";
import {
  applicationRootIdSchema,
  organizationIdSchema,
  revisionSchema,
  sameId,
  type IdentitySession,
} from "@vortex/platform/schema";
import { z } from "zod";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { humanOrganizationRequests } from "./server-composition";
import { platformPermissionSource } from "./platform-permission-source";
import { loadOrganizationLauncher } from "./organization-context";
import { organizationAddressPath } from "./address-paths";

const previewRequestSchema = z
  .object({
    rootId: applicationRootIdSchema,
    draftRevision: revisionSchema,
  })
  .strict();

/** The running preview of a saved draft: where it opens, which draft it runs and until when. */
export type StudioApplicationPreviewResult =
  | Readonly<{ kind: "provisioned"; href: string; draftRevision: number; expiresAt: string }>
  | Readonly<{ kind: "refused"; reason: "invalid_request" | "permission_refused" | "not_installed" }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

type ClassificationRow = DatabaseRow & { outcome: unknown; application_origin_kind: unknown };

class ContextRefused extends Error {}

/** No default classification exists for an addressed root, including an unknown root. */
const targetFacts: BuilderTargetFactsReader = async (transaction, _scope, rootId) => {
  if (rootId === undefined) throw new ContextRefused();
  const rows = await transaction.query<ClassificationRow>`
    select outcome, application_origin_kind
    from vortex_definition.read_builder_application_root_classification(${rootId}::uuid)
  `;
  const row = rows[0];
  if (rows.length !== 1 || row === undefined || row.outcome !== "available" ||
    (row.application_origin_kind !== "ordinary" &&
      row.application_origin_kind !== "platform_system_application"))
    throw new ContextRefused();
  return { isSystemApplication: row.application_origin_kind === "platform_system_application" };
};

const coordinator = () =>
  createPreviewInstallationCoordinator({
    installerRequests: humanOrganizationRequests(),
    releaseCatalogue: installedReleaseCatalogue,
    builderAuthority: (transaction, scope) =>
      createBuilderAuthority({ transaction, scope, targetFacts, permissions: platformPermissionSource }),
    draftRehearsal: (transaction, authority) =>
      createDatabaseDefinitionPublicationService(installedReleaseCatalogue, transaction, authority),
  });

const failure = (error: unknown): StudioApplicationPreviewResult => {
  const code = error instanceof DefinitionError ? error.code : undefined;
  switch (code) {
    case "PREVIEW_INSTALLATION_STALE":
      return { kind: "conflict" };
    case "PREVIEW_INSTALLATION_PERMISSION_REFUSED":
    case "PREVIEW_INSTALLATION_REFUSED":
      return { kind: "refused", reason: "permission_refused" };
    case "INVALID_PREVIEW_INSTALLATION_COMMAND":
      return { kind: "refused", reason: "invalid_request" };
    case "PREVIEW_INSTALLATION_TEMPORARILY_UNAVAILABLE":
      return { kind: "temporarily_unavailable" };
  }
  console.error("[studio] preview provisioning failed", error);
  return { kind: "temporarily_unavailable" };
};

/**
 * Provisions, or replaces, the running preview of the saved Application draft at the given
 * revision and returns its address. The session is the server-resolved one; the browser names
 * only the root and the saved revision it expects.
 */
export const provisionStudioApplicationPreview = async (
  session: IdentitySession,
  candidateOrganizationId: string,
  candidate: unknown,
): Promise<StudioApplicationPreviewResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const request = previewRequestSchema.safeParse(candidate);
  if (!organization.success || !request.success)
    return { kind: "refused", reason: "invalid_request" };
  let preview;
  try {
    preview = await coordinator().create(session, {
      organizationId: organization.data,
      applicationRootId: request.data.rootId,
      expectedDraftRevision: request.data.draftRevision,
    });
  } catch (error) {
    if (error instanceof DefinitionError && error.code === "PREVIEW_INSTALLATION_FAILED") {
      const cause = (error as { cause?: unknown }).cause;
      if (cause instanceof Error && /no release to preview/i.test(cause.message))
        return { kind: "refused", reason: "not_installed" };
    }
    return failure(error);
  }
  const launcher = await loadOrganizationLauncher(session);
  if (launcher.kind !== "available") return { kind: "temporarily_unavailable" };
  const entry = launcher.entries.find((item) => sameId(item.organizationId, preview.organizationId));
  if (entry === undefined) return { kind: "refused", reason: "permission_refused" };
  // The preview's own address: its home page opens there, as an installed Application's does.
  return {
    kind: "provisioned",
    href: `${organizationAddressPath(entry.tenantShortName, entry.organizationShortName)}/${encodeURIComponent(previewApplicationKey(preview.previewInstallationId))}`,
    draftRevision: preview.draftRevision,
    expiresAt: preview.expiresAt,
  };
};
