import "server-only";

import { studioApplication } from "@vortex/definitions";
import { resolveIdentitySessionWithEmail } from "../../auth/_lib/session-server";
import { loadOrganizationLauncher } from "../../_lib/organization-context";
import type { StudioFrameDefinition } from "../_components/studio-header";

/** One organisation of the launcher, as the frame names it and the person's account in it. */
type LauncherEntry = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
  organizationDisplayName: string;
  accountDisplayName?: string | undefined;
}>;

/**
 * Studio's shared application frame: the top bar its own shell definition chooses, so the editor
 * shows the same bar as the pages of its App Store section, and where the person is.
 */
export const studioFrameOf = (entry: LauncherEntry, email: string): StudioFrameDefinition => {
  const topBar = studioApplication.body.shells[0]!.presentation.top_bar;
  return {
    shellName: studioApplication.body.name,
    topBar: {
      breadcrumbs: topBar.breadcrumbs,
      organizationSwitcher: topBar.organization_switcher,
      applicationSwitcher: topBar.application_switcher,
      accountMenu: topBar.account_menu,
      appearanceToggle: topBar.appearance_toggle,
    },
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

/** The frame for one organisation of the signed-in person, or the reason there is none. */
export const loadStudioFrame = async (
  organizationId: string,
): Promise<
  | Readonly<{ kind: "available"; frame: StudioFrameDefinition }>
  | Readonly<{ kind: "refused"; reason: string }>
> => {
  const { resolution, email } = await resolveIdentitySessionWithEmail();
  if (resolution.kind !== "active" || email === undefined)
    return { kind: "refused", reason: "Sign in to open Studio." };
  const launcher = await loadOrganizationLauncher(resolution.session);
  const entry =
    launcher.kind === "available"
      ? launcher.entries.find((candidate) => candidate.organizationId === organizationId)
      : undefined;
  if (entry === undefined)
    return { kind: "refused", reason: "This organisation is not available to your account." };
  return { kind: "available", frame: studioFrameOf(entry, email) };
};
