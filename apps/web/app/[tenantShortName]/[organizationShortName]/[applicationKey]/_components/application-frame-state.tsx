"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type MouseEvent,
} from "react";
import { usePagePresence } from "@vortex/ui";
import type { ProjectedApplicationFrame, ProjectedNavigation } from "@vortex/platform/schema";
import type {
  ApplicationWebMcpRuntime,
  PagePuckRendererProps,
  UnsavedWorkGuard,
} from "@vortex/ui";

/** What the current page tells the frame around it. Each part is absent until the page sets it. */
export type ApplicationFramePageState = Readonly<{
  /** The page's identity and its own name for the breadcrumb. */
  page?: Readonly<{ pageId: string; name: string }>;
  /** The page's browser agent tool state, shown in the header. */
  webMcp?: ApplicationWebMcpRuntime;
  /** The page's unsaved-work guard, consulted before the frame leaves the page. */
  unsavedWork?: UnsavedWorkGuard;
  /** The release the page offers to adopt, for the account menu. */
  releaseAdoption?: Readonly<{ version: string; adopt: () => void | Promise<void> }>;
  /** The frame projected with the page, which replaces the frame the layout projected. */
  frame?: ProjectedApplicationFrame;
  /** The viewer's menu projected with the page, which replaces the layout's. */
  navigation?: ProjectedNavigation;
  /** The page runtime's inputs for the frame's own placements (shell blocks with data or events). */
  runtimeInputs?: PagePuckRendererProps["runtimeInputs"];
}>;

/** The identity of one registration; only its owner can clear what it set. */
export type FramePageStateOwner = Readonly<Record<string, never>>;

export type ApplicationFrameStateValue = Readonly<{
  /** Sets one part of the page state on behalf of `owner`. */
  setPageState: <Key extends keyof ApplicationFramePageState>(
    key: Key,
    value: ApplicationFramePageState[Key] | undefined,
    owner: FramePageStateOwner,
  ) => void;
  /** Clears one part of the page state, only while `owner` is still the one that set it. */
  clearPageState: (key: keyof ApplicationFramePageState, owner: FramePageStateOwner) => void;
  /** A client-side page change that keeps the frame mounted. */
  navigateToPage: (pageId: string, event: MouseEvent<HTMLAnchorElement>) => void;
  /** Runs a client-side address change the page starts inside the frame's page transition. */
  startPageChange: (navigate: () => void) => void;
  /** The application search the header shows, also offered to a search block in the content. */
  applicationSearch: PagePuckRendererProps["applicationSearch"];
  applicationSearchPageSubject: string | undefined;
}>;

const ApplicationFrameStateContext = createContext<ApplicationFrameStateValue | null>(null);

export const ApplicationFrameStateProvider = ApplicationFrameStateContext.Provider;

/** The frame around the current page, when the page is shown in one. */
export const useApplicationFrame = (): ApplicationFrameStateValue | null =>
  useContext(ApplicationFrameStateContext);

/**
 * Registers one part of the page's state with the frame while the page is the current one. It is
 * set before paint, so the frame never shows the previous page's value after the page has changed.
 * A page that is leaving (still mounted while it animates out) stops registering and withdraws only
 * what it still owns, so it never clears or overwrites what the incoming page registered.
 */
export const useFramePageState = <Key extends keyof ApplicationFramePageState>(
  key: Key,
  value: ApplicationFramePageState[Key] | undefined,
): void => {
  const frame = useApplicationFrame();
  const setPageState = frame?.setPageState;
  const clearPageState = frame?.clearPageState;
  const present = usePagePresence();
  const [owner] = useState<FramePageStateOwner>(() => ({}));
  useLayoutEffect(() => {
    if (setPageState === undefined || !present) return;
    setPageState(key, value, owner);
  }, [key, owner, present, setPageState, value]);
  useLayoutEffect(() => {
    if (clearPageState === undefined) return;
    if (!present) {
      clearPageState(key, owner);
      return;
    }
    return () => clearPageState(key, owner);
  }, [clearPageState, key, owner, present]);
};
