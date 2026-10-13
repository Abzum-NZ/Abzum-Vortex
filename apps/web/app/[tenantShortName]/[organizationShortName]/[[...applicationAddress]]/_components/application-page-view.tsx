"use client";

import { useMemo, type ReactElement, type ReactNode } from "react";
import {
  type ApplicationAccount,
  createPlatformComponentRegistryForReleases,
  type FieldInputControlReleaseMap,
  type PagePuckRendererProps,
  UnsavedWorkProvider,
  type DisplaySemanticEvent,
  type PlatformThemeTokens,
} from "@vortex/ui";
import type { PlatformBlockRelease } from "@vortex/platform/schema";
import type { ApplicationPageModel } from "../../../../_lib/application-page";
import type { GuidedFormActions } from "./application-page-view/types";
import { ApplicationPageViewContent } from "./application-page-view/application-page-content";

/**
 * Renders one installed application page and carries out what its people do on it. Every
 * declared component event goes to the one flow endpoint with the exact installation and binding
 * the page was rendered from. Launcher row actions use the server-side permitted-application
 * recheck. After a write, only data placements affected by that source are re-read.
 */
export function ApplicationPageView({
  model,
  guidedFormActions,
  onOpenApplication,
  adoptReleaseAction,
  applicationSwitcherState,
  account,
  applicationSearch,
  applicationSearchPageSubject,
  pageFeedback,
  platformBlockReleases,
  fieldInputControlReleases,
  platformThemeTokens,
}: Readonly<{
  model: ApplicationPageModel;
  guidedFormActions: GuidedFormActions;
  onOpenApplication: (event: DisplaySemanticEvent) => Promise<void>;
  adoptReleaseAction?: ((formData: FormData) => Promise<void>) | undefined;
  applicationSwitcherState: "available" | "unavailable" | "temporarily_unavailable";
  account: ApplicationAccount;
  applicationSearch?: PagePuckRendererProps["applicationSearch"];
  applicationSearchPageSubject?: string | undefined;
  pageFeedback?: ReactNode;
  platformBlockReleases: readonly PlatformBlockRelease[];
  fieldInputControlReleases: FieldInputControlReleaseMap;
  platformThemeTokens: PlatformThemeTokens;
}>): ReactElement {
  const platformComponentRegistry = useMemo(
    () => createPlatformComponentRegistryForReleases(platformBlockReleases),
    [platformBlockReleases],
  );
  return (
    <UnsavedWorkProvider>
      <ApplicationPageViewContent
        model={model}
        guidedFormActions={guidedFormActions}
        onOpenApplication={onOpenApplication}
        adoptReleaseAction={adoptReleaseAction}
        applicationSwitcherState={applicationSwitcherState}
        account={account}
        applicationSearch={applicationSearch}
        applicationSearchPageSubject={applicationSearchPageSubject}
        pageFeedback={pageFeedback}
        platformComponentRegistry={platformComponentRegistry}
        fieldInputControlReleases={fieldInputControlReleases}
        platformThemeTokens={platformThemeTokens}
      />
    </UnsavedWorkProvider>
  );
}
