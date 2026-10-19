"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
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
import { Icon, type VortexIconName } from "@vortex/ui";
import { Badge } from "@vortex/ui/components/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@vortex/ui/components/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vortex/ui/components/tooltip";
import { Separator } from "@vortex/ui/components/separator";
import { cn } from "@vortex/ui/lib/utils";

/**
 * Studio's own frame: a top bar over an icon rail, the rail tab's panel, the canvas and the
 * inspector. The frame is platform chrome, so it uses the platform theme's tokens only; the
 * application's own theme belongs to whatever the canvas draws.
 */

export type StudioRailTab<Key extends string> = Readonly<{
  key: Key;
  label: string;
  icon: VortexIconName;
  /** The width (in rem) the tab's panel opens at until the person resizes it. */
  width: number;
  group: "build" | "logic" | "look" | "releases";
}>;

const minimumPanelWidth = 15;
const maximumPanelWidth = 32;
const clampWidth = (
  rem: number,
  minimum = minimumPanelWidth,
  maximum = maximumPanelWidth,
): number => Math.min(maximum, Math.max(minimum, Math.round(rem * 4) / 4));

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
const storeWidths = (widths: Readonly<Record<string, number>>): void => {
  try {
    window.localStorage.setItem(widthStorageKey, JSON.stringify(widths));
  } catch {
    // The width is a convenience; without storage it lasts for this visit only.
  }
};

/**
 * Each rail tab asks for the width it needs (a theme gallery is wider than a page tree) and keeps
 * the width the person drags it to, per tab, in this browser.
 */
function useStudioPanelWidths<Key extends string>() {
  const [widths, setWidths] = useState<Record<string, number>>({});
  useEffect(() => {
    setWidths(readStoredWidths());
  }, []);
  const widthOf = useCallback(
    (key: Key | "inspector", initial: number): number =>
      key === "inspector"
        ? clampWidth(widths[key] ?? initial, 18, 30)
        : clampWidth(widths[key] ?? initial),
    [widths],
  );
  const setWidth = useCallback((key: Key | "inspector", rem: number) => {
    setWidths((current) => {
      const next = {
        ...current,
        [key]: key === "inspector" ? clampWidth(rem, 18, 30) : clampWidth(rem),
      };
      storeWidths(next);
      return next;
    });
  }, []);
  return { widthOf, setWidth };
}

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

/** The vertical icon rail: one tab per Studio area, operated with the arrow keys, Home and End. */
function StudioRail<Key extends string>({
  tabs,
  active,
  open,
  onChoose,
  label,
}: Readonly<{
  tabs: readonly StudioRailTab<Key>[];
  active: Key;
  open: boolean;
  onChoose: (key: Key) => void;
  label: string;
}>) {
  const buttons = useRef(new Map<Key, HTMLButtonElement>());
  const [focusKey, setFocusKey] = useState<Key>(active);
  useEffect(() => {
    setFocusKey(active);
  }, [active]);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.key === focusKey);
    const target =
      event.key === "ArrowDown"
        ? (index + 1) % tabs.length
        : event.key === "ArrowUp"
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    const next = tabs[target]!.key;
    setFocusKey(next);
    buttons.current.get(next)?.focus();
  };
  return (
    <div
      role="tablist"
      aria-orientation="vertical"
      aria-label={label}
      onKeyDown={move}
      className="flex w-18 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-sidebar-border bg-sidebar px-1 py-2 text-sidebar-foreground"
    >
      {tabs.map((tab, index) => {
        const selected = tab.key === active;
        const divided = index > 0 && tabs[index - 1]?.group !== tab.group;
        return (
          <div key={tab.key} className={cn("w-full", tab.group === "releases" && "mt-auto")}>
            {divided && <Separator className="my-2" />}
            <button
              key={tab.key}
              type="button"
              role="tab"
              id={`studio-rail-${tab.key}`}
              aria-selected={selected}
              aria-controls="studio-rail-panel"
              aria-expanded={selected ? open : undefined}
              tabIndex={tab.key === focusKey ? 0 : -1}
              title={tab.label}
              ref={(node) => {
                if (node === null) buttons.current.delete(tab.key);
                else buttons.current.set(tab.key, node);
              }}
              onFocus={() => setFocusKey(tab.key)}
              onClick={() => onChoose(tab.key)}
              className={cn(
                "relative flex h-13 w-full flex-col items-center justify-center gap-1 rounded-lg border-0 px-1 py-0 text-xs font-medium outline-none transition-colors",
                "hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "bg-sidebar-accent text-sidebar-accent-foreground before:absolute before:inset-y-3 before:-left-1 before:w-0.75 before:rounded-full before:bg-primary"
                  : "bg-transparent text-muted-foreground",
              )}
            >
              <Icon name={tab.icon} className="size-5" />
              <span className="max-w-full truncate">{tab.label}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The drag handle between the panel and the canvas; arrow keys resize it a quarter rem at a time. */
function PanelResizer({
  width,
  onResize,
  label,
  inspector = false,
}: Readonly<{
  width: number;
  onResize: (rem: number) => void;
  label: string;
  inspector?: boolean;
}>) {
  const drag = useRef<{ startX: number; startWidth: number; pixelsPerRem: number } | null>(null);
  const start = (event: PointerEvent<HTMLDivElement>) => {
    const pixelsPerRem =
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    event.preventDefault();
    drag.current = { startX: event.clientX, startWidth: width, pixelsPerRem };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveTo = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null) return;
    onResize(
      current.startWidth +
        ((inspector ? -1 : 1) * (event.clientX - current.startX)) / current.pixelsPerRem,
    );
  };
  const end = () => {
    drag.current = null;
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 2 : 0.5;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onResize(width + (inspector ? step : -step));
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      onResize(width + (inspector ? -step : step));
    }
    if (event.key === "Home") {
      event.preventDefault();
      onResize(inspector ? 18 : minimumPanelWidth);
    }
    if (event.key === "End") {
      event.preventDefault();
      onResize(inspector ? 30 : maximumPanelWidth);
    }
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      aria-valuemin={inspector ? 18 : minimumPanelWidth}
      aria-valuemax={inspector ? 30 : maximumPanelWidth}
      aria-valuenow={width}
      onPointerDown={start}
      onPointerMove={moveTo}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={key}
      className="relative z-10 w-px shrink-0 cursor-col-resize touch-none select-none bg-border outline-none transition-colors before:absolute before:inset-y-0 before:-left-1 before:w-2 hover:bg-primary focus-visible:bg-primary"
    />
  );
}

export function StudioFrame<Key extends string>({
  topBar,
  tabs,
  activeTab,
  onTabChange,
  panel,
  canvas,
  inspector,
  selectionKey,
  inspectorLabel = "Inspector",
}: Readonly<{
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
  inspectorLabel?: string;
}>) {
  const wide = useSyncExternalStore(subscribeWide, readWide, readWideOnServer);
  const viewport = useSyncExternalStore(subscribeViewport, readViewport, readViewportOnServer);
  const dockInspector = viewport >= 1280;
  const { widthOf, setWidth } = useStudioPanelWidths<Key>();
  const [panelOpen, setPanelOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [narrowPanelOpen, setNarrowPanelOpen] = useState(false);
  const [narrowInspectorOpen, setNarrowInspectorOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const hasInspector = inspector !== null;
  const beforeFocus = useRef({ panel: true, inspector: true });
  const focusCanvas = useCallback(() => {
    if (!focused) {
      beforeFocus.current = { panel: panelOpen, inspector: inspectorOpen };
      setPanelOpen(false);
      setInspectorOpen(false);
      setNarrowPanelOpen(false);
      setNarrowInspectorOpen(false);
    } else {
      setPanelOpen(beforeFocus.current.panel);
      setInspectorOpen(beforeFocus.current.inspector);
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
      if (
        event.target instanceof Element &&
        event.target.closest('[role="dialog"], [role="alertdialog"]')
      )
        return;
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key === ".") {
        event.preventDefault();
        toggleInspector();
      }
      if (event.key === "\\") {
        event.preventDefault();
        focusCanvas();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [focusCanvas, toggleInspector]);
  const previousSelection = useRef(selectionKey);
  useEffect(() => {
    if (
      hasInspector &&
      previousSelection.current !== selectionKey &&
      wide &&
      !dockInspector &&
      !focused
    )
      setNarrowInspectorOpen(true);
    previousSelection.current = selectionKey;
  }, [selectionKey, wide, dockInspector, focused, hasInspector]);
  const [hosts, setHosts] = useState<PaneHosts | null>(null);
  // The hosts are made once per frame: effects run again when a suspended part of Studio shows again,
  // and a new host would remount every panel and lose what is typed in it.
  const madeHosts = useRef<PaneHosts | null>(null);
  useEffect(() => {
    const create = () => {
      const host = document.createElement("div");
      host.className = "flex h-full min-h-0 flex-col";
      return host;
    };
    madeHosts.current ??= { panel: create(), inspector: create() };
    setHosts(madeHosts.current);
  }, []);
  const choose = (key: Key) => {
    setFocused(false);
    if (key === activeTab) {
      if (wide) setPanelOpen((open) => !open);
      else setNarrowPanelOpen((open) => !open);
      return;
    }
    onTabChange(key);
    if (wide) setPanelOpen(true);
    else setNarrowPanelOpen(true);
  };
  const active = tabs.find((tab) => tab.key === activeTab);
  const defaultWidth =
    viewport < 1440
      ? Math.min(active?.width ?? 17, 16)
      : viewport >= 1920
        ? Math.max(active?.width ?? 17, 18)
        : (active?.width ?? 17);
  const width = widthOf(activeTab, defaultWidth);
  const inspectorWidth = widthOf("inspector", viewport >= 1920 ? 24 : viewport >= 1440 ? 22 : 20);
  const showPanel = wide && panelOpen;
  const showInspector = hasInspector && dockInspector && inspectorOpen;
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {topBar}
      <div className="flex min-h-0 flex-1">
        <StudioRail
          tabs={tabs}
          active={activeTab}
          open={wide ? panelOpen : narrowPanelOpen}
          onChoose={choose}
          label="Studio areas"
        />
        {showPanel && (
          <>
            <section
              id="studio-rail-panel"
              role="tabpanel"
              aria-labelledby={`studio-rail-${activeTab}`}
              className="flex min-h-0 shrink-0 flex-col bg-sidebar"
              style={{ width: `${width}rem` }}
            >
              <PaneSlot host={hosts?.panel ?? null} />
            </section>
            <PanelResizer
              width={width}
              onResize={(rem) => setWidth(activeTab, rem)}
              label={`Resize the ${active?.label ?? ""} panel`}
            />
          </>
        )}
        <section aria-label="Canvas" className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          {canvas({
            inspectorOpen: hasInspector && (dockInspector ? inspectorOpen : narrowInspectorOpen),
            toggleInspector: hasInspector ? toggleInspector : undefined,
            focused,
            focusCanvas,
          })}
        </section>
        {showInspector && (
          <>
            <PanelResizer
              inspector
              width={inspectorWidth}
              onResize={(rem) => setWidth("inspector", rem)}
              label="Resize the inspector"
            />
            <aside
              aria-label={inspectorLabel}
              style={{ width: `${inspectorWidth}rem` }}
              className="flex min-h-0 shrink-0 flex-col bg-sidebar"
            >
              <PaneSlot host={hosts?.inspector ?? null} />
            </aside>
          </>
        )}
      </div>
      <Sheet open={!wide && narrowPanelOpen} onOpenChange={setNarrowPanelOpen}>
        <SheetContent side="left" className="w-80 max-w-full p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>{active?.label}</SheetTitle>
            <SheetDescription>The {active?.label} panel.</SheetDescription>
          </SheetHeader>
          <div id="studio-rail-panel" role="tabpanel" className="flex h-full min-h-0 flex-col">
            <PaneSlot host={hosts?.panel ?? null} />
          </div>
        </SheetContent>
      </Sheet>
      <Sheet
        open={hasInspector && !dockInspector && narrowInspectorOpen}
        onOpenChange={setNarrowInspectorOpen}
      >
        <SheetContent side="right" className="w-96 max-w-full p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>{inspectorLabel}</SheetTitle>
            <SheetDescription>Settings for the selected item.</SheetDescription>
          </SheetHeader>
          <div aria-label={inspectorLabel} className="flex h-full min-h-0 flex-col">
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

/** The chrome every Studio panel is built from: a titled header with an optional action, over scrolling content. */
export function StudioPanelShell({
  title,
  description,
  action,
  hidden,
  search,
  children,
}: Readonly<{
  title: string;
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
    <div hidden={hidden} className={cn("min-h-0 flex-1 flex-col", hidden ? "hidden" : "flex")}>
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
                    className="flex size-6 items-center justify-center text-muted-foreground"
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
      {search !== undefined && <div className="shrink-0 px-4 pb-3">{search}</div>}
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-3">{children}</div>
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
        <CollapsibleTrigger className="flex min-h-8 items-center gap-2 rounded-md text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
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
