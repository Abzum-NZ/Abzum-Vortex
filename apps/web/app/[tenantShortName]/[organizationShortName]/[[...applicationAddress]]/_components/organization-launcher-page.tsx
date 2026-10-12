"use client";

import type { ReactElement } from "react";
import { useRouter } from "next/navigation";
import type { ApplicationShell, PageDefinition } from "@vortex/platform/schema";
import {
  ApplicationAccountActionsProvider,
  createFullPlatformComponentRegistry,
  PagePuckRenderer,
  type DisplaySemanticEvent,
} from "@vortex/ui";
import type { permittedApplicationsToListValues } from "@vortex/ui";
import { signOut } from "../../../../auth/actions";

const registry = createFullPlatformComponentRegistry();

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
}>): ReactElement {
  const router = useRouter();
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
