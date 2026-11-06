import "server-only";

import {
  compiledPageShellId,
  organizationSelectionCandidateSchema,
  sameId,
  type IdentitySession,
} from "@vortex/platform/schema";
import {
  readCurrentOrganizationAppStoreAddressAfterAuthorization,
  type InstalledRuntimeContext,
} from "@vortex/platform/server";
import type { StudioFrameDefinition } from "../_components/studio-header";
import { resolveApplicationAddress } from "../../_lib/application-address";
import {
  loadOrganizationLauncher,
  loadPermittedApplicationsAtAddress,
} from "../../_lib/organization-context";
import { humanOrganizationRequests } from "../../_lib/server-composition";
import { resolveIdentitySessionWithEmail } from "../../auth/_lib/session-server";

/** One organisation of the launcher, as the frame names it and the person's account in it. */
type LauncherEntry = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
  organizationDisplayName: string;
  accountDisplayName?: string | undefined;
}>;

/**
 * Studio's shared application frame: the top bar the organisation's installed Studio release
 * chooses for its home page's shell, so the editor shows the same bar as the pages of its App
 * Store section, and where the person is. Nothing here reads the shipped source.
 */
const studioFrameOf = (
  entry: LauncherEntry,
  email: string,
  installed: Readonly<{
    name: string;
    homePageKey: string;
    context: InstalledRuntimeContext;
  }>,
): StudioFrameDefinition => {
  const content = installed.context.releaseSet.application.content;
  const home = content.pages.find((page) => page.key === installed.homePageKey);
  const shellId = home === undefined ? undefined : compiledPageShellId(home.composition);
  const shell =
    shellId === undefined
      ? undefined
      : content.shells.find((candidate) => sameId(candidate.shellId, shellId));
  if (shell === undefined || shell.presentation === undefined)
    throw new Error("STUDIO_FRAME_SHELL_MISSING");
  return {
    shellName: installed.name,
    topBar: shell.presentation.topBar,
    account:
      entry.accountDisplayName === undefined
        ? { email }
        : { email, displayName: entry.accountDisplayName },
    tenantShortName: entry.tenantShortName,
    organizationShortName: entry.organizationShortName,
    organizationName: entry.organizationDisplayName,
    studioHref: "/studio",
  };
};

type AvailableLauncherEntry = Extract<
  Awaited<ReturnType<typeof loadOrganizationLauncher>>,
  { kind: "available" }
>["entries"][number];

/**
 * What the organisation's installed Studio gives a page of Studio: the person's session, their
 * place in the launcher, the organisation's installed applications and the frame. Each answer that
 * is not available is said by the page in the words of its kind; every read below logs its own
 * failure once, so nothing here adds a line except where no read did.
 */
export type StudioFrameContext =
  | Readonly<{
      kind: "available";
      session: IdentitySession;
      entry: AvailableLauncherEntry;
      applications: Extract<
        Awaited<ReturnType<typeof loadPermittedApplicationsAtAddress>>,
        { kind: "available" }
      >;
      frame: StudioFrameDefinition;
    }>
  | Readonly<{ kind: "refused" | "temporarily_unavailable" }>
  /** The organisation names no App Store (or one that names no application): an administrator sets it. */
  | Readonly<{ kind: "not_configured"; invalid: boolean }>;

export const loadStudioFrameContext = async (
  organizationId: string,
): Promise<StudioFrameContext> => {
  const { resolution: resolved, email } = await resolveIdentitySessionWithEmail();
  // Not signed in.
  if (resolved.kind !== "active" || email === undefined) return { kind: "refused" };
  const launcher = await loadOrganizationLauncher(resolved.session);
  // A launcher read that failed for now is not a refusal: the person is told to try again.
  if (launcher.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
  const entry =
    launcher.kind === "available"
      ? launcher.entries.find((candidate) => candidate.organizationId === organizationId)
      : undefined;
  // The organisation is not one of the person's: an expected refusal, and no read logged it.
  if (entry === undefined) {
    console.info(
      `[studio] workspace place refused: organisation not in the launcher (${launcher.kind})`,
    );
    return { kind: "refused" };
  }
  // The installed applications are read beside the settings: neither needs the other.
  const applicationsRead = loadPermittedApplicationsAtAddress(
    resolved.session,
    entry.tenantShortName,
    entry.organizationShortName,
  );
  // A refusal below returns before this read is used; it must not become an unhandled rejection.
  void applicationsRead.catch(() => undefined);
  // The organisation's settings name the App Store; Studio never assumes one.
  const settings = await humanOrganizationRequests().run(
    resolved.session,
    organizationSelectionCandidateSchema.parse({ organizationId }),
    (transaction) => readCurrentOrganizationAppStoreAddressAfterAuthorization(transaction),
  );
  // The request runner logged a refused or failed read once.
  if (settings.kind !== "available")
    return { kind: settings.kind === "temporarily_unavailable" ? settings.kind : "refused" };
  if (settings.value === null || settings.value === "invalid")
    return { kind: "not_configured", invalid: settings.value === "invalid" };
  const applications = await applicationsRead;
  // A read that failed for now is not an uninstalled Studio: the person is told to try again.
  if (applications.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
  // The installed Studio release shapes the frame the editor shows.
  const studioApplicationEntry =
    applications.kind === "available"
      ? applications.applications.find((candidate) => candidate.key === settings.value)
      : undefined;
  const studioResolved =
    studioApplicationEntry === undefined
      ? undefined
      : await resolveApplicationAddress(
          resolved.session,
          entry.tenantShortName,
          entry.organizationShortName,
          studioApplicationEntry.key,
          studioApplicationEntry.homePageKey,
        );
  if (studioResolved?.kind === "temporarily_unavailable")
    return { kind: "temporarily_unavailable" };
  // Studio is not installed for the person in this organisation.
  if (
    applications.kind !== "available" ||
    studioApplicationEntry === undefined ||
    studioResolved?.kind !== "application_page" ||
    studioResolved.installedContext === undefined
  )
    return { kind: "refused" };
  return {
    kind: "available",
    session: resolved.session,
    entry,
    applications,
    frame: studioFrameOf(entry, email, {
      name: studioApplicationEntry.name,
      homePageKey: studioApplicationEntry.homePageKey,
      context: studioResolved.installedContext,
    }),
  };
};
