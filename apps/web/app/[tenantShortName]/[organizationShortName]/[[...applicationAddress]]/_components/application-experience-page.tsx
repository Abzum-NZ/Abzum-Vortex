"use client";

import { useMemo, type ComponentProps, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import type { ApplicationShell, PageDefinition } from "@vortex/platform/schema";
import {
  ApplicationAccountActionsProvider,
  createFullPlatformComponentRegistry,
  PagePuckRenderer,
  type FieldInputControlReleaseMap,
  type PlatformThemeTokens,
} from "@vortex/ui";
import type { PlatformBlockRelease } from "@vortex/platform/schema";
import { signOut } from "../../../../auth/actions";

/**
 * Renders one application-declared experience page through the normal page renderer. Experience
 * pages are ordinary compiled pages, so they use the same blocks, shells and theme as any other
 * page; the route only chooses which one a fixed state shows.
 */
export function ApplicationExperiencePage({
  page,
  shells,
  theme,
  organizationName,
  identityId,
  platformBlockReleases,
  fieldInputControlReleases,
  platformThemeTokens,
}: Readonly<{
  page: PageDefinition;
  shells: readonly ApplicationShell[];
  /** The application's installed release theme; absent keeps the platform default. */
  theme?: ComponentProps<typeof PagePuckRenderer>["theme"];
  organizationName: string;
  identityId: string;
  platformBlockReleases: readonly PlatformBlockRelease[];
  fieldInputControlReleases: FieldInputControlReleaseMap;
  platformThemeTokens: PlatformThemeTokens;
}>): ReactElement {
  const router = useRouter();
  const platformComponentRegistry = useMemo(
    () => createFullPlatformComponentRegistry(platformBlockReleases),
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
        themeMode="system"
        composition={page}
        registry={platformComponentRegistry}
        fieldInputControlReleases={fieldInputControlReleases}
        platformThemeTokens={platformThemeTokens}
        shells={shells}
        pageId={page.pageId}
        theme={theme}
      />
    </ApplicationAccountActionsProvider>
  );
}
