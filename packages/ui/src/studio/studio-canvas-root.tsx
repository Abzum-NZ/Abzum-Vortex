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
import { DeferredDrawingProvider, type DeferredDrawing } from "../deferred-drawing";
import { slotGapLength } from "../layout-styles";
import { PagePuckRenderer, type PagePuckRendererProps } from "../page-puck-renderer";
import {
  createSelectedPlacementStore,
  PAGE_ROOT_GAP,
  RootSlotGapProvider,
  SelectedPlacementProvider,
} from "../puck-config";
import { LockableSlot } from "../slot-lock";
import type { Breakpoint } from "../definition-error";
import type { FieldInputControlReleaseMap, PlatformComponentRegistry } from "../registry";
import { createAppearanceRootProps, createThemeRootProps, VortexStyleRoot } from "../theme";
import { studioCanvasMetadata, useStudioCanvasChannel } from "./studio-canvas-metadata";
import { studioCanvasVisible, useStudioCanvasView } from "./studio-canvas-scale";
import { useStudioScreen } from "./studio-canvas-screen";
import { studioPuckIframeCss } from "./studio-puck-style";
import {
  useStudioCanvas,
  useStudioCanvasDragging,
  useStudioFrameDocumentSetter,
} from "./studio-puck-provider";

const resolvePageHref = () => "#";

/**
 * The frame of a layout on the canvas: the shell's chrome with nothing in it, and one outlet at its
 * root where Puck's content (the layout's own blocks) is drawn. One object, as the renderer keeps
 * what it resolved for it.
 */
const LAYOUT_FRAME: PagePuckRendererProps["composition"] = {
  composition: {
    root: { props: { vortex: { slotOrders: { content: { tablet: [], phone: [] } } } } },
    content: [],
  },
};
const LAYOUT_OUTLET: ShellOutletLocation = { kind: "root" };

/** How far past what the canvas shows (in the page's pixels) a waiting slot is drawn. */
const DRAW_AHEAD = 1200;

const usePuckSelector = createUsePuck();

/**
 * Tells the page which block is selected. The selection travels through a store that each block
 * reads for itself, so a new selection draws only the block that lost it and the block that
 * gained it again, not the page.
 */
function SelectedBlock({ children }: Readonly<{ children: ReactNode }>) {
  const [store] = useState(createSelectedPlacementStore);
  const selected = usePuckSelector((state) => state.selectedItem?.props.id);
  // The blocks that hold the selected one, nearest first, each with the key of its slot the
  // selection is in (a block of tabs shows the tab that holds it).
  const holders = usePuckSelector((state) => {
    const chain: [id: string, slot: string][] = [];
    let child = selected;
    let parent = child === undefined ? undefined : state.getParentById(child);
    while (child !== undefined && parent !== undefined && parent !== null) {
      const zone = state.getSelectorForId(child)?.zone ?? "";
      chain.push([parent.props.id, zone.slice(zone.indexOf(":") + 1)]);
      child = parent.props.id;
      parent = state.getParentById(child);
    }
    return JSON.stringify(chain);
  });
  useLayoutEffect(
    () =>
      store.set(
        selected,
        (JSON.parse(holders) as [string, string][]).map(([id, slot]) => ({ id, slot })),
      ),
    [store, selected, holders],
  );
  return <SelectedPlacementProvider store={store}>{children}</SelectedPlacementProvider>;
}

/**
 * Puck's component for one slot of the root; the root receives one for every slot field it
 * declares.
 */
type RootSlot = (props?: { className?: string; style?: CSSProperties }) => ReactNode;

/**
 * Both elements take the gap of the shell's own slot that holds them (the block that holds the
 * content slot sets it from its release setting), as the running page's outlet does, so the page
 * is spaced on the canvas exactly as it runs. The style is one object for every render.
 */
const OUTLET_STYLE: CSSProperties = { gap: "inherit" };
const SLOT_STYLE: CSSProperties = { display: "flex", flexDirection: "column", gap: "inherit" };
/**
 * A layout's top level is Puck's default zone, which takes no style from Studio: the blocks
 * stacked in it are spaced by the page root's gap, as the running frame spaces them (see the
 * layout styles).
 */
const LAYOUT_OUTLET_STYLE: CSSProperties = {
  ...OUTLET_STYLE,
  ["--vortex-layout-gap" as string]: slotGapLength(PAGE_ROOT_GAP),
};

/**
 * One content slot of the page on the canvas: Studio's own element around the slot's content
 * (Puck's slot for a root slot, Puck's default zone for a page in the default frame). The
 * editor-only rules key on the element's `data-vortex-studio-canvas` marker, so the page lays out
 * the same whether it is being edited or its grids are being arranged.
 */
function CanvasSlot({
  content,
  name,
  label,
  breakpoint,
  layout = false,
}: Readonly<{
  content: ReactNode;
  name: string | undefined;
  /** The top level of a layout (not of a page). */
  layout?: boolean;
  /** What the shell calls the slot; each empty slot is named for it. */
  label: string;
  breakpoint: Breakpoint;
}>) {
  const canDrop = usePuckSelector((state) => state.getPermissions().insert);
  // Studio's own mark of a drag in progress, from Puck's public state, for the empty-slot rules.
  const dragging = useStudioCanvasDragging();
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
      {...(breakpoint === "desktop" ? {} : { "data-vortex-order-only": "" })}
      aria-label={empty ? `Empty ${label}` : undefined}
      className={empty ? "relative min-h-48 min-w-32" : "min-h-24"}
      {...(layout ? { "data-vortex-layout-root": "" } : {})}
      style={layout ? LAYOUT_OUTLET_STYLE : OUTLET_STYLE}
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
 * theme, appearance and frame (shell and menu) from the frame Studio put in the canvas channel,
 * with each of the page's content slots (the root's slot fields) drawn where the shell declares
 * it. A page in the default frame has one content area, Puck's default zone, which Puck spaces
 * itself: the only public route to the page's block spacing is a root slot.
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
    // Until Puck holds the page's config (it opens on the empty one before the field controls
    // load), a declared slot has no function yet: the last one stays, and nothing is drawn without
    // one.
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
    return <LockableSlot Slot={Slot} zone={`root:${name}`} style={SLOT_STYLE} />;
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
            <CanvasSlot
              content={children}
              name={undefined}
              label={studio.layout ? "layout" : "page"}
              breakpoint={breakpoint}
              layout={studio.layout}
            />
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
  // Stable while the application and page are: the shell below is not drawn again for other
  // changes.
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
          // A layout is drawn from Puck's content inside the shell's chrome, not from the saved
          // frame.
          composition={studio.layout ? LAYOUT_FRAME : frame.frame}
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
          outlet={{ location: studio.layout ? LAYOUT_OUTLET : frame.frame.outlet, content }}
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
  // The provider reaches the canvas's document (the drop animation, the scroll to a chosen block)
  // through this override, which Puck hands the document.
  const setFrameDocument = useStudioFrameDocumentSetter();
  useEffect(() => {
    setFrameDocument(frameDocument ?? null);
    return () => setFrameDocument(null);
  }, [setFrameDocument, frameDocument]);
  // The iframe is Puck's and Puck gives it no title: it is named through the document Puck hands
  // to this override (the standard `frameElement` of that document), so assistive technology
  // announces the canvas.
  useEffect(() => {
    frameDocument?.defaultView?.frameElement?.setAttribute("title", "Canvas preview");
  }, [frameDocument]);
  // A block chosen outside the canvas (the Outline, the inspector, an address) is brought into
  // view, found by Studio's own attribute on its wrapper. It may not be drawn yet (its slots wait),
  // and the slots around it are drawn after the scroll with heights that were estimates, so it is
  // kept in view for a few seconds, until the person scrolls or acts anywhere in Studio (the frame,
  // the well's scrollbar, a panel) or begins a drag: that also cancels the wait for a block that is
  // not drawn yet. A block chosen by a click in the canvas is already where the person is looking
  // and is not scrolled to (the click's block is the one under the pointer, found by Studio's
  // attribute).
  const selectedId = usePuckSelector((state) => state.selectedItem?.props.id);
  const dragging = useStudioCanvasDragging();
  const draggingRef = useRef(dragging);
  draggingRef.current = dragging;
  const stopFollowing = useRef<(() => void) | null>(null);
  const clickedBlock = useRef<string | null>(null);
  useEffect(() => {
    if (dragging) stopFollowing.current?.();
  }, [dragging]);
  useEffect(() => {
    if (frameDocument === undefined) return;
    const note = (event: PointerEvent) => {
      const hit = frameDocument
        .elementsFromPoint(event.clientX, event.clientY)
        .find((element) => element.hasAttribute("data-vortex-placement-id"));
      clickedBlock.current = hit?.getAttribute("data-vortex-placement-id") ?? null;
    };
    frameDocument.addEventListener("pointerdown", note, { capture: true, passive: true });
    return () => frameDocument.removeEventListener("pointerdown", note, { capture: true });
  }, [frameDocument]);
  useEffect(() => {
    if (frameDocument === undefined || selectedId === undefined) return;
    const clicked = clickedBlock.current;
    clickedBlock.current = null;
    if (clicked === selectedId) return;
    let frame = 0;
    let tries = 0;
    let stopped = false;
    let observer: MutationObserver | undefined;
    let timer = 0;
    const interactions = ["wheel", "pointerdown", "keydown", "touchstart"] as const;
    const stop = () => {
      stopped = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      clearTimeout(timer);
      for (const name of interactions) {
        frameDocument.removeEventListener(name, stop);
        document.removeEventListener(name, stop);
      }
      stopFollowing.current = null;
    };
    // Listening starts at once, so a scroll or a drag while the block is not drawn yet cancels it.
    stopFollowing.current = stop;
    for (const name of interactions) {
      frameDocument.addEventListener(name, stop, { passive: true });
      document.addEventListener(name, stop, { passive: true });
    }
    const find = () =>
      frameDocument.querySelector(`[data-vortex-placement-id="${CSS.escape(selectedId)}"]`);
    const scroll = () => {
      if (stopped || draggingRef.current) return;
      const block = find();
      if (block === null) {
        if (tries++ < 600) frame = requestAnimationFrame(scroll);
        return;
      }
      block.scrollIntoView({ block: "nearest" });
      timer = window.setTimeout(stop, 6000);
      // Slots drawn (or drawn again) change the page's size: what is added to the body is watched.
      observer = new MutationObserver(() => {
        if (!draggingRef.current) find()?.scrollIntoView({ block: "nearest" });
      });
      observer.observe(frameDocument.body, { childList: true, subtree: true });
    };
    frame = requestAnimationFrame(scroll);
    return stop;
  }, [frameDocument, selectedId]);
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
    // Studio's document root can change its variables while the canvas is open (the theme is
    // applied again after a navigation); the copy follows.
    const themeObserver = new MutationObserver(copyStudioValues);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    // Keys pressed while focus is inside the iframe reach only its own document. Studio's shortcuts
    // (Undo, Redo, the inspector, the panel) listen on the host window, so they are passed on
    // there, as Puck passes on pointer moves. Typing in a field is left alone.
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
  const view = useStudioCanvasView();
  const { scale } = view;
  // A slot far from what the well shows is drawn when it comes near (see `DeferredSlot`): the
  // well's and the page's own scrolls tell the slots that wait, once per frame.
  const viewRef = useRef(view);
  viewRef.current = view;
  const { gridHolders } = useStudioCanvas().model;
  const interactive = previewMode === "interactive";
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  const gridHoldersRef = useRef(gridHolders);
  gridHoldersRef.current = gridHolders;
  const documentRef = useRef(frameDocument);
  documentRef.current = frameDocument;
  const waiting = useRef(new Set<() => void>());
  // The block at the top of the view before slots above it are drawn: the well is scrolled by how
  // far it moved, so what the person is looking at stays where it is.
  const anchored = useRef<{ element: Element; top: number } | null>(null);
  const deferral = useMemo(
    (): DeferredDrawing => ({
      near: (element, holder) => {
        // While grids are arranged their column controls need the keyboard: the slots that hold a
        // grid are drawn at once; the others wait as they do when blocks are edited.
        if (interactiveRef.current && gridHoldersRef.current.has(holder)) return true;
        const visible = studioCanvasVisible(viewRef.current);
        const box = element.getBoundingClientRect();
        // Until the well has laid the frame out, the first screens are what is near.
        if (visible === undefined) return box.top < DRAW_AHEAD * 2;
        return box.bottom >= visible.top - DRAW_AHEAD && box.top <= visible.bottom + DRAW_AHEAD;
      },
      subscribe: (listener) => {
        waiting.current.add(listener);
        return () => waiting.current.delete(listener);
      },
      anchor: () => {
        const target = documentRef.current;
        const visible = studioCanvasVisible(viewRef.current);
        if (anchored.current !== null || target === undefined || visible === undefined) return;
        const element = target.elementFromPoint(
          target.documentElement.clientWidth / 2,
          Math.max(0, visible.top + 4),
        );
        if (element === null) return;
        const noted = { element, top: element.getBoundingClientRect().top };
        anchored.current = noted;
        // The slot that drew settles in the commit that follows; a note a frame old is stale.
        requestAnimationFrame(() => {
          if (anchored.current === noted) anchored.current = null;
        });
      },
      settle: () => {
        const was = anchored.current;
        anchored.current = null;
        // The canvas scrolls in its own document (Puck's frame has the well's height).
        const scroller = documentRef.current?.scrollingElement;
        if (was === null || scroller == null || !was.element.isConnected) return;
        const moved = was.element.getBoundingClientRect().top - was.top;
        if (moved !== 0) scroller.scrollTop += moved;
      },
    }),
    [],
  );
  useEffect(() => {
    const well = view.well;
    let frame = 0;
    const tell = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        for (const listener of [...waiting.current]) listener();
      });
    };
    well?.addEventListener("scroll", tell, { passive: true });
    frameDocument?.addEventListener("scroll", tell, { passive: true });
    // The page or the well changes size with no scroll (a block removed or restored, another screen
    // size, a slot drawn shorter than its placeholder): slots are looked at again.
    const resize = new ResizeObserver(tell);
    let frameResize: ResizeObserver | undefined;
    if (well !== null) resize.observe(well);
    const drawn = new MutationObserver(tell);
    if (frameDocument !== undefined) {
      drawn.observe(frameDocument.body, { childList: true, subtree: true });
      // A screen size change resizes the frame itself and reflows the page without a new node: the
      // frame's own window delivers it (an observer of another document's realm is not relied on).
      const FrameResize = frameDocument.defaultView?.ResizeObserver;
      frameResize = FrameResize === undefined ? undefined : new FrameResize(tell);
      frameResize?.observe(frameDocument.documentElement);
    }
    // The frame is laid out or scaled after the first draw: slots are looked at again.
    tell();
    return () => {
      cancelAnimationFrame(frame);
      well?.removeEventListener("scroll", tell);
      frameDocument?.removeEventListener("scroll", tell);
      resize.disconnect();
      frameResize?.disconnect();
      drawn.disconnect();
    };
  }, [view.well, view.scale, frameDocument, interactive]);
  return (
    <DeferredDrawingProvider value={deferral}>
      <div
        className="min-h-full"
        style={{ "--vortex-canvas-scale": scale } as CSSProperties}
        onClickCapture={inert}
        onAuxClickCapture={inert}
      >
        {children}
      </div>
    </DeferredDrawingProvider>
  );
}
