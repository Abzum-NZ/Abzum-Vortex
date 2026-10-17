import "server-only";

import {
  createBuilderAuthority,
  createDatabaseDefinitionPublicationService,
  createPreviewInstallationCoordinator,
  createPreviewInstallationRepository,
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
  | Readonly<{
      kind: "refused";
      reason: "invalid_request" | "permission_refused";
    }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

/** The builder's preview of the saved draft at one revision, or why there is none. */
export type StudioPreviewResult =
  | Readonly<{
      kind: "available";
      previewInstallationId: string;
      organizationId: string;
      draftRevision: number;
      expiresAt: string;
      /** An existing preview that holds copied live records: a read decides them again first. */
      reusedSeeded: boolean;
    }>
  | Exclude<StudioApplicationPreviewResult, { kind: "provisioned" }>;

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
  if (
    rows.length !== 1 ||
    row === undefined ||
    row.outcome !== "available" ||
    (row.application_origin_kind !== "ordinary" &&
      row.application_origin_kind !== "platform_system_application")
  )
    throw new ContextRefused();
  return { isSystemApplication: row.application_origin_kind === "platform_system_application" };
};

const coordinator = () =>
  createPreviewInstallationCoordinator({
    installerRequests: humanOrganizationRequests(),
    releaseCatalogue: installedReleaseCatalogue,
    builderAuthority: (transaction, scope) =>
      createBuilderAuthority({
        transaction,
        scope,
        targetFacts,
        permissions: platformPermissionSource,
      }),
    draftRehearsal: (transaction, authority) =>
      createDatabaseDefinitionPublicationService(installedReleaseCatalogue, transaction, authority),
  });

const failure = (error: unknown): Exclude<StudioPreviewResult, { kind: "available" }> => {
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

/** A preview reused for a new read keeps at least this long, so it does not expire while Studio reads it. */
const reuseMarginMs = 60 * 60 * 1000;

/**
 * Provisionings in flight, by builder, Application and draft revision. Studio's canvas areas and
 * Data tab ask for the same preview together; one provisioning serves them all instead of each
 * replacing the others' preview. It holds only the pending provisioning, never an access decision:
 * every read in the preview is still decided by the database for the requesting builder.
 */
const provisioning = new Map<string, Promise<StudioPreviewResult>>();

const provision = (
  session: IdentitySession,
  organizationId: string,
  rootId: string,
  draftRevision: number,
): Promise<StudioPreviewResult> => {
  const key = `${session.identityId}|${organizationId}|${rootId}|${draftRevision}`.toLowerCase();
  const pending = provisioning.get(key);
  if (pending !== undefined) return pending;
  const started = coordinator()
    .create(session, { organizationId, applicationRootId: rootId, expectedDraftRevision: draftRevision })
    .then(
      (preview): StudioPreviewResult => ({
        kind: "available",
        previewInstallationId: preview.previewInstallationId,
        organizationId: preview.organizationId,
        draftRevision: preview.draftRevision,
        expiresAt: preview.expiresAt,
        reusedSeeded: false,
      }),
      failure,
    )
    .finally(() => provisioning.delete(key));
  provisioning.set(key, started);
  return started;
};

/**
 * The builder's one preview of the saved Application draft at exactly this revision: their current
 * preview when it runs this revision, otherwise a new one that replaces it. Studio's canvas, its
 * Data tab and its Preview button all run on this one preview.
 */
export const currentStudioPreview = async (
  session: IdentitySession,
  candidateOrganizationId: string,
  candidate: unknown,
): Promise<StudioPreviewResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const request = previewRequestSchema.safeParse(candidate);
  if (!organization.success || !request.success)
    return { kind: "refused", reason: "invalid_request" };
  const { rootId, draftRevision } = request.data;
  let found;
  try {
    found = await humanOrganizationRequests().run(
      session,
      { organizationId: organization.data },
      (transaction) => createPreviewInstallationRepository(transaction).readBuilderPreview(rootId),
    );
  } catch (error) {
    return failure(error);
  }
  if (found.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
  if (found.kind !== "available") return { kind: "refused", reason: "permission_refused" };
  const current = found.value;
  if (
    current !== undefined &&
    (!sameId(current.applicationRootId, rootId) || !sameId(current.organizationId, organization.data))
  ) {
    console.error("[studio] preview lookup unavailable: STUDIO_PREVIEW_LOOKUP_MISMATCH");
    return { kind: "temporarily_unavailable" };
  }
  // A preview of a newer saved revision means this request's draft revision is no longer current.
  if (current !== undefined && current.draftRevision > draftRevision) return { kind: "conflict" };
  if (
    current !== undefined &&
    current.draftRevision === draftRevision &&
    Date.parse(current.expiresAt) - Date.now() > reuseMarginMs
  )
    return {
      kind: "available",
      previewInstallationId: current.previewInstallationId,
      organizationId: current.organizationId,
      draftRevision: current.draftRevision,
      expiresAt: current.expiresAt,
      reusedSeeded: current.seeded,
    };
  return provision(session, organization.data, rootId, draftRevision);
};

/**
 * The running preview of the saved Application draft at the given revision and its address: the
 * builder's current preview of that revision, or a new one replacing it. The session is the
 * server-resolved one; the browser names only the root and the saved revision it expects.
 */
export const provisionStudioApplicationPreview = async (
  session: IdentitySession,
  candidateOrganizationId: string,
  candidate: unknown,
): Promise<StudioApplicationPreviewResult> => {
  const preview = await currentStudioPreview(session, candidateOrganizationId, candidate);
  if (preview.kind !== "available") return preview;
  const launcher = await loadOrganizationLauncher(session);
  if (launcher.kind !== "available") return { kind: "temporarily_unavailable" };
  const entry = launcher.entries.find((item) =>
    sameId(item.organizationId, preview.organizationId),
  );
  if (entry === undefined) return { kind: "refused", reason: "permission_refused" };
  // The preview's own address: its home page opens there, as an installed Application's does.
  return {
    kind: "provisioned",
    href: `${organizationAddressPath(entry.tenantShortName, entry.organizationShortName)}/${encodeURIComponent(previewApplicationKey(preview.previewInstallationId))}`,
    draftRevision: preview.draftRevision,
    expiresAt: preview.expiresAt,
  };
};
