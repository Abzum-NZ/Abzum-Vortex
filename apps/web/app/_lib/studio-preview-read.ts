import "server-only";

import {
  createPreviewInstallationRepository,
  type HumanOrganizationRequestDependencies,
  type InstalledRuntimeContext,
  type StoredApplicationDefinitionDraft,
} from "@vortex/platform/server";
import {
  sameId,
  type ApplicationRootId,
  type IdentitySession,
  type OrganizationId,
} from "@vortex/platform/schema";
import { humanOrganizationRequests } from "./server-composition";
import { currentStudioPreview, readStudioPreviewState } from "./studio-application-preview";
import { loadInstalledContext, requestDependencies } from "./application-page/load";
import { createPlacementReadServices } from "./application-page/placement-services";
import { loadOrganizationLauncher } from "./organization-context";
import { getQueryContinuationKey } from "./query-continuation-key";

/** The selection every read of a Studio preview runs under: the Application and the builder's preview of it. */
export type StudioPreviewSelection = Readonly<{
  organizationId: OrganizationId;
  applicationRootId: ApplicationRootId;
  previewInstallationId: string;
}>;

/**
 * Where Studio's canvas and Data tab read the records of the saved draft: the builder's own preview
 * installation of that draft, with its runtime context and the running application's own readers.
 * The preview follows the draft: it moves to each saved revision in the background, keeping its
 * records, and reads meanwhile run on it as it is. Every read in it runs under
 * the builder's preview access, as the preview itself decides it: the draft's roles for the
 * Application's own permissions, the builder's own live access for people and every other system
 * projection, and no record-share authority.
 */
export type StudioPreviewRead =
  | Readonly<{
      kind: "available";
      /** The saved draft at exactly the requested revision. */
      draft: StoredApplicationDefinitionDraft;
      /** The preview still runs an older revision's data shape and moves to this one meanwhile. */
      behind: boolean;
      selection: StudioPreviewSelection;
      context: InstalledRuntimeContext;
      dependencies: HumanOrganizationRequestDependencies;
      services: ReturnType<typeof createPlacementReadServices>;
    }>
  /** The builder may not edit or preview this Application, so Studio reads no records of it. */
  | Readonly<{ kind: "refused" }>
  /** The saved draft moved on from the revision the request names. */
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

/** Opens the builder's preview of the saved draft at this revision for reading records. */
export const openStudioPreviewRead = async (
  session: IdentitySession,
  organizationId: OrganizationId,
  rootId: ApplicationRootId,
  draftRevision: number,
): Promise<StudioPreviewRead> => {
  const state = await readStudioPreviewState(session, organizationId, rootId, draftRevision);
  if (state.kind === "refused") return { kind: "refused" };
  if (state.kind !== "read") return state;
  const preview = await currentStudioPreview(session, organizationId, state.draft, state.preview, "read");
  if (preview.kind === "refused") return { kind: "refused" };
  if (preview.kind !== "available") return preview;
  const dependencies = requestDependencies();
  const application = { organizationId, applicationRootId: rootId };
  // Copied live records are read only once they are decided again by the builder's current live
  // access in the installed Application, at most every five minutes, as opening the preview does.
  if (preview.reconcileDue) {
    const reconciled = await humanOrganizationRequests(dependencies.identityAuthorityId).run(
      session,
      application,
      async (transaction) => {
        await createPreviewInstallationRepository(transaction).reconcile(preview.previewInstallationId);
        return true;
      },
    );
    if (reconciled.kind !== "available") {
      console.error(`[studio] preview records unchecked: STUDIO_PREVIEW_RECORDS_UNCHECKED kind=${reconciled.kind}`);
      return reconciled.kind === "temporarily_unavailable" ? { kind: "temporarily_unavailable" } : { kind: "refused" };
    }
  }
  const selection: StudioPreviewSelection = { ...application, previewInstallationId: preview.previewInstallationId };
  const [installed, launcher] = await Promise.all([
    loadInstalledContext(session, dependencies, selection),
    loadOrganizationLauncher(session),
  ]);
  if (installed.kind !== "available") {
    console.error(`[studio] preview context unavailable: STUDIO_PREVIEW_CONTEXT_UNAVAILABLE kind=${installed.kind}`);
    return installed.kind === "temporarily_unavailable" ? { kind: "temporarily_unavailable" } : { kind: "refused" };
  }
  const entry = launcher.kind === "available"
    ? launcher.entries.find((candidate) => sameId(candidate.organizationId, organizationId)) : undefined;
  if (entry === undefined) return launcher.kind === "available" ? { kind: "refused" } : { kind: "temporarily_unavailable" };
  const services = createPlacementReadServices({ session, selection, dependencies,
    continuationKey: getQueryContinuationKey(), tenantShortName: entry.tenantShortName,
    organizationShortName: entry.organizationShortName });
  return { kind: "available", draft: state.draft, behind: preview.behind, selection, context: installed.value, dependencies, services };
};
