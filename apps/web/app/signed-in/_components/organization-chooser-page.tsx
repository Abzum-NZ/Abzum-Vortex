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
  placementId,
  values,
  account,
  openOrganization,
  platformBlockReleases,
  fieldInputControlReleases,
  platformThemeTokens,
}: Readonly<{
  page: PageDefinition;
  shell: ApplicationShell;
  placementId: string;
  values: LauncherRowsPayload | undefined;
  account: ApplicationAccount;
  openOrganization: (event: DisplaySemanticEvent) => Promise<void>;
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
        applicationSwitcher={{ state: "available", applications: [] }}
        applicationShellRuntime={{
          applicationName: shell.name,
          applicationHref: "/signed-in",
          organizationName: page.name,
          pageName: page.name,
        }}
        runtimeInputs={
          values === undefined
            ? {}
            : {
                [placementId]: {
                  data: { status: "ready", values },
                  events: { row_action: openOrganization },
                },
              }
        }
      />
    </ApplicationAccountActionsProvider>
  );
}
