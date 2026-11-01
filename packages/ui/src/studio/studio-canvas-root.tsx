"use client";

import type { PuckContext } from "@puckeditor/core";
import { compiledItemSettings } from "@vortex/platform/schema";
import type { ReactNode, SyntheticEvent } from "react";
import type { Breakpoint } from "../definition-error";
import { PagePuckRenderer } from "../page-puck-renderer";
import { RootSlotGapProvider, type VortexPuckMetadata } from "../puck-config";
import type { FieldInputControlReleaseMap, PlatformComponentRegistry } from "../registry";
import type { SlotGapName } from "../layout-styles";
import {
  createAppearanceRootProps,
  createThemeRootProps,
  type PlatformThemeTokens,
} from "../theme";
import type { StudioCanvasFrame } from "./studio-canvas-bridge";

/**
 * What the canvas root draws the page in: the application frame the page belongs to, the
 * appearance the canvas previews and what the frame's blocks need. It reaches the root through
 * Puck's metadata, like every other piece of runtime data.
 */
export type StudioCanvasContext = Readonly<{
  frame: StudioCanvasFrame | undefined;
  appearance: "light" | "dark";
  platformThemeTokens: PlatformThemeTokens;
  registry: PlatformComponentRegistry;
  fieldInputControlReleases: FieldInputControlReleaseMap;
  breakpoint: Breakpoint;
}>;

export type StudioCanvasMetadata = VortexPuckMetadata & Readonly<{ studio: StudioCanvasContext }>;

/**
 * The canvas root's render, inside Puck's preview: the application's theme, appearance and frame
 * (shell and menu) around the page's content. The content region carries the one editor marker,
 * `data-vortex-studio-canvas`, in every Puck mode, so the page lays out the same whether it is
 * being arranged or its grids are.
 */
export function StudioCanvasRoot({
  children,
  gap,
  puck,
}: Readonly<{ children: ReactNode; gap: SlotGapName; puck: PuckContext }>) {
  const { studio } = puck.metadata as StudioCanvasMetadata;
  // The canvas is a design surface: no link in it (menu pages, external addresses, links inside
  // blocks) leaves Studio, so unsaved edits are never lost to a click.
  const inert = (event: SyntheticEvent) => {
    if (event.target instanceof Element && event.target.closest("a[href]") !== null)
      event.preventDefault();
  };
  const content = (
    <div
      data-vortex-studio-canvas=""
      data-vortex-shell-outlet=""
      data-vortex-editing=""
      className="min-h-24"
    >
      <RootSlotGapProvider gap={gap}>{children}</RootSlotGapProvider>
    </div>
  );
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
        <div {...createThemeRootProps(undefined, studio.platformThemeTokens)}>{content}</div>
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
          outlet={{ location: frame.frame.outlet, content }}
        />
      )}
    </div>
  );
}
