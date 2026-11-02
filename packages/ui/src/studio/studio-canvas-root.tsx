"use client";

import { createUsePuck, type PuckContext } from "@puckeditor/core";
import { compiledItemSettings } from "@vortex/platform/schema";
import { useEffect, useMemo, type ReactNode, type SyntheticEvent } from "react";
import { isElement, isHtmlElement } from "../lib/dom";
import { PagePuckRenderer } from "../page-puck-renderer";
import { RootSlotGapProvider } from "../puck-config";
import type { SlotGapName } from "../layout-styles";
import type { FieldInputControlReleaseMap, PlatformComponentRegistry } from "../registry";
import { createAppearanceRootProps, createThemeRootProps, VortexStyleRoot } from "../theme";
import { studioCanvasMetadata } from "./studio-canvas-metadata";
import { studioPuckIframeCss } from "./studio-puck-style";

const resolvePageHref = () => "#";
const usePuckSelector = createUsePuck();

/**
 * The canvas root's render, inside Puck's preview, in every Puck mode. It draws the application's
 * theme, appearance and frame (shell and menu) from the frame Studio put in Puck's `metadata`, with
 * the page's content region in the frame's outlet. The content region carries the one editor
 * marker `data-vortex-studio-canvas` that every editor-only rule keys on, so the page lays out the
 * same whether it is being edited or its grids are being arranged.
 */
export function StudioCanvasRoot({
  children,
  gap,
  puck,
  registry,
  fieldInputControlReleases,
}: Readonly<{
  children: ReactNode;
  gap: SlotGapName;
  puck: PuckContext;
  registry: PlatformComponentRegistry;
  fieldInputControlReleases: FieldInputControlReleaseMap;
}>) {
  const { frame: studio, breakpoint } = studioCanvasMetadata(puck);
  if (studio === null) throw new Error("The Studio canvas has no frame");
  const { empty } = studio;
  // A layout's blocks are added with Add; only a page's blocks drop onto the canvas.
  const canDrop = usePuckSelector((state) => state.getPermissions().insert);
  const content = (
    <div
      data-vortex-studio-canvas=""
      data-vortex-shell-outlet=""
      data-vortex-editing=""
      aria-label={empty ? "Empty content area" : undefined}
      className={empty ? "relative min-h-48" : "min-h-24"}
    >
      <RootSlotGapProvider gap={gap}>{children}</RootSlotGapProvider>
      {empty && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {canDrop ? "Drop a block here, or add one from Blocks." : "Add a block from Blocks."}
        </p>
      )}
    </div>
  );
  const frame = studio.frame;
  const applicationName = frame?.applicationName ?? "";
  const pageName = frame?.pageName ?? "";
  // Stable while the application and page are: the shell below is not drawn again for other changes.
  const applicationSwitcherSource = useMemo(
    () => async () => ({
      state: "available" as const,
      applications: [{ key: applicationName, name: applicationName, href: "#" }],
    }),
    [applicationName],
  );
  const applicationShellRuntime = useMemo(
    () => ({ applicationName, applicationHref: "#", organizationName: "", pageName }),
    [applicationName, pageName],
  );
  const shellId = frame?.frame.shellId;
  const shell =
    frame === undefined || shellId === undefined
      ? undefined
      : frame.shells.find((candidate) => String(candidate.shellId) === shellId);
  return (
    <div
      {...createAppearanceRootProps(studio.appearance)}
      className="min-h-full bg-background text-foreground"
    >
      {frame === undefined ? (
        // No frame yet (a page the compiled frames do not list): blocks still get their own style
        // root, so their popovers open inside the iframe and not in Studio's document.
        <VortexStyleRoot {...createThemeRootProps(undefined, studio.platformThemeTokens)}>
          {content}
        </VortexStyleRoot>
      ) : (
        <PagePuckRenderer
          readSettings={compiledItemSettings}
          composition={frame.frame}
          breakpoint={breakpoint}
          registry={registry}
          fieldInputControlReleases={fieldInputControlReleases}
          platformThemeTokens={studio.platformThemeTokens}
          {...(shell === undefined ? {} : { shell })}
          theme={frame.theme}
          projectedNavigation={frame.navigation}
          resolvePageHref={resolvePageHref}
          currentPageId={frame.pageId}
          // The switcher names only the application being designed.
          applicationSwitcherSource={applicationSwitcherSource}
          applicationShellRuntime={applicationShellRuntime}
          outlet={{ location: frame.frame.outlet, content }}
        />
      )}
    </div>
  );
}

/**
 * Puck's `iframe` override: the document the canvas's page sits in. It gives Puck's overlay inside
 * the iframe its colours, passes Studio's shortcuts on to the host and keeps every link inert.
 */
export function StudioCanvasIframe({
  children,
  document: frameDocument,
}: Readonly<{ children: ReactNode; document?: Document | undefined }>) {
  useEffect(() => {
    if (frameDocument === undefined) return;
    const style = frameDocument.createElement("style");
    style.dataset.vortexStudioPuck = "";
    style.textContent = studioPuckIframeCss;
    frameDocument.head.append(style);
    // Keys pressed while focus is inside the iframe reach only its own document. Studio's shortcuts
    // (Undo, Redo, the inspector, the panel) listen on the host window, so they are passed on there,
    // as Puck passes on pointer moves. Typing in a field is left alone.
    const forward = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        isHtmlElement(target) &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      )
        return;
      // A dialog inside the canvas owns its keys: they are not Studio's shortcuts.
      if (isElement(target) && target.closest('[role="dialog"],[role="alertdialog"]') !== null)
        return;
      const copy = new KeyboardEvent("keydown", {
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        repeat: event.repeat,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(copy);
      if (copy.defaultPrevented) event.preventDefault();
    };
    frameDocument.addEventListener("keydown", forward);
    return () => {
      style.remove();
      frameDocument.removeEventListener("keydown", forward);
    };
  }, [frameDocument]);
  // The canvas is a design surface: no link in it (menu pages, external addresses, links inside
  // blocks) leaves Studio, so unsaved edits are never lost to a click.
  const inert = (event: SyntheticEvent) => {
    if (isElement(event.target) && event.target.closest("a[href]") !== null) event.preventDefault();
  };
  return (
    <div className="min-h-full" onClickCapture={inert} onAuxClickCapture={inert}>
      {children}
    </div>
  );
}
