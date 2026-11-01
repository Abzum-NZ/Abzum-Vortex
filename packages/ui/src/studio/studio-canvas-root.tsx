"use client";

import type { PuckContext } from "@puckeditor/core";
import { compiledItemSettings } from "@vortex/platform/schema";
import { createContext, useContext, useEffect, type ReactNode, type SyntheticEvent } from "react";
import type { Breakpoint } from "../definition-error";
import { PagePuckRenderer } from "../page-puck-renderer";
import { RootSlotGapProvider } from "../puck-config";
import type { FieldInputControlReleaseMap, PlatformComponentRegistry } from "../registry";
import type { SlotGapName } from "../layout-styles";
import {
  createAppearanceRootProps,
  createThemeRootProps,
  type PlatformThemeTokens,
} from "../theme";
import type { StudioCanvasFrame } from "./studio-canvas-bridge";
import { studioPuckIframeCss } from "./studio-puck-style";

/**
 * What the canvas draws the page in: the application frame the page belongs to, the appearance the
 * canvas previews and what the frame's blocks need.
 */
export type StudioCanvasContext = Readonly<{
  frame: StudioCanvasFrame | undefined;
  appearance: "light" | "dark";
  platformThemeTokens: PlatformThemeTokens;
  registry: PlatformComponentRegistry;
  fieldInputControlReleases: FieldInputControlReleaseMap;
  breakpoint: Breakpoint;
}>;

const StudioCanvasFrameContext = createContext<StudioCanvasContext | null>(null);

/** Supplies the frame the canvas's iframe draws the page in. */
export const StudioCanvasFrameProvider = StudioCanvasFrameContext.Provider;

/**
 * The canvas root's render, inside Puck's preview, in every Puck mode: the page's content region,
 * carrying the one editor marker `data-vortex-studio-canvas` that every editor-only rule keys on,
 * so the page lays out the same whether it is being edited or its grids are being arranged.
 */
export function StudioCanvasRoot({
  children,
  gap,
}: Readonly<{ children: ReactNode; gap: SlotGapName; puck: PuckContext }>) {
  return (
    <div
      data-vortex-studio-canvas=""
      data-vortex-shell-outlet=""
      data-vortex-editing=""
      className="min-h-24"
    >
      <RootSlotGapProvider gap={gap}>{children}</RootSlotGapProvider>
    </div>
  );
}

/**
 * Puck's `iframe` override: everything inside the canvas's iframe. It draws the application's
 * theme, appearance and frame (shell and menu) around Puck's page, which sits in the frame's
 * outlet, and gives Puck's overlay inside the iframe its colours.
 */
export function StudioCanvasIframe({
  children,
  document: frameDocument,
}: Readonly<{ children: ReactNode; document?: Document | undefined }>) {
  const studio = useContext(StudioCanvasFrameContext);
  useEffect(() => {
    if (frameDocument === undefined) return;
    const style = frameDocument.createElement("style");
    style.dataset.vortexStudioPuck = "";
    style.textContent = studioPuckIframeCss;
    frameDocument.head.append(style);
    return () => style.remove();
  }, [frameDocument]);
  if (studio === null) throw new Error("The Studio canvas has no frame context");
  // The canvas is a design surface: no link in it (menu pages, external addresses, links inside
  // blocks) leaves Studio, so unsaved edits are never lost to a click.
  const inert = (event: SyntheticEvent) => {
    if (event.target instanceof Element && event.target.closest("a[href]") !== null)
      event.preventDefault();
  };
  const frame = studio.frame;
  const shellId = frame?.frame.shellId;
  const shell =
    frame === undefined || shellId === undefined
      ? undefined
      : frame.shells.find((candidate) => String(candidate.shellId) === shellId);
  return (
    <div
      {...createAppearanceRootProps(studio.appearance)}
      className="min-h-full bg-background text-foreground"
      onClickCapture={inert}
      onAuxClickCapture={inert}
    >
      {frame === undefined ? (
        <div {...createThemeRootProps(undefined, studio.platformThemeTokens)}>{children}</div>
      ) : (
        <PagePuckRenderer
          readSettings={compiledItemSettings}
          composition={frame.frame}
          breakpoint={studio.breakpoint}
          registry={studio.registry}
          fieldInputControlReleases={studio.fieldInputControlReleases}
          platformThemeTokens={studio.platformThemeTokens}
          {...(shell === undefined ? {} : { shell })}
          theme={frame.theme}
          projectedNavigation={frame.navigation}
          resolvePageHref={() => "#"}
          currentPageId={frame.pageId}
          // The switcher names only the application being designed.
          applicationSwitcherSource={async () => ({
            state: "available",
            applications: [{ key: frame.applicationName, name: frame.applicationName, href: "#" }],
          })}
          applicationShellRuntime={{
            applicationName: frame.applicationName,
            applicationHref: "#",
            organizationName: "",
            pageName: frame.pageName,
          }}
          outlet={{ location: frame.frame.outlet, content: children }}
        />
      )}
    </div>
  );
}
