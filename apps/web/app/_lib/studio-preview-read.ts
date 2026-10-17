import "server-only";

import {
  createPreviewInstallationRepository,
  type HumanOrganizationRequestDependencies,
  type InstalledRuntimeContext,
} from "@vortex/platform/server";
import { sameId, type IdentitySession } from "@vortex/platform/schema";
import { humanOrganizationRequests } from "./server-composition";
import { currentStudioPreview } from "./studio-application-preview";
import { loadInstalledContext, requestDependencies } from "./application-page/load";
import { createPlacementReadServices } from "./application-page/placement-services";
import { loadOrganizationLauncher } from "./organization-context";
import { getQueryContinuationKey } from "./query-continuation-key";

/** The selection every read of a Studio preview runs under: the Application and the builder's preview of it. */
export type StudioPreviewSelection = Readonly<{
  organizationId: string;
  applicationRootId: string;
  previewInstallationId: string;
}>;

/**
 * Where Studio's canvas and Data tab read the records of the saved draft: the builder's own preview
 * installation of exactly that draft revision, with its runtime context and the running
 * application's own readers. Every read in it runs under the builder's preview access, as the
 * preview itself decides it: the draft's roles for the Application's own permissions, the builder's
 * own live access for people and every other system projection, and no record-share authority.
 */
export type StudioPreviewRead =
  | Readonly<{
      kind: "available";
      selection: StudioPreviewSelection;
      context: InstalledRuntimeContext;
      dependencies: HumanOrganizationRequestDependencies;
      services: ReturnType<typeof createPlacementReadServices>;
    }>
  /** The builder may not preview this Application, so Studio reads no records of it. */
  | Readonly<{ kind: "refused" }>
  /** The saved draft moved on from the revision the request names. */
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

/** Opens the builder's preview of the saved draft at this revision for reading records. */
export const openStudioPreviewRead = async (
  session: IdentitySession,
  organizationId: string,
  rootId: string,
  draftRevision: number,
): Promise<StudioPreviewRead> => {
  const preview = await currentStudioPreview(session, organizationId, { rootId, draftRevision });
  if (preview.kind === "refused") return { kind: "refused" };
  if (preview.kind !== "available") return preview;
  const dependencies = requestDependencies();
  const application = { organizationId, applicationRootId: rootId };
  // A preview holding copied live records is read only once they are decided again by the
  // builder's current live access in the installed Application, as opening the preview does.
  if (preview.reusedSeeded) {
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
  return { kind: "available", selection, context: installed.value, dependencies, services };
};
