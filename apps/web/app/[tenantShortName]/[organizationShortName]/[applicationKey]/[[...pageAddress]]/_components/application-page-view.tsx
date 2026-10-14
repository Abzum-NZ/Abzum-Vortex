"use client";

import { useMemo, type ReactElement, type ReactNode } from "react";
import {
  createPlatformComponentRegistryForReleases,
  type FieldInputControlReleaseMap,
  UnsavedWorkProvider,
  type DisplaySemanticEvent,
  type PlatformThemeTokens,
} from "@vortex/ui";
import type { PlatformBlockRelease, ProjectedApplicationFrame } from "@vortex/platform/schema";
import type { ApplicationPageModel } from "../../../../../_lib/application-page";
import type { GuidedFormActions } from "./application-page-view/types";
import { ApplicationPageViewContent } from "./application-page-view/application-page-content";

/**
 * Renders the content of one installed application page and carries out what its people do on it.
 * Every declared component event goes to the one flow endpoint with the exact installation and
 * binding the page was rendered from. Launcher row actions use the server-side
 * permitted-application recheck. After a write, only data placements affected by that source are
 * re-read. The application frame around it belongs to the layout.
 */
export function ApplicationPageView({
  model,
  frame,
  guidedFormActions,
  onOpenApplication,
  adoptReleaseAction,
  pageFeedback,
  platformBlockReleases,
  fieldInputControlReleases,
  platformThemeTokens,
}: Readonly<{
  model: ApplicationPageModel;
  frame: ProjectedApplicationFrame;
  guidedFormActions: GuidedFormActions;
  onOpenApplication: (event: DisplaySemanticEvent) => Promise<void>;
  adoptReleaseAction?: ((formData: FormData) => Promise<void>) | undefined;
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
        frame={frame}
        guidedFormActions={guidedFormActions}
        onOpenApplication={onOpenApplication}
        adoptReleaseAction={adoptReleaseAction}
        pageFeedback={pageFeedback}
        platformComponentRegistry={platformComponentRegistry}
        fieldInputControlReleases={fieldInputControlReleases}
        platformThemeTokens={platformThemeTokens}
      />
    </UnsavedWorkProvider>
  );
}
