import "server-only";

import {
  compiledPageShellId,
  sameId,
  splitProjectedPage,
  type ApplicationContent,
  type ApplicationShell,
  type ProjectedApplicationFrame,
  type ProjectedNavigation,
} from "@vortex/platform/schema";
import { collectNavigationPermissionKeys, projectNavigation } from "@vortex/platform/server";

const emptyLayout = {
  root: { props: { vortex: { slotOrders: { content: { tablet: [], phone: [] } } } } },
  content: [],
};

type SourcePages = readonly Readonly<{ id: string; key: string; type: string }>[];

/**
 * The application frame each page of a compiled draft draws inside: the page's shell with its
 * content removed, the application theme, and the menu as the builder designed it. Studio's canvas
 * renders the page being edited inside this frame with the same renderer the running application
 * uses. The menu shows every item the definition declares (a design view, not a viewer's projection),
 * and the frame carries no records.
 */
export type StudioApplicationCanvasFrames = Readonly<{
  applicationName: string;
  shells: readonly ApplicationShell[];
  theme: ApplicationContent["theme"];
  navigation: ProjectedNavigation;
  /** Keyed by authored page alias. */
  pages: Readonly<Record<string, Readonly<{
    pageId: string;
    pageName: string;
    frame: ProjectedApplicationFrame;
  }>>>;
}>;

/** Builds the canvas frames from one compiled draft; the compiled page list must match the authored one. */
export const studioCanvasFramesFor = (
  sourcePages: SourcePages,
  content: ApplicationContent,
): StudioApplicationCanvasFrames => {
  if (content.pages.length !== sourcePages.length)
    throw new Error("Studio compiled page list does not match its authored draft");
  const shells = content.shells as unknown as readonly ApplicationShell[];
  const pages: Record<string, StudioApplicationCanvasFrames["pages"][string]> = {};
  sourcePages.forEach((sourcePage, index) => {
    const compiled = content.pages[index];
    if (compiled === undefined || compiled.key !== sourcePage.key || compiled.type !== sourcePage.type)
      throw new Error("Studio compiled page does not match its authored draft");
    const shellId = compiledPageShellId(compiled.composition) ?? undefined;
    const shell = shellId === undefined ? undefined
      : shells.find((candidate) => sameId(String(candidate.shellId), String(shellId)));
    if (shellId !== undefined && shell === undefined)
      throw new Error(`Studio compiled page '${compiled.key}' references a missing shell`);
    pages[sourcePage.id] = {
      pageId: String(compiled.pageId),
      pageName: compiled.name,
      // The frame is the shell alone: its content slots are reserved and empty in the compiled
      // shell, and the canvas draws the page being edited in the outlet they declare.
      frame: splitProjectedPage({ pageId: compiled.pageId, composition: shell?.layout ?? emptyLayout },
        shell).frame,
    };
  });
  const everyItem = Object.fromEntries(
    collectNavigationPermissionKeys(content.navigation).map((key) => [key, true]),
  );
  return {
    applicationName: content.name,
    shells,
    theme: content.theme,
    navigation: projectNavigation(content.navigation, everyItem),
    pages,
  };
};
