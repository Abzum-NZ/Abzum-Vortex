import "server-only";

import { compiledPageShellId, sameId } from "@vortex/platform/schema";
import type { InstalledRuntimeContext } from "@vortex/platform/server";
import type { StudioFrameDefinition } from "../_components/studio-header";

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
export const studioFrameOf = (
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
