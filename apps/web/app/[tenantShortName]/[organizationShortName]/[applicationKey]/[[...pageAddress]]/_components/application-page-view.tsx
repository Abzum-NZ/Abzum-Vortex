"use client";

import { Suspense, use, useMemo, useState, type ReactElement, type ReactNode } from "react";
import {
  createPlatformComponentRegistryForReleases,
  type FieldInputControlReleaseMap,
  isClientPageChange,
  primaryStreamedPlacement,
  UnsavedWorkProvider,
  type DisplaySemanticEvent,
  type PlatformThemeTokens,
} from "@vortex/ui";
import type { PlatformBlockRelease, ProjectedApplicationFrame } from "@vortex/platform/schema";
import type { ApplicationPageModel } from "../../../../../_lib/application-page";
import type { GuidedFormActions } from "./application-page-view/types";
import { ApplicationPageViewContent } from "./application-page-view/application-page-content";

/** The page model with one streamed placement's settled state served as ready data. */
const withSettledPlacement = (
  model: ApplicationPageModel,
  placementId: string,
  state: ApplicationPageModel["data"][string],
): ApplicationPageModel => {
  const { streamedData, data, ...rest } = model;
  const stillStreamed = Object.fromEntries(
    Object.entries(streamedData ?? {}).filter(([id]) => id !== placementId),
  );
  return {
    ...rest,
    data: { ...data, [placementId]: state },
    ...(Object.keys(stillStreamed).length === 0 ? {} : { streamedData: stillStreamed }),
  };
};

/**
 * The first document shows its primary placement (the first streamed read of the page's own
 * content, the one a page change holds for) in its HTML: this waits for that read while the
 * document streams, so the frame is sent and painted first and the rows follow in their own part of
 * the same response, painted before the page's code has loaded and hydrated as they are. A page
 * that mounts after the document has hydrated never waits here; the page hold keeps the current
 * page on screen instead.
 */
function FirstDocumentPage({
  model,
  content,
  settle,
  render,
}: Readonly<{
  model: ApplicationPageModel;
  content: Readonly<Record<string, unknown>>;
  settle: boolean;
  render: (model: ApplicationPageModel) => ReactElement;
}>): ReactElement {
  const primaryId =
    settle && model.streamedData !== undefined
      ? primaryStreamedPlacement(content, model.streamedData)
      : undefined;
  const primaryRead = primaryId === undefined ? undefined : model.streamedData?.[primaryId];
  const state = primaryRead === undefined ? undefined : use(primaryRead);
  const shown = useMemo(
    () =>
      primaryId === undefined || state === undefined
        ? model
        : withSettledPlacement(model, primaryId, state),
    [model, primaryId, state],
  );
  return render(shown);
}

/**
 * Renders the content of one installed application page and carries out what its people do on it.
 * Every declared component event goes to the one flow endpoint with the exact installation and
 * binding the page was rendered from. Launcher row actions use the server-side
 * permitted-application recheck. After a write, only data placements affected by that source are
 * re-read. The application frame around it belongs to the layout.
 */
export function ApplicationPageView({
  model,
  content,
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
  /** The page's own placements, rendered in the frame's outlet. */
  content: Readonly<Record<string, unknown>>;
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
  // Only the model this view first rendered with in the document waits for its primary read.
  const [documentModel] = useState(() => (isClientPageChange() ? undefined : model));
  const page = (shown: ApplicationPageModel): ReactElement => (
    <ApplicationPageViewContent
      model={shown}
      content={content}
      frame={frame}
      guidedFormActions={guidedFormActions}
      onOpenApplication={onOpenApplication}
      adoptReleaseAction={adoptReleaseAction}
      pageFeedback={pageFeedback}
      platformComponentRegistry={platformComponentRegistry}
      fieldInputControlReleases={fieldInputControlReleases}
      platformThemeTokens={platformThemeTokens}
    />
  );
  const settle = documentModel === model;
  return (
    <UnsavedWorkProvider>
      {/* While the first document waits for the rows, it shows the page with their skeleton. */}
      <Suspense fallback={settle ? page(model) : null}>
        <FirstDocumentPage model={model} content={content} settle={settle} render={page} />
      </Suspense>
    </UnsavedWorkProvider>
  );
}
