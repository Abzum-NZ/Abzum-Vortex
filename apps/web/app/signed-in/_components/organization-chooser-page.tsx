"use client";

import type { ReactElement } from "react";
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import type {
  ApplicationShell,
  PageDefinition,
  PlatformBlockRelease,
} from "@vortex/platform/schema";
import {
  ApplicationAccountActionsProvider,
  type ApplicationAccount,
  createPlatformComponentRegistryForReleases,
  PagePuckRenderer,
  renderedPageOf,
  type DisplaySemanticEvent,
  type FieldInputControlReleaseMap,
  type LauncherRowsPayload,
  type PlatformThemeTokens,
} from "@vortex/ui";
import { signOut } from "../../auth/actions";

/**
 * Renders a platform-owned chooser page through the same Puck path as every application page. The
 * wordmark and page name shown in the top bar are the shell's and page's own definition names.
 */
export function OrganizationChooserPage({
  page,
  shell,
  launchers,
  account,
  platformBlockReleases,
  fieldInputControlReleases,
  platformThemeTokens,
}: Readonly<{
  page: PageDefinition;
  shell: ApplicationShell;
  /** The launcher tiles the page shows, each with its row action (open or join). */
  launchers: readonly Readonly<{
    placementId: string;
    values: LauncherRowsPayload;
    onRowAction: (event: DisplaySemanticEvent) => Promise<void>;
  }>[];
  account: ApplicationAccount;
  platformBlockReleases: readonly PlatformBlockRelease[];
  fieldInputControlReleases: FieldInputControlReleaseMap;
  platformThemeTokens: PlatformThemeTokens;
}>): ReactElement {
  const router = useRouter();
  const registry = useMemo(
    () => createPlatformComponentRegistryForReleases(platformBlockReleases),
    [platformBlockReleases],
  );
  const rendered = useMemo(() => renderedPageOf(page, [shell]), [page, shell]);
  return (
    <ApplicationAccountActionsProvider
      actions={{
        account,
        organizationName: page.name,
        chooseOrganization: () => router.push("/signed-in"),
        signOut,
        openApplication: (href) => router.push(href),
      }}
    >
      <PagePuckRenderer
        composition={rendered.page}
        {...(rendered.shell === undefined ? {} : { shell: rendered.shell })}
        registry={registry}
        fieldInputControlReleases={fieldInputControlReleases}
        platformThemeTokens={platformThemeTokens}
        pageId={page.pageId}
        applicationSurface
        applicationShellRuntime={{
          applicationName: shell.name,
          applicationHref: "/signed-in",
          organizationName: page.name,
          pageName: page.name,
        }}
        runtimeInputs={Object.fromEntries(
          launchers.map((launcher) => [
            launcher.placementId,
            {
              data: { status: "ready", values: launcher.values },
              events: { row_action: launcher.onRowAction },
            },
          ]),
        )}
      />
    </ApplicationAccountActionsProvider>
  );
}
