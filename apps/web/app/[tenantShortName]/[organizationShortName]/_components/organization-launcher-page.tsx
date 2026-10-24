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
  type FieldInputControlReleaseMap,
  type PlatformThemeTokens,
  type DisplaySemanticEvent,
} from "@vortex/ui";
import type { permittedApplicationsToListValues } from "@vortex/ui";
import { signOut } from "../../../auth/actions";

export function OrganizationLauncherPage({
  page,
  shell,
  placementId,
  values,
  organizationName,
  account,
  openApplication,
  openEventId,
  studio,
  launcherHref,
  platformBlockReleases,
  fieldInputControlReleases,
  platformThemeTokens,
}: Readonly<{
  page: PageDefinition;
  shell: ApplicationShell;
  placementId: string;
  values: ReturnType<typeof permittedApplicationsToListValues>;
  organizationName: string;
  account: ApplicationAccount;
  openApplication: (event: DisplaySemanticEvent) => Promise<void>;
  openEventId: string;
  studio?: Readonly<{ href: string; tileId: string }>;
  launcherHref: string;
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
        organizationName,
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
          applicationHref: launcherHref,
          organizationName,
          pageName: page.name,
          applicationSwitcher: { state: "available", applications: [] },
        }}
        runtimeInputs={{
          [placementId]: {
            data: { status: "ready", values },
            events: {
              row_action: (event: DisplaySemanticEvent) => {
                if (event.event !== "row_action" || event.eventId !== openEventId) {
                  console.error("[launcher] open refused: ROW_ACTION_EVENT_UNKNOWN");
                  return;
                }
                if (studio !== undefined && event.recordId === studio.tileId) {
                  router.push(studio.href);
                  return;
                }
                return openApplication(event);
              },
            },
          },
        }}
      />
    </ApplicationAccountActionsProvider>
  );
}
