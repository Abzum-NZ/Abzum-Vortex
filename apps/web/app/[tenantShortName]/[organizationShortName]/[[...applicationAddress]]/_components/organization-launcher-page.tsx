"use client";

import type { ReactElement } from "react";
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import type { ApplicationShell, PageDefinition, PlatformBlockRelease } from "@vortex/platform/schema";
import {
  ApplicationAccountActionsProvider,
  createPlatformComponentRegistryForReleases,
  PagePuckRenderer,
  type FieldInputControlReleaseMap,
  type PlatformThemeTokens,
  type DisplaySemanticEvent,
} from "@vortex/ui";
import type { permittedApplicationsToListValues } from "@vortex/ui";
import { signOut } from "../../../../auth/actions";

export function OrganizationLauncherPage({
  page,
  shell,
  placementId,
  values,
  organizationName,
  identityId,
  openApplication,
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
  identityId: string;
  openApplication: (event: DisplaySemanticEvent) => Promise<void>;
  studio?: Readonly<{ href: string; placementId: string }>;
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
  return (
    <ApplicationAccountActionsProvider
      actions={{
        identityId,
        organizationName,
        chooseOrganization: () => router.push("/signed-in"),
        signOut,
        openApplication: (href) => router.push(href),
      }}
    >
      <PagePuckRenderer
        composition={page}
        shells={[shell]}
        registry={registry}
        fieldInputControlReleases={fieldInputControlReleases}
        platformThemeTokens={platformThemeTokens}
        pageId={page.pageId}
        applicationSurface
        themeMode="system"
        applicationShellRuntime={{
          applicationName: "Applications",
          applicationHref: launcherHref,
          organizationName,
          pageName: "Applications",
          applicationSwitcherState: "available",
          applications: [],
        }}
        runtimeInputs={{
          [placementId]: {
            data: { status: "ready", values },
            events: { row_action: openApplication },
          },
          ...(studio === undefined
            ? {}
            : {
                [studio.placementId]: {
                  data: {
                    status: "ready",
                    values: {
                      kind: "list",
                      headingKey: "label",
                      rows: [
                        {
                          recordId: studio.placementId,
                          cells: {
                            label: { kind: "text", text: "Open Studio" },
                            description: { kind: "text", text: "Create an application" },
                          },
                        },
                      ],
                    },
                  },
                  events: {
                    row_action: (event: DisplaySemanticEvent) => {
                      if (event.event === "row_action" && event.recordId === studio.placementId)
                        router.push(studio.href);
                    },
                  },
                },
              }),
        }}
      />
    </ApplicationAccountActionsProvider>
  );
}
