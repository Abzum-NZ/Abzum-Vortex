"use client";

import { createUsePuck, type PuckContext } from "@puckeditor/core";
import { compiledItemSettings, type ShellOutletLocation } from "@vortex/platform/schema";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { isElement, isHtmlElement } from "../lib/dom";
import { PagePuckRenderer } from "../page-puck-renderer";
import {
  createSelectedPlacementStore,
  PAGE_ROOT_GAP,
  RootSlotGapProvider,
  SelectedPlacementProvider,
} from "../puck-config";
import type { Breakpoint } from "../definition-error";
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

/** The slot gap of the page root, which the runtime's pages use by default. */

/** Puck's component for one slot of the root; the root receives one for every slot field it declares. */
type RootSlot = (props?: { className?: string; style?: CSSProperties }) => ReactNode;

/**
 * Both elements take the gap of the shell's own slot that holds them (the block that holds the
 * content slot sets it from its release setting), as the running page's outlet does, so the page
 * is spaced on the canvas exactly as it runs. The style is one object for every render.
 */
const OUTLET_STYLE: CSSProperties = { gap: "inherit" };
const SLOT_STYLE: CSSProperties = { display: "flex", flexDirection: "column", gap: "inherit" };

/**
 * One content slot of the page on the canvas: Studio's own element around the slot's content (Puck's
 * slot for a root slot, Puck's default zone for a page in the default frame). The editor-only rules
 * key on the element's `data-vortex-studio-canvas` marker, so the page lays out the same whether it
 * is being edited or its grids are being arranged.
 */
function CanvasSlot({
  content,
  name,
  label,
  breakpoint,
}: Readonly<{
  content: ReactNode;
  name: string | undefined;
  /** What the shell calls the slot; each empty slot is named for it. */
  label: string;
  breakpoint: Breakpoint;
}>) {
  // A layout's blocks are added with Add; only a page's blocks drop onto the canvas.
  const canDrop = usePuckSelector((state) => state.getPermissions().insert);
  // Studio's own mark of a drag in progress, from Puck's public state, for the empty-slot rules.
  const dragging = usePuckSelector((state) => state.appState.ui.isDragging);
  const empty = usePuckSelector((state) => {
    const data = state.appState.data;
    const list =
      name === undefined
        ? data.content
        : (data.root as { props?: Record<string, unknown> }).props?.[name];
    return !Array.isArray(list) || list.length === 0;
  });
  return (
    <div
      data-vortex-studio-canvas=""
      data-vortex-shell-outlet=""
      data-vortex-editing=""
      {...(dragging ? { "data-vortex-dragging": "" } : {})}
      {...(breakpoint === "desktop" ? {} : { "data-vortex-view-only": "" })}
      aria-label={empty ? `Empty ${label}` : undefined}
      className={empty ? "relative min-h-48 min-w-32" : "min-h-24"}
      style={OUTLET_STYLE}
    >
      {content}
      {empty && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {canDrop ? "Drop a block here, or add one from Blocks." : "Add a block from Blocks."}
        </p>
      )}
    </div>
  );
}

/**
 * The canvas root's render, inside Puck's preview, in every Puck mode. It draws the application's
 * theme, appearance and frame (shell and menu) from the frame Studio put in the canvas channel, with
 * each of the page's content slots (the root's slot fields) drawn where the shell declares it. A
 * page in the default frame has one content area, Puck's default zone, which Puck spaces itself:
 * the only public route to the page's block spacing is a root slot.
 */
export function StudioCanvasRoot({
  children,
  puck,
  registry,
  fieldInputControlReleases,
  slotKeys: rootSlots,
  ...rest
}: Readonly<{
  children: ReactNode;
  puck: PuckContext;
  registry: PlatformComponentRegistry;
  fieldInputControlReleases: FieldInputControlReleaseMap;
  /** The page's root slot names, each one a slot component among the other props. */
  slotKeys: readonly string[];
}>) {
  const { breakpoint } = studioCanvasMetadata(puck);
  const { frame: studio } = useStudioCanvasChannel();
  if (studio === null) throw new Error("The Studio canvas has no frame");
  const frame = studio.frame;
  const slots = rest as unknown as Readonly<Record<string, RootSlot>>;
  // Puck hands over a new slot function whenever that slot's blocks change; drawing it as a
  // component type would remount every block in it. Each slot name keeps one component that calls
  // the latest function, as a block's own slots do.
  const latestSlots = useRef<Record<string, RootSlot>>({});
  const stableSlots = useRef<Record<string, RootSlot>>({});
  for (const name of rootSlots) {
    // While Puck draws a new page's config over the old page's data, a slot of the new config can
    // be missing for one render: the last slot function stays, and nothing is drawn without one.
    const slot = slots[name];
    if (slot !== undefined) latestSlots.current[name] = slot;
    stableSlots.current[name] ??= (props) => latestSlots.current[name]?.(props) ?? null;
  }
  const rootSlotsKey = rootSlots.join(" ");
  const shellId = frame?.frame.shellId;
  const shell =
    frame === undefined || shellId === undefined
      ? undefined
      : frame.shells.find((candidate) => String(candidate.shellId) === shellId);
  // Where in the shell each root slot goes: its content slot's parent placement and slot.
  const locations = useMemo(
    (): Readonly<Record<string, ShellOutletLocation>> =>
      Object.fromEntries(
        rootSlots.flatMap((name) => {
          const declared = shell?.contentSlots.find((entry) => entry.key === studio.slotKeys[name]);
          return declared === undefined
            ? []
            : [
                [
                  name,
                  {
                    kind: "slot" as const,
                    placementId: String(declared.parentPlacementId),
                    slotKey: declared.parentSlotKey,
                  },
                ],
              ];
        }),
      ),
    // The slot names are compared by value, so the list keeps one length per render.
    [rootSlotsKey, shell, studio.slotKeys],
  );
  const labelOf = (name: string): string =>
    shell?.contentSlots.find((entry) => entry.key === studio.slotKeys[name])?.label ?? name;
  const slotContent = (name: string) => {
    const Slot = stableSlots.current[name]!;
    return <Slot style={SLOT_STYLE} />;
  };
  // Several content slots sit inside the shell's own placements (the outlet holds the placement
  // that holds them all): that region is drawn from the shell, each slot's editor in its place.
  const outletContent = useMemo(
    () => (frame?.outletContent === undefined ? undefined : { composition: frame.outletContent }),
    [frame?.outletContent],
  );
  const regionOutlets = useMemo(
    () => ({
      locations,
      content: Object.fromEntries(
        rootSlotsKey === ""
          ? []
          : rootSlotsKey
              .split(" ")
              .map((name) => [
                name,
                <CanvasSlot
                  key={name}
                  content={slotContent(name)}
                  name={name}
                  label={labelOf(name)}
                  breakpoint={breakpoint}
                />,
              ]),
      ),
    }),
    // The slot components are stable per name; the region follows the names, not the functions.
    [locations, rootSlotsKey, breakpoint],
  );
  const content =
    outletContent !== undefined && frame !== undefined && rootSlots.length > 0 ? (
      <SelectedBlock>
        <RootSlotGapProvider gap={PAGE_ROOT_GAP}>
          <PagePuckRenderer
            contentRegion
            readSettings={compiledItemSettings}
            composition={outletContent}
            breakpoint={breakpoint}
            registry={registry}
            fieldInputControlReleases={fieldInputControlReleases}
            platformThemeTokens={studio.platformThemeTokens}
            {...(shell === undefined ? {} : { shell })}
            theme={frame.theme}
            projectedNavigation={frame.navigation}
            resolvePageHref={resolvePageHref}
            currentPageId={frame.pageId}
            contentOutlets={regionOutlets}
          />
        </RootSlotGapProvider>
      </SelectedBlock>
    ) : (
      <SelectedBlock>
        <RootSlotGapProvider gap={PAGE_ROOT_GAP}>
          {rootSlots.length === 0 ? (
            <CanvasSlot content={children} name={undefined} label="page" breakpoint={breakpoint} />
          ) : (
            rootSlots.map((name) => (
              <CanvasSlot
                key={name}
                content={slotContent(name)}
                name={name}
                label={labelOf(name)}
                breakpoint={breakpoint}
              />
            ))
          )}
        </RootSlotGapProvider>
      </SelectedBlock>
    );
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
