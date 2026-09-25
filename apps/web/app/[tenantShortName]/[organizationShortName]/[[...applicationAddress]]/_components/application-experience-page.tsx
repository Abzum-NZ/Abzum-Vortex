"use client";

import type { ReactElement } from "react";
import type { ApplicationShellV2, PageDefinitionV2 } from "@vortex/contracts";
import { createFullPlatformComponentRegistry, PageLayoutRenderer } from "@vortex/ui";

/** One registry shared by every rendered experience page. */
const platformComponentRegistry = createFullPlatformComponentRegistry();

/**
 * Renders one application-declared experience page through the normal page renderer. Experience
 * pages are ordinary compiled pages, so they use the same blocks, shells and theme as any other
 * page; the route only chooses which one a fixed state shows.
 */
export function ApplicationExperiencePage({
  page,
  shells,
}: Readonly<{
  page: PageDefinitionV2;
  shells: readonly ApplicationShellV2[];
}>): ReactElement {
  return (
    <PageLayoutRenderer
      composition={page}
      registry={platformComponentRegistry}
      shells={shells}
      pageId={page.pageId}
    />
  );
}
