"use client";

import { useMemo, type ComponentProps, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import type { ApplicationShell, PageDefinition } from "@vortex/platform/schema";
import {
  ApplicationAccountActionsProvider,
  type ApplicationAccount,
  createPlatformComponentRegistryForReleases,
  PagePuckRenderer,
  renderedPageOf,
  type FieldInputControlReleaseMap,
  type PlatformThemeTokens,
} from "@vortex/ui";
import type { PlatformBlockRelease } from "@vortex/platform/schema";
import { signOut } from "../../../../../auth/actions";

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
  organizationShortName,
  account,
  platformBlockReleases,
  fieldInputControlReleases,
  platformThemeTokens,
}: Readonly<{
  page: PageDefinition;
  shells: readonly ApplicationShell[];
  /** The application's installed release theme; absent keeps the platform default. */
  theme?: ComponentProps<typeof PagePuckRenderer>["theme"];
  /** The organisation's display name; its short name is the address segment shown beside it. */
  organizationName: string;
  organizationShortName: string;
  account: ApplicationAccount;
  platformBlockReleases: readonly PlatformBlockRelease[];
  fieldInputControlReleases: FieldInputControlReleaseMap;
  platformThemeTokens: PlatformThemeTokens;
}>): ReactElement {
  const router = useRouter();
  const platformComponentRegistry = useMemo(
    () => createPlatformComponentRegistryForReleases(platformBlockReleases),
    [platformBlockReleases],
  );
  const rendered = useMemo(() => renderedPageOf(page, shells), [page, shells]);
  return (
    <ApplicationAccountActionsProvider
      actions={{
        account,
        organizationName,
        organizationShortName,
        chooseOrganization: () => router.push("/signed-in"),
        signOut,
        openApplication: (href) => router.push(href),
      }}
    >
      <PagePuckRenderer
        composition={rendered.page}
        {...(rendered.shell === undefined ? {} : { shell: rendered.shell })}
        registry={platformComponentRegistry}
        fieldInputControlReleases={fieldInputControlReleases}
        platformThemeTokens={platformThemeTokens}
        pageId={page.pageId}
        theme={theme}
      />
    </ApplicationAccountActionsProvider>
  );
}
