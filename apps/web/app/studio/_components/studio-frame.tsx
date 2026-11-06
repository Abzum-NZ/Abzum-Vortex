"use client";

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useStable } from "./use-stable";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@vortex/ui/components/input-group";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@vortex/ui/components/sheet";
import { APPLICATION_MAIN_CONTENT_ID, Icon, type VortexIconName } from "@vortex/ui";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@vortex/ui/components/collapsible";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePanelRef,
} from "@vortex/ui/components/resizable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@vortex/ui/components/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vortex/ui/components/tooltip";
import { Separator } from "@vortex/ui/components/separator";
import { Kbd } from "@vortex/ui/components/kbd";
import { cn } from "@vortex/ui/lib/utils";
import { useStudioCanvasDragging } from "@vortex/ui/studio/puck-provider";

/** The one scroll body of a Studio rail panel and its inspector; positioned, so screen-reader-only text stays inside the scroll area. */
export const STUDIO_RAIL_BODY_CLASS = "relative min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-3";

/**
 * Studio's own frame: a top bar over an icon rail, the rail tab's panel, the canvas and the
 * inspector. The frame is platform chrome, so it uses the platform theme's tokens only; the
 * application's own theme belongs to whatever the canvas draws.
 */

export type StudioRailTab<Key extends string> = Readonly<{
  key: Key;
  label: string;
  icon: VortexIconName;
  /** False for a tab whose editor is the centre alone: it has no side panel, so no panel opens for it. */
  panel?: false;
  group: "build" | "logic" | "look" | "releases";
}>;

/** The width limits (in rem) of the panel beside the rail and of the inspector. */
const panelLimits = { minimum: 15, maximum: 32 } as const;
const inspectorLimits = { minimum: 18, maximum: 30 } as const;
const clampWidth = (rem: number, limits: Readonly<{ minimum: number; maximum: number }>): number =>
  Math.min(limits.maximum, Math.max(limits.minimum, Math.round(rem * 4) / 4));

const widthStorageKey = "vortex.studio.panel-widths";
const readStoredWidths = (): Record<string, number> => {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(widthStorageKey) ?? "{}");
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );
  } catch {
    // A private window or blocked storage: every tab opens at its own width.
    return {};
  }
};
// The workspace is drawn inside the canvas editor, which is opened again when a page has other
// outlets than the last one: what the person set (panel, inspector, focus mode) is held here, so a
// reopen draws it as it was.
const panelsBeforeFocus = { panel: true, inspector: true };
const heldWorkspace = new Map<string, unknown>();
const workspaceListeners = new Set<() => void>();
const useHeldWorkspace = <Value,>(
  name: string,
  initial: Value,
): [Value, (next: Value | ((current: Value) => Value)) => void] => {
  const value = useSyncExternalStore(
    (listener) => {
      workspaceListeners.add(listener);
      return () => workspaceListeners.delete(listener);
    },
    () => (heldWorkspace.has(name) ? (heldWorkspace.get(name) as Value) : initial),
    () => initial,
  );
  const set = useCallback(
    (next: Value | ((current: Value) => Value)) => {
      const current = heldWorkspace.has(name) ? (heldWorkspace.get(name) as Value) : initial;
      heldWorkspace.set(
        name,
        typeof next === "function" ? (next as (c: Value) => Value)(current) : next,
      );
      for (const notify of workspaceListeners) notify();
    },
    [name, initial],
  );
  return [value, set];
};
const collapsedStorageKey = "vortex.studio.panel-collapsed";
// Without storage (a private window) the choice lasts for this visit only.
let heldCollapsed: boolean | undefined;
const collapsedListeners = new Set<() => void>();
const readCollapsed = (): boolean => {
  if (heldCollapsed !== undefined) return heldCollapsed;
  try {
    return window.localStorage.getItem(collapsedStorageKey) === "true";
  } catch {
    // Blocked storage: the panel opens, as it does by default.
    return false;
  }
};
const storeCollapsed = (collapsed: boolean): void => {
  try {
    window.localStorage.setItem(collapsedStorageKey, String(collapsed));
  } catch {
    // The choice is a convenience; without storage the held value covers this visit.
    heldCollapsed = collapsed;
  }
  for (const notify of collapsedListeners) notify();
};
const subscribeCollapsed = (notify: () => void): (() => void) => {
  collapsedListeners.add(notify);
  window.addEventListener("storage", notify);
  return () => {
    collapsedListeners.delete(notify);
    window.removeEventListener("storage", notify);
  };
};
// The server and the first client render do not know the choice (`null`); it resolves in the same
// post-hydration render as the layout width, so the panel never shows and then folds away.
const readCollapsedOnServer = (): boolean | null => null;
const storeWidths = (widths: Readonly<Record<string, number>>): void => {
  try {
    window.localStorage.setItem(widthStorageKey, JSON.stringify(widths));
  } catch {
    // The width is a convenience; without storage it lasts for this visit only.
  }
};

/**
 * The panel and the inspector keep the width the person drags them to, in this browser, the same
 * for every rail tab so the canvas stays where it is. `loaded` turns true once the stored
 * widths are read, so the frame can apply them to panels that were already drawn.
 */
function useStudioPanelWidths() {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setWidths(readStoredWidths());
    setLoaded(true);
  }, []);
  const widthOf = useCallback(
    (key: "panel" | "inspector", initial: number): number =>
      key === "inspector"
        ? clampWidth(widths[key] ?? initial, inspectorLimits)
        : clampWidth(widths[key] ?? initial, panelLimits),
    [widths],
  );
  const setWidth = useCallback((key: "panel" | "inspector", rem: number) => {
    setWidths((current) => {
      const next = {
        ...current,
        [key]: clampWidth(rem, key === "inspector" ? inspectorLimits : panelLimits),
      };
      storeWidths(next);
      return next;
    });
  }, []);
  return { widthOf, setWidth, loaded };
}

const pixelsPerRem = (): number =>
  Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

const wideQuery = "(min-width: 1024px)";
const subscribeWide = (notify: () => void) => {
  const list = window.matchMedia(wideQuery);
  list.addEventListener("change", notify);
  return () => list.removeEventListener("change", notify);
};
const readWide = () => window.matchMedia(wideQuery).matches;
// The server and the first client render use the narrow layout; a wide window switches after hydration.
const readWideOnServer = () => false;
const subscribeViewport = (notify: () => void) => {
  window.addEventListener("resize", notify);
  return () => window.removeEventListener("resize", notify);
};
const readViewport = () => window.innerWidth;
const readViewportOnServer = () => 0;

/**
 * Attaches a pane's persistent host element to whichever slot is currently on screen. The pane's
 * React content is portalled into the host once, so moving it between the side-by-side layout and
 * a sheet changes where it is drawn without remounting the editors inside it (what is typed in
 * them stays).
 */
function PaneSlot({ host }: Readonly<{ host: HTMLDivElement | null }>) {
  const attach = useCallback(
    (slot: HTMLDivElement | null) => {
      // The slot holds exactly the current host: one a re-run effect replaced does not stay behind it.
      if (slot !== null && host !== null) slot.replaceChildren(host);
    },
    [host],
  );
  return <div ref={attach} className="contents" />;
}

type PaneHosts = Readonly<{ panel: HTMLDivElement; inspector: HTMLDivElement }>;

/** The vertical icon rail: one tab per Studio area; the arrow keys, Home and End move between them. */
function StudioRailView<Key extends string>({
  tabs,
  active,
  panelShown,
  modal,
  onChoose,
  label,
  collapsed,
  controls,
  onToggleCollapsed,
}: Readonly<{
  tabs: readonly StudioRailTab<Key>[];
  active: Key;
  /** Whether the active tab's panel is on screen (docked, as the hover overlay, or as a sheet). */
  panelShown: boolean | undefined;
  /** The panel opens as a modal sheet (a narrow window). */
  modal: boolean;
  onChoose: (key: Key) => void;
  label: string;
  collapsed: boolean;
  /** The id of the element the toggle shows or hides. */
  controls: string | undefined;
  /** Collapses or expands the panel beside the rail; absent where the panel is a sheet. */
  onToggleCollapsed: (() => void) | undefined;
}>) {
  return (
    // The rail is as wide as its longest label in the active style's trigger padding, at least 72 px.
    <nav
      aria-label="Studio"
      className={cn(
        "flex w-fit min-w-18 shrink-0 flex-col items-center gap-1 overflow-y-auto",
        "border-r border-sidebar-border bg-sidebar px-1 py-2 text-sidebar-foreground",
      )}
    >
      {onToggleCollapsed !== undefined && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                id="studio-panel-toggle"
                aria-label="Side panel"
                aria-expanded={!collapsed}
                aria-controls={controls}
                onClick={onToggleCollapsed}
                className="mb-1 shrink-0 text-muted-foreground"
              />
            }
          >
            <Icon name="panel-left" className="size-5" />
          </TooltipTrigger>
          <TooltipContent>
            {collapsed ? "Expand panel" : "Collapse panel"} <Kbd>Ctrl B</Kbd>
          </TooltipContent>
        </Tooltip>
      )}
      <TabsList aria-label={label} variant="line" className="min-h-0 w-full flex-1 justify-start">
        {tabs.map((tab, index) => (
          <RailTab
            key={tab.key}
            tab={tab}
            divided={index > 0 && tabs[index - 1]?.group !== tab.group}
            expanded={tab.key === active ? panelShown : undefined}
            modal={modal}
            onChoose={onChoose}
          />
        ))}
      </TabsList>
    </nav>
  );
}

/** The rail draws again only when its own props change, not with every keystroke in the draft. */
const StudioRail = memo(StudioRailView) as typeof StudioRailView;

/**
 * One rail tab. Choosing the tab that is already active still reveals its panel (a collapsed or
 * narrow layout hides it), so the choice runs on every click rather than on a change of value.
 */
function RailTab<Key extends string>({
  tab,
  divided,
  expanded,
  modal,
  onChoose,
}: Readonly<{
  tab: StudioRailTab<Key>;
  divided: boolean;
  /** Whether this tab's panel is shown; absent on the tabs that are not active. */
  expanded: boolean | undefined;
  modal: boolean;
  onChoose: (key: Key) => void;
}>) {
  return (
    <>
      {divided && (
        <Separator
          aria-hidden
          role="none"
          className={cn("my-2", tab.group === "releases" && "mt-auto")}
        />
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <TabsTrigger
              value={tab.key}
              id={`studio-rail-${tab.key}`}
              aria-expanded={expanded}
              aria-haspopup={modal ? "dialog" : undefined}
              onClick={() => onChoose(tab.key)}
              className={cn(
                "h-16 w-full flex-none flex-col justify-center gap-1 text-xs",
                "group-data-vertical/tabs:justify-center",
                // The sidebar's own tokens in both schemes (the trigger's dark classes would
                // otherwise keep muted text); the chosen tab stands on the sidebar accent.
                "text-sidebar-foreground dark:text-sidebar-foreground",
                "hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                "dark:hover:text-sidebar-accent-foreground",
                "data-active:text-sidebar-accent-foreground",
                "dark:data-active:text-sidebar-accent-foreground",
                "group-data-[variant=line]/tabs-list:data-active:bg-sidebar-accent",
                "dark:group-data-[variant=line]/tabs-list:data-active:bg-sidebar-accent",
              )}
            />
          }
        >
          <Icon name={tab.icon} className="size-5" />
          <span className="max-w-full truncate">{tab.label}</span>
        </TooltipTrigger>
        <TooltipContent side="inline-end">{tab.label}</TooltipContent>
      </Tooltip>
    </>
  );
}

/**
 * A select, menu or combobox opened from the panel portals its popup to the style root, outside the
 * rail: while it is open (its trigger says `aria-haspopup` and `aria-expanded`) the panel still owns the focus.
 */
const panelPopupOpen = (): boolean =>
  document.querySelector('[data-studio-rail-panel] [aria-haspopup][aria-expanded="true"]') !== null;

/** Whether an event target is in the rail or in its panel (a portal whose host sits inside the rail). */
const inRailOrPanel = (rail: HTMLElement | null, target: EventTarget | null): boolean =>
  rail !== null && target instanceof Node && rail.contains(target);

/**
 * Who answers Studio's keyboard shortcuts pressed on a target. A dialog, alert dialog, menu or list
 * popup owns its keys (`"popup"`), except the inspector's Sheet below the docking width
 * (`"inspector"`): the header's Undo and Redo sit behind its backdrop, so Undo, Redo and the
 * inspector key still work there. A key the canvas passes on is dispatched on the window, not on an
 * element: it is Studio's (`"studio"`).
 */
export const studioKeyLayer = (target: EventTarget | null): "studio" | "inspector" | "popup" => {
  const layer =
    target instanceof Element
      ? target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')
      : null;
  if (layer === null) return "studio";
  return layer.hasAttribute("data-studio-inspector-sheet") ? "inspector" : "popup";
};

/**
 * A resizable side panel that opens at the width it keeps. The width is applied on mount and again
 * when `sizeKey` changes (another rail tab, or the stored widths arriving), never when the window
 * resizes: the panel keeps its pixel width and the canvas takes the difference.
 */
function SidePanel({
  panelRef,
  sizeKey,
  size,
  limits,
  children,
  ...props
}: Readonly<{
  id: string;
  panelRef: ReturnType<typeof usePanelRef>;
  sizeKey: string;
  /** The width in rem. */
  size: number;
  limits: Readonly<{ minimum: number; maximum: number }>;
  children: ReactNode;
}>) {
  const [initial] = useState(size);
  const latest = useRef(size);
  latest.current = size;
  const applied = useRef(sizeKey);
  useEffect(() => {
    if (applied.current === sizeKey) return;
    applied.current = sizeKey;
    panelRef.current?.resize(`${latest.current}rem`);
  }, [sizeKey, panelRef]);
  return (
    <ResizablePanel
      {...props}
      panelRef={panelRef}
      defaultSize={`${initial}rem`}
      minSize={`${limits.minimum}rem`}
      maxSize={`${limits.maximum}rem`}
      groupResizeBehavior="preserve-pixel-size"
    >
      {children}
    </ResizablePanel>
  );
}

export function StudioFrame<Key extends string>({
  applicationName,
  topBar,
  tabs,
  activeTab,
  onTabChange,
  panel,
  canvas,
  inspector,
  selectionKey,
  inspectorEditsSelection,
  inspectorLabel = "Inspector",
}: Readonly<{
  /** Names the page's one level-1 heading with the open tab. */
  applicationName: string;
  topBar: ReactNode;
  tabs: readonly StudioRailTab<Key>[];
  activeTab: Key;
  /** Switches the rail tab. */
  onTabChange: (key: Key) => void;
  /** Every tab's panel content; the caller shows the active one, so the others keep their state. */
  panel: ReactNode;
  canvas: (
    controls: Readonly<{
      inspectorOpen: boolean;
      toggleInspector: (() => void) | undefined;
      focused: boolean;
      focusCanvas: () => void;
    }>,
  ) => ReactNode;
  inspector: ReactNode;
  selectionKey: string;
  /**
   * Whether the inspector holds settings of the selection. A window too narrow to dock the
   * inspector opens its sheet for a new selection only then, never for one it only points away from.
   */
  inspectorEditsSelection: boolean;
  inspectorLabel?: string;
}>) {
  // A block is being dragged, from the palette or on the canvas: a collapsed panel's overlay gets
  // out of its way until the drop. Puck's own state says so.
  const dragging = useStudioCanvasDragging();
  const wide = useSyncExternalStore(subscribeWide, readWide, readWideOnServer);
  const hasPanel = tabs.find((tab) => tab.key === activeTab)?.panel !== false;
  const viewport = useSyncExternalStore(subscribeViewport, readViewport, readViewportOnServer);
  const dockInspector = viewport >= 1280;
  const { widthOf, setWidth, loaded } = useStudioPanelWidths();
  // The docked panel's and the hover overlay's content is portalled into these hosts, so the rail's
  // vertical Tabs root is not a DOM ancestor of anything a panel, the canvas or the inspector draws
  // (a nested horizontal Tabs would otherwise pick up the vertical rules) while the tab and its
  // panel still register through React context.
  const [dockHost, setDockHost] = useState<HTMLElement | null>(null);
  const [overlayHost, setOverlayHost] = useState<HTMLDivElement | null>(null);
  // Which handle the pointer is on: a drag stores only that panel's width.
  const movedHandle = useRef<"panel" | "inspector">("panel");
  const panelRef = usePanelRef();
  const inspectorRef = usePanelRef();
  const [panelOpen, setPanelOpen] = useHeldWorkspace("panelOpen", true);
  // Collapsed: the panel is closed until the pointer visits the rail, and then it overlays the canvas.
  // `null` until the stored choice is read, so a reload never shows the panel and then folds it away.
  const storedCollapsed = useSyncExternalStore<boolean | null>(
    subscribeCollapsed,
    readCollapsed,
    readCollapsedOnServer,
  );
  const collapsed = storedCollapsed === true;
  const [peeking, setPeeking] = useState(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointerInside = useRef(false);
  const rail = useRef<HTMLDivElement>(null);
  // Opening waits a moment, so passing over the rail does not pop the panel; closing waits longer.
  const peek = useCallback((open: boolean, immediately = false) => {
    clearTimeout(peekTimer.current);
    if (open && immediately) setPeeking(true);
    else peekTimer.current = setTimeout(() => setPeeking(open), open ? 150 : 300);
  }, []);
  useEffect(() => () => clearTimeout(peekTimer.current), []);
  const toggleCollapsed = useCallback(() => {
    if (!wide || !hasPanel) return;
    const inPanel = document.activeElement?.closest("[data-studio-rail-panel]") != null;
    storeCollapsed(!collapsed);
    clearTimeout(peekTimer.current);
    setPeeking(false);
    // The panel leaves the page with the focus inside it: the toggle keeps it.
    if (inPanel) document.getElementById("studio-panel-toggle")?.focus();
  }, [wide, hasPanel, collapsed]);
  // The drag ended: the overlay closes after the drop.
  const wasDragging = useRef(false);
  useEffect(() => {
    if (wasDragging.current && !dragging) setPeeking(false);
    wasDragging.current = dragging;
  }, [dragging]);
  const [inspectorOpen, setInspectorOpen] = useHeldWorkspace("inspectorOpen", true);
  const [narrowPanelOpen, setNarrowPanelOpen] = useState(false);
  const [narrowInspectorOpen, setNarrowInspectorOpen] = useState(false);
  const [focused, setFocused] = useHeldWorkspace("focused", false);
  const hasInspector = inspector !== null;
  const [beforeFocus, setBeforeFocus] = useHeldWorkspace("beforeFocus", panelsBeforeFocus);
  const focusCanvas = useCallback(() => {
    if (!focused) {
      setBeforeFocus({ panel: panelOpen, inspector: inspectorOpen });
      setPanelOpen(false);
      setInspectorOpen(false);
      setNarrowPanelOpen(false);
      setNarrowInspectorOpen(false);
    } else {
      setPanelOpen(beforeFocus.panel);
      setInspectorOpen(beforeFocus.inspector);
    }
    setFocused(!focused);
  }, [focused, panelOpen, inspectorOpen]);
  const toggleInspector = useCallback(() => {
    if (!hasInspector) return;
    setFocused(false);
    if (dockInspector) setInspectorOpen((open) => !open);
    else setNarrowInspectorOpen((open) => !open);
  }, [dockInspector, hasInspector]);
  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey) return;
      const layer = studioKeyLayer(event.target);
      if (event.key === "." && layer !== "popup") {
        event.preventDefault();
        toggleInspector();
      }
      if (event.key === "\\" && layer === "studio") {
        event.preventDefault();
        focusCanvas();
      }
      if (event.key === "b" && layer === "studio" && wide && hasPanel) {
        event.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [focusCanvas, toggleInspector, toggleCollapsed, wide, hasPanel]);
  const previousSelection = useRef(selectionKey);
  const [hosts, setHosts] = useState<PaneHosts | null>(null);
  // The hosts are made once per frame: effects run again when a suspended part of Studio shows again,
  // and a new host would remount every panel and lose what is typed in it.
  const madeHosts = useRef<PaneHosts | null>(null);
  useEffect(() => {
    const create = () => {
      const host = document.createElement("div");
      host.className = "flex h-full min-h-0 min-w-0 flex-col";
      return host;
    };
    madeHosts.current ??= { panel: create(), inspector: create() };
    setHosts(madeHosts.current);
  }, []);
  useEffect(() => {
    if (
      hasInspector &&
      inspectorEditsSelection &&
      previousSelection.current !== selectionKey &&
      !dockInspector &&
      !focused
    ) {
      // The sheets do not stack: the inspector takes the place of an open panel.
      setNarrowPanelOpen(false);
      setNarrowInspectorOpen(true);
    }
    // A new selection keeps the window and canvas where they are but starts its inspector at the
    // top: the body may have been scrolled past the shorter content the new selection draws.
    const inspectorBody = hosts?.inspector.querySelector<HTMLElement>("[data-studio-rail-body]");
    if (inspectorBody !== null && inspectorBody !== undefined) inspectorBody.scrollTop = 0;
    previousSelection.current = selectionKey;
  }, [selectionKey, inspectorEditsSelection, dockInspector, focused, hasInspector, hosts]);
  const active = tabs.find((tab) => tab.key === activeTab);
  // One panel width for every rail tab, so the canvas does not move or resize when the tab changes.
  const width = widthOf("panel", viewport < 1440 ? 16 : viewport >= 1920 ? 18 : 17);
  const inspectorWidth = widthOf("inspector", viewport >= 1920 ? 24 : viewport >= 1440 ? 22 : 20);
  // The default width follows the window's size class; a stored width does not.
  const sizeClass = viewport < 1440 ? "compact" : viewport >= 1920 ? "large" : "regular";
  const showPanel = hasPanel && wide && panelOpen && storedCollapsed === false;
  const overlayPanel = hasPanel && wide && panelOpen && collapsed && (peeking || dragging);
  const showInspector = hasInspector && dockInspector && inspectorOpen;
  const panelShown = hasPanel
    ? wide
      ? panelOpen && (!collapsed || overlayPanel)
      : narrowPanelOpen
    : undefined;
  // Only a drag is the person's choice, and only of the panel at the handle that moved; a tab switch
  // or a window resize is not stored.
  const layoutChanged: NonNullable<ComponentProps<typeof ResizablePanelGroup>["onLayoutChanged"]> =
    useCallback(
      (_layout, meta) => {
        if (!meta.isUserInteraction) return;
        const inspectorMoved = movedHandle.current === "inspector";
        const size = (inspectorMoved ? inspectorRef : panelRef).current?.getSize().inPixels;
        if (size !== undefined)
          setWidth(inspectorMoved ? "inspector" : "panel", size / pixelsPerRem());
      },
      [setWidth, panelRef, inspectorRef],
    );
  // Arrow keys on a handle move its panel by half a rem (two with Shift); Home and End take it to its
  // smallest and largest width.
  const resizeByKey =
    (which: "panel" | "inspector") => (event: ReactKeyboardEvent<HTMLElement>) => {
      const inspectorHandle = which === "inspector";
      const ref = inspectorHandle ? inspectorRef : panelRef;
      const limits = inspectorHandle ? inspectorLimits : panelLimits;
      const current = ref.current?.getSize().inPixels;
      if (current === undefined) return;
      // On the inspector's left edge, moving the handle left widens the inspector.
      const direction = inspectorHandle ? -1 : 1;
      const step = event.shiftKey ? 2 : 0.5;
      const rem = current / pixelsPerRem();
      const next =
        event.key === "ArrowRight"
          ? rem + direction * step
          : event.key === "ArrowLeft"
            ? rem - direction * step
            : event.key === "Home"
              ? limits.minimum
              : event.key === "End"
                ? limits.maximum
                : undefined;
      if (next === undefined) return;
      // Captured before the library's own key handling on the handle sees the event.
      event.preventDefault();
      event.stopPropagation();
      const clamped = clampWidth(next, limits);
      ref.current?.resize(`${clamped}rem`);
      setWidth(inspectorHandle ? "inspector" : "panel", clamped);
    };
  const choose = useStable((key: Key) => {
    setFocused(false);
    // Selecting a tab always reveals its pane, including the tab restored from the URL on reload.
    onTabChange(key);
    // A tab without a panel opens its centre alone: nothing peeks and no sheet opens.
    const panelled = tabs.find((tab) => tab.key === key)?.panel !== false;
    if (wide) {
      setPanelOpen(true);
      if (collapsed && panelled) peek(true, true);
    } else setNarrowPanelOpen(panelled);
  });
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
      // The panel's content is a portal: its events reach this element through React, not the rail's
      // wrapper, so the overlay's keyboard path lives here and asks where the event came from.
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || !collapsed || !overlayPanel) return;
        if (!inRailOrPanel(rail.current, event.target)) return;
        // An open combobox or menu answers its own Escape.
        if (
          event.target instanceof Element &&
          event.target.matches(
            '[aria-haspopup][aria-expanded="true"], [role="combobox"][aria-expanded="true"]',
          )
        )
          return;
        event.stopPropagation();
        clearTimeout(peekTimer.current);
        setPeeking(false);
        document.getElementById(`studio-rail-${activeTab}`)?.focus();
      }}
      onBlur={(event) => {
        // Keyboard use: focus leaving the rail and its panel closes the overlay.
        if (
          !collapsed ||
          pointerInside.current ||
          !inRailOrPanel(rail.current, event.target) ||
          inRailOrPanel(rail.current, event.relatedTarget) ||
          panelPopupOpen()
        )
          return;
        peek(false);
      }}
    >
      {topBar}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div
          ref={rail}
          className="relative flex min-h-0 shrink-0"
          onPointerEnter={() => {
            pointerInside.current = true;
            if (collapsed && wide && hasPanel) peek(true);
          }}
          onPointerLeave={() => {
            pointerInside.current = false;
            if (collapsed) peek(false);
          }}
        >
          <Tabs orientation="vertical" value={activeTab} className="min-h-0 flex-row gap-0">
            <StudioRail
              tabs={tabs}
              active={activeTab}
              panelShown={panelShown}
              modal={!wide}
              onChoose={choose}
              label="Studio areas"
              collapsed={collapsed}
              controls={collapsed ? "studio-panel-overlay" : showPanel ? "studio-panel" : undefined}
              onToggleCollapsed={wide && hasPanel ? toggleCollapsed : undefined}
            />
            {overlayHost !== null &&
              createPortal(
                <TabsContent
                  value={activeTab}
                  data-studio-rail-panel=""
                  tabIndex={-1}
                  className="flex h-full text-base min-h-0 flex-col"
                >
                  <PaneSlot host={hosts?.panel ?? null} />
                </TabsContent>,
                overlayHost,
              )}
            {dockHost !== null &&
              createPortal(
                <TabsContent
                  value={activeTab}
                  data-studio-rail-panel=""
                  tabIndex={-1}
                  className="flex h-full text-base min-h-0 flex-col bg-sidebar"
                >
                  <PaneSlot host={hosts?.panel ?? null} />
                </TabsContent>,
                dockHost,
              )}
            <Sheet open={!wide && hasPanel && narrowPanelOpen} onOpenChange={setNarrowPanelOpen}>
              <SheetContent side="left" className="w-80 max-w-full overflow-y-auto">
                <SheetHeader className="sr-only">
                  <SheetTitle>{active?.label}</SheetTitle>
                  <SheetDescription>The {active?.label} panel.</SheetDescription>
                </SheetHeader>
                <TabsContent
                  value={activeTab}
                  data-studio-rail-panel=""
                  tabIndex={-1}
                  className="flex text-base min-h-0 min-w-0 flex-1 flex-col pt-10"
                >
                  <PaneSlot host={hosts?.panel ?? null} />
                </TabsContent>
              </SheetContent>
            </Sheet>
          </Tabs>
          {collapsed && wide && hasPanel && (
            <div
              ref={setOverlayHost}
              id="studio-panel-overlay"
              role="complementary"
              aria-label={`${active?.label ?? ""} panel`}
              aria-hidden={!overlayPanel}
              data-studio-panel-overlay=""
              className={cn(
                "absolute inset-y-0 left-full z-30 flex min-h-0 flex-col border-r border-border bg-sidebar shadow-lg transition-opacity",
                overlayPanel ? "opacity-100" : "pointer-events-none invisible opacity-0",
                // The drag source stays mounted while it is dragged from; only its look leaves.
                dragging && "pointer-events-none !visible opacity-0",
              )}
              style={{ width: `${width}rem` }}
            />
          )}
        </div>
        {/* The page's one main landmark and its one level-1 heading: the skip link lands here. The panels and
            their resize handles are inside it (a separator outside every landmark is an axe `region`
            violation); the panels are named regions, not asides, which a main may not contain. */}
        <main
          id={APPLICATION_MAIN_CONTENT_ID}
          tabIndex={-1}
          className="flex min-h-0 min-w-0 flex-1 outline-none"
        >
          <ResizablePanelGroup
            orientation="horizontal"
            onLayoutChanged={layoutChanged}
            className="min-h-0 min-w-0 flex-1"
          >
            {showPanel && (
              <>
                <SidePanel
                  id="studio-panel"
                  panelRef={panelRef}
                  sizeKey={`panel:${loaded}:${sizeClass}`}
                  size={width}
                  limits={panelLimits}
                >
                  <section
                    ref={setDockHost}
                    aria-label={`${active?.label ?? ""} panel`}
                    className="h-full min-h-0"
                  />
                </SidePanel>
                <ResizableHandle
                  aria-label={`Resize the ${active?.label ?? ""} panel`}
                  onPointerDownCapture={() => {
                    movedHandle.current = "panel";
                  }}
                  onKeyDownCapture={resizeByKey("panel")}
                />
              </>
            )}
            <ResizablePanel id="studio-canvas" minSize="20rem">
              <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
                <h1 className="sr-only">
                  {applicationName}: {active?.label}
                </h1>
                {canvas({
                  inspectorOpen:
                    hasInspector && (dockInspector ? inspectorOpen : narrowInspectorOpen),
                  toggleInspector: hasInspector ? toggleInspector : undefined,
                  focused,
                  focusCanvas,
                })}
              </div>
            </ResizablePanel>
            {showInspector && (
              <>
                <ResizableHandle
                  aria-label="Resize the inspector"
                  onPointerDownCapture={() => {
                    movedHandle.current = "inspector";
                  }}
                  onKeyDownCapture={resizeByKey("inspector")}
                />
                <SidePanel
                  id="studio-inspector"
                  panelRef={inspectorRef}
                  sizeKey={`inspector:${loaded}:${sizeClass}`}
                  size={inspectorWidth}
                  limits={inspectorLimits}
                >
                  <section
                    aria-label={inspectorLabel}
                    className="flex h-full min-h-0 flex-col bg-sidebar"
                  >
                    <PaneSlot host={hosts?.inspector ?? null} />
                  </section>
                </SidePanel>
              </>
            )}
          </ResizablePanelGroup>
        </main>
      </div>
      <Sheet
        open={hasInspector && !dockInspector && narrowInspectorOpen}
        onOpenChange={setNarrowInspectorOpen}
      >
        <SheetContent
          data-studio-inspector-sheet
          side="right"
          className="w-96 max-w-full overflow-y-auto"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{inspectorLabel}</SheetTitle>
            <SheetDescription>Settings for the selected item.</SheetDescription>
          </SheetHeader>
          <div aria-label={inspectorLabel} className="flex min-h-0 min-w-0 flex-1 flex-col pt-10">
            <PaneSlot host={hosts?.inspector ?? null} />
          </div>
        </SheetContent>
      </Sheet>
      {hosts !== null && createPortal(panel, hosts.panel)}
      {hosts !== null && createPortal(inspector, hosts.inspector)}
    </div>
  );
}

/** Mount a tab's content on its first visit, then keep its local input and selection state. */
export function useStudioTabVisited(visible: boolean): boolean {
  const [visited, setVisited] = useState(visible);
  if (visible && !visited) setVisited(true);
  return visible || visited;
}

/**
 * The chrome every Studio panel is built from: a titled header with an optional action, over scrolling
 * content. A panel whose content draws its own heading (the Outline tab: Puck's) passes no title.
 */
export function StudioPanelShell({
  title,
  description,
  action,
  hidden,
  search,
  children,
}: Readonly<{
  title?: string | undefined;
  description?: string | undefined;
  action?: ReactNode;
  search?: ReactNode;
  /** After its first visit, a panel of another rail tab stays mounted to keep its state. */
  hidden?: boolean | undefined;
  children: ReactNode;
}>) {
  const visited = useStudioTabVisited(hidden !== true);
  if (!visited) return null;
  return (
    <div className={cn("min-h-0 flex-1 flex-col", hidden ? "hidden" : "flex")}>
      {title !== undefined && (
        <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-4 pb-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
            {description !== undefined && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`About ${title.toLowerCase()}`}
                      className="flex size-6 items-center justify-center rounded-md text-muted-foreground"
                    />
                  }
                >
                  <Icon name="info" className="size-4" />
                </TooltipTrigger>
                <TooltipContent>{description}</TooltipContent>
              </Tooltip>
            )}
          </div>
          {action}
        </div>
      )}
      {search !== undefined && <div className="shrink-0 px-4 pb-3">{search}</div>}
      <div className={STUDIO_RAIL_BODY_CLASS} data-studio-rail-body="">
        {children}
      </div>
    </div>
  );
}

/** Sentence-case navigator groups; collapsible sections remember their state on this device. */
export function StudioSection({
  title,
  count,
  action,
  storageKey,
  children,
}: Readonly<{
  title: string;
  count?: number;
  action?: ReactNode;
  storageKey?: string;
  children: ReactNode;
}>) {
  const [closedKeys, setClosedKeys] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (storageKey === undefined) return;
    try {
      if (localStorage.getItem(`vortex:studio:section:${storageKey}`) === "closed")
        setClosedKeys((keys) => new Set([...keys, storageKey]));
    } catch {
      /* Storage can be disabled. */
    }
  }, [storageKey]);
  const open = storageKey === undefined || !closedKeys.has(storageKey);
  const heading = (
    <>
      <span className="min-w-0 truncate">{title}</span>
      {count !== undefined && (
        <Badge variant="secondary" className="tabular-nums">
          {count}
        </Badge>
      )}
    </>
  );
  if (storageKey === undefined)
    return (
      <section aria-label={title} className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-medium">{heading}</h3>
          {action}
        </div>
        {children}
      </section>
    );
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setClosedKeys((keys) => {
          const updated = new Set(keys);
          if (next) updated.delete(storageKey);
          else updated.add(storageKey);
          return updated;
        });
        try {
          localStorage.setItem(`vortex:studio:section:${storageKey}`, next ? "open" : "closed");
        } catch {
          /* Storage can be disabled. */
        }
      }}
      className="space-y-2"
    >
      <div className="flex items-center justify-between gap-2">
        <CollapsibleTrigger className="flex min-h-8 items-center gap-2 rounded-md text-sm font-medium">
          <Icon name={open ? "chevron-down" : "chevron-right"} className="size-4" />
          {heading}
        </CollapsibleTrigger>
        {action}
      </div>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** A panel's search field with a clear button. */
export function StudioSearchBox({
  value,
  onChange,
  placeholder,
  label,
}: Readonly<{
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}>) {
  return (
    <InputGroup>
      <InputGroupInput
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
      />
      <InputGroupAddon>
        <Icon name="search" />
      </InputGroupAddon>
      {value.length === 0 ? null : (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label={`Clear ${label.toLowerCase()}`}
            onClick={() => onChange("")}
          >
            <Icon name="close" />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}
