import "server-only";

import {
  reconcilePreviewInstallation,
  type HumanOrganizationRequestDependencies,
  type InstalledRuntimeContext,
  type StoredApplicationDefinitionDraft,
} from "@vortex/platform/server";
import {
  sameId,
  type ApplicationRootId,
  type ApplicationContent,
  type IdentitySession,
  type OrganizationId,
  type PreviewDemand,
} from "@vortex/platform/schema";
import { humanOrganizationRequests } from "./server-composition";
import {
  materializeStudioPreviewDemand,
  readStudioPreviewState,
  studioPreviewRunsDraft,
} from "./studio-application-preview";
import { loadInstalledContext, requestDependencies } from "./application-page/installed-context";
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
 * It reads only a preview that already runs the saved revision's data shape: a save moves the
 * preview on the server and Studio's readers wait for it to be ready before they read, so a read
 * never prepares or moves a preview. Presentation-only edits reuse the existing records. Every read in it runs under
 * the builder's preview access, as the preview itself decides it: the draft's roles for the
 * Application's own permissions, the builder's own live access for people and every other system
 * projection, and no record-share authority.
 */
export type StudioPreviewRead =
  | Readonly<{
      kind: "available";
      /** The saved draft at exactly the requested revision. */
      draft: StoredApplicationDefinitionDraft;
      content?: ApplicationContent;
      selection: StudioPreviewSelection;
      context: InstalledRuntimeContext;
      dependencies: HumanOrganizationRequestDependencies;
      services: ReturnType<typeof createPlacementReadServices>;
      demand: (
        demand: PreviewDemand | undefined,
      ) => ReturnType<typeof materializeStudioPreviewDemand>;
    }>
  /** The builder may not edit or preview this Application, so Studio reads no records of it. */
  | Readonly<{ kind: "refused" }>
  /** The saved draft moved on from the revision the request names. */
  | Readonly<{ kind: "conflict" }>
  /** The preview does not run this revision's data shape yet: wait until it is ready, then read. */
  | Readonly<{ kind: "following" }>
  /** The saved draft has a problem to fix before its preview can run. */
  | Readonly<{ kind: "not_runnable"; sentence: string }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

/** Opens the builder's preview of the saved draft at this revision for reading records. */
export const openStudioPreviewRead = async (
  session: IdentitySession,
  organizationId: OrganizationId,
  rootId: ApplicationRootId,
  draftRevision: number,
  signal?: AbortSignal,
  readCompilation = false,
): Promise<StudioPreviewRead> => {
  signal?.throwIfAborted();
  const state = await readStudioPreviewState(
    session,
    organizationId,
    rootId,
    draftRevision,
    readCompilation,
  );
  signal?.throwIfAborted();
  if (state.kind === "refused") return { kind: "refused" };
  if (state.kind !== "read") return state;
  const runs = studioPreviewRunsDraft(state.draft, state.preview);
  if (runs === "newer") return { kind: "conflict" };
  const preview = state.preview;
  if (runs !== "ready" || preview === undefined) return { kind: "following" };
  const dependencies = requestDependencies();
  const application = { organizationId, applicationRootId: rootId };
  // Copied live records are read only once they are decided again by the builder's current live
  // access in the installed Application, at most every five minutes, as opening the preview does.
  if (preview.reconcileDue) {
    const reconcile = () =>
      humanOrganizationRequests(dependencies.identityAuthorityId).run(
        session,
        application,
        async (transaction) => {
          await reconcilePreviewInstallation(transaction, preview.previewInstallationId);
          return true;
        },
      );
    let reconciled = await reconcile();
    signal?.throwIfAborted();
    if (reconciled.kind === "temporarily_unavailable" && reconciled.databaseCode === "40001") {
      console.info(
        "[studio] retrying preview reconcile after serialization conflict: STUDIO_PREVIEW_RECONCILE_RETRY",
      );
      reconciled = await reconcile();
    }
    if (reconciled.kind !== "available") {
      console.error(
        `[studio] preview records unchecked: STUDIO_PREVIEW_RECORDS_UNCHECKED kind=${reconciled.kind}`,
      );
      return reconciled.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable" }
        : { kind: "refused" };
    }
  }
  const selection: StudioPreviewSelection = {
    ...application,
    previewInstallationId: preview.previewInstallationId,
  };
  signal?.throwIfAborted();
  const [firstInstalled, launcher] = await Promise.all([
    loadInstalledContext(session, dependencies, selection),
    loadOrganizationLauncher(session),
  ]);
  signal?.throwIfAborted();
  const installed =
    firstInstalled.kind === "temporarily_unavailable" && firstInstalled.databaseCode === "40001"
      ? await loadInstalledContext(session, dependencies, selection)
      : firstInstalled;
  if (installed !== firstInstalled)
    console.info(
      "[studio] retried preview context after serialization conflict: STUDIO_PREVIEW_CONTEXT_RETRY",
    );
  if (installed.kind !== "available") {
    console.error(
      `[studio] preview context unavailable: STUDIO_PREVIEW_CONTEXT_UNAVAILABLE kind=${installed.kind}`,
    );
    return installed.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" }
      : { kind: "refused" };
  }
  const entry =
    launcher.kind === "available"
      ? launcher.entries.find((candidate) => sameId(candidate.organizationId, organizationId))
      : undefined;
  if (entry === undefined)
    return launcher.kind === "available"
      ? { kind: "refused" }
      : { kind: "temporarily_unavailable" };
  signal?.throwIfAborted();
  const services = createPlacementReadServices({
    session,
    selection,
    dependencies,
    continuationKey: getQueryContinuationKey(),
    tenantShortName: entry.tenantShortName,
    organizationShortName: entry.organizationShortName,
  });
  return {
    kind: "available",
    draft: state.draft,
    ...(state.content === undefined ? {} : { content: state.content }),
    selection,
    context: installed.value,
    dependencies,
    services,
    demand: (demand) =>
      materializeStudioPreviewDemand(session, organizationId, rootId, preview, demand, signal),
  };
};
