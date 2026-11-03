"use client";

import { createUsePuck, type PuckContext } from "@puckeditor/core";
import { compiledItemSettings } from "@vortex/platform/schema";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { isElement, isHtmlElement } from "../lib/dom";
import { PagePuckRenderer } from "../page-puck-renderer";
import {
  createSelectedPlacementStore,
  RootSlotGapProvider,
  SelectedPlacementProvider,
} from "../puck-config";
import type { SlotGapName } from "../layout-styles";
import type { FieldInputControlReleaseMap, PlatformComponentRegistry } from "../registry";
import { createAppearanceRootProps, createThemeRootProps, VortexStyleRoot } from "../theme";
import { studioCanvasMetadata, useStudioCanvasChannel } from "./studio-canvas-metadata";
import { useStudioCanvasView } from "./studio-canvas-scale";
import { useStudioScreen } from "./studio-canvas-screen";
import { studioPuckIframeCss } from "./studio-puck-style";

const resolvePageHref = () => "#";

const usePuckSelector = createUsePuck();

/**
 * Tells the page which block is selected. The selection travels through a store that each block
 * reads for itself, so a new selection draws only the block that lost it and the block that
 * gained it again, not the page.
 */
function SelectedBlock({ children }: Readonly<{ children: ReactNode }>) {
  const [store] = useState(createSelectedPlacementStore);
  const selected = usePuckSelector((state) => state.selectedItem?.props.id);
  useLayoutEffect(() => store.set(selected), [store, selected]);
  return <SelectedPlacementProvider store={store}>{children}</SelectedPlacementProvider>;
}

/**
 * The canvas root's render, inside Puck's preview, in every Puck mode. It draws the application's
 * theme, appearance and frame (shell and menu) from the frame Studio put in the canvas channel, with
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
  const { breakpoint } = studioCanvasMetadata(puck);
  const { frame: studio } = useStudioCanvasChannel();
  if (studio === null) throw new Error("The Studio canvas has no frame");
  const { empty } = studio;
  // A layout's blocks are added with Add; only a page's blocks drop onto the canvas.
  const canDrop = usePuckSelector((state) => state.getPermissions().insert);
  // Studio's own mark of a drag in progress, from Puck's public state, for the empty-slot rules.
  const dragging = usePuckSelector((state) => state.appState.ui.isDragging);
  const content = (
    <div
      data-vortex-studio-canvas=""
      data-vortex-shell-outlet=""
      data-vortex-editing=""
      {...(dragging ? { "data-vortex-dragging": "" } : {})}
      {...(breakpoint === "desktop" ? {} : { "data-vortex-view-only": "" })}
      aria-label={empty ? "Empty content area" : undefined}
      className={empty ? "relative min-h-48" : "min-h-24"}
    >
      <RootSlotGapProvider gap={gap}>
        <SelectedBlock>{children}</SelectedBlock>
      </RootSlotGapProvider>
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
      {/* Puck's overlay sits in the iframe's body, outside this root: its Studio colours (light and
          dark pairs) follow the appearance the canvas previews, not the browser's. */}
      <style data-vortex-studio-appearance="">{`body{color-scheme:${studio.appearance}}`}</style>
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
  const previewMode = usePuckSelector((state) => state.appState.ui.previewMode);
  // While blocks are edited the canvas is a picture of the page, outside Studio's Tab path (blocks
  // are chosen in the Outline); while grids are arranged its column controls need the keyboard.
  useEffect(() => {
    const frame = frameDocument?.defaultView?.frameElement;
    if (isHtmlElement(frame)) frame.tabIndex = previewMode === "interactive" ? 0 : -1;
  }, [frameDocument, previewMode]);
  useEffect(() => {
    if (frameDocument === undefined) return;
    const style = frameDocument.createElement("style");
    style.dataset.vortexStudioPuck = "";
    // Studio's own values, read from the host document that Studio's theme styles.
    const copyStudioValues = () => {
      style.textContent = studioPuckIframeCss(getComputedStyle(document.documentElement));
    };
    copyStudioValues();
    frameDocument.head.append(style);
    // Studio's document root can change its variables while the canvas is open (the theme is applied
    // again after a navigation); the copy follows.
    const themeObserver = new MutationObserver(copyStudioValues);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
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
      themeObserver.disconnect();
      style.remove();
      frameDocument.removeEventListener("keydown", forward);
    };
  }, [frameDocument]);
  // A tablet or phone has overlay scrollbars: the classic bar of a tall page must not narrow the
  // preview below the device's width. Scrolling by wheel and touch is unchanged.
  const { breakpoint } = useStudioScreen();
  useEffect(() => {
    if (frameDocument === undefined || breakpoint === "desktop") return;
    const style = frameDocument.createElement("style");
    style.textContent = "html{scrollbar-width:none}";
    frameDocument.head.append(style);
    return () => style.remove();
  }, [frameDocument, breakpoint]);
  // The canvas is a design surface: no link in it (menu pages, external addresses, links inside
  // blocks) leaves Studio, so unsaved edits are never lost to a click.
  const inert = (event: SyntheticEvent) => {
    if (isElement(event.target) && event.target.closest("a[href]") !== null) event.preventDefault();
  };
  // What the canvas draws for the person (empty-slot labels) counter-scales by the zoom, in CSS.
  const { scale } = useStudioCanvasView();
  return (
    <div
      className="min-h-full"
      style={{ "--vortex-canvas-scale": scale } as CSSProperties}
      onClickCapture={inert}
      onAuxClickCapture={inert}
    >
      {children}
    </div>
  );
}
