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
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@vortex/ui/components/sheet";
import { Icon, type VortexIconName } from "@vortex/ui";
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
}>;

const minimumPanelWidth = 14;
const maximumPanelWidth = 40;
const clampWidth = (rem: number): number =>
  Math.min(maximumPanelWidth, Math.max(minimumPanelWidth, Math.round(rem * 4) / 4));

const widthStorageKey = "vortex.studio.panel-widths";
const readStoredWidths = (): Record<string, number> => {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(widthStorageKey) ?? "{}");
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1])),
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
export function useStudioPanelWidths<Key extends string>(tabs: readonly StudioRailTab<Key>[]) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  useEffect(() => { setWidths(readStoredWidths()); }, []);
  const widthOf = useCallback((key: Key): number =>
    clampWidth(widths[key] ?? tabs.find((tab) => tab.key === key)?.width ?? minimumPanelWidth), [widths, tabs]);
  const setWidth = useCallback((key: Key, rem: number) => {
    setWidths((current) => {
      const next = { ...current, [key]: clampWidth(rem) };
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

/**
 * Attaches a pane's persistent host element to whichever slot is currently on screen. The pane's
 * React content is portalled into the host once, so moving it between the side-by-side layout and
 * a sheet changes where it is drawn without remounting the editors inside it (their unapplied
 * input and pending flags stay consistent).
 */
function PaneSlot({ host }: Readonly<{ host: HTMLDivElement | null }>) {
  const attach = useCallback((slot: HTMLDivElement | null) => {
    if (slot !== null && host !== null) slot.appendChild(host);
  }, [host]);
  return <div ref={attach} className="contents" />;
}

type PaneHosts = Readonly<{ panel: HTMLDivElement; inspector: HTMLDivElement }>;

/** The vertical icon rail: one tab per Studio area, operated with the arrow keys, Home and End. */
function StudioRail<Key extends string>({ tabs, active, open, onChoose, label }: Readonly<{
  tabs: readonly StudioRailTab<Key>[];
  active: Key;
  open: boolean;
  onChoose: (key: Key) => void;
  label: string;
}>) {
  const buttons = useRef(new Map<Key, HTMLButtonElement>());
  const [focusKey, setFocusKey] = useState<Key>(active);
  useEffect(() => { setFocusKey(active); }, [active]);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.key === focusKey);
    const target = event.key === "ArrowDown" ? (index + 1) % tabs.length
      : event.key === "ArrowUp" ? (index - 1 + tabs.length) % tabs.length
        : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined;
    if (target === undefined) return;
    event.preventDefault();
    const next = tabs[target]!.key;
    setFocusKey(next);
    buttons.current.get(next)?.focus();
  };
  return (
    <div role="tablist" aria-orientation="vertical" aria-label={label} onKeyDown={move}
      className="flex shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-sidebar-border bg-sidebar px-1 py-2 text-sidebar-foreground">
      {tabs.map((tab) => {
        const selected = tab.key === active;
        return (
          <button key={tab.key} type="button" role="tab" id={`studio-rail-${tab.key}`}
            aria-selected={selected} aria-controls="studio-rail-panel" aria-expanded={selected ? open : undefined}
            tabIndex={tab.key === focusKey ? 0 : -1} title={tab.label}
            ref={(node) => { if (node === null) buttons.current.delete(tab.key); else buttons.current.set(tab.key, node); }}
            onFocus={() => setFocusKey(tab.key)}
            onClick={() => onChoose(tab.key)}
            className={cn(
              "flex w-full flex-col items-center gap-1 rounded-md border-0 px-1 py-2 text-xs outline-none transition-colors",
              "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
              selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "bg-transparent",
            )}>
            <Icon name={tab.icon} className="size-5" />
            <span className="max-w-full truncate">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The drag handle between the panel and the canvas; arrow keys resize it a quarter rem at a time. */
function PanelResizer({ width, onResize, label }: Readonly<{ width: number; onResize: (rem: number) => void; label: string }>) {
  const drag = useRef<{ startX: number; startWidth: number; pixelsPerRem: number } | null>(null);
  const start = (event: PointerEvent<HTMLDivElement>) => {
    const pixelsPerRem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    event.preventDefault();
    drag.current = { startX: event.clientX, startWidth: width, pixelsPerRem };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveTo = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null) return;
    onResize(current.startWidth + (event.clientX - current.startX) / current.pixelsPerRem);
  };
  const end = () => { drag.current = null; };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 2 : 0.5;
    if (event.key === "ArrowLeft") { event.preventDefault(); onResize(width - step); }
    if (event.key === "ArrowRight") { event.preventDefault(); onResize(width + step); }
  };
  return (
    <div role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0}
      aria-valuemin={minimumPanelWidth} aria-valuemax={maximumPanelWidth} aria-valuenow={width}
      onPointerDown={start} onPointerMove={moveTo} onPointerUp={end} onPointerCancel={end} onKeyDown={key}
      className="w-1.5 shrink-0 cursor-col-resize touch-none select-none bg-border outline-none transition-colors hover:bg-ring focus-visible:bg-ring" />
  );
}

export function StudioFrame<Key extends string>({
  topBar, tabs, activeTab, onTabChange, panel, canvas, inspector, inspectorLabel = "Inspector",
}: Readonly<{
  topBar: ReactNode;
  tabs: readonly StudioRailTab<Key>[];
  activeTab: Key;
  /** Switches the rail tab; resolves false when the switch was declined (for example to keep unapplied input). */
  onTabChange: (key: Key) => Promise<boolean> | boolean;
  /** Every tab's panel content; the caller shows the active one, so the others keep their state. */
  panel: ReactNode;
  canvas: (controls: Readonly<{ inspectorOpen: boolean; toggleInspector: () => void }>) => ReactNode;
  inspector: ReactNode;
  inspectorLabel?: string;
}>) {
  const wide = useSyncExternalStore(subscribeWide, readWide, readWideOnServer);
  const { widthOf, setWidth } = useStudioPanelWidths(tabs);
  const [panelOpen, setPanelOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [narrowPanelOpen, setNarrowPanelOpen] = useState(false);
  const [narrowInspectorOpen, setNarrowInspectorOpen] = useState(false);
  const [hosts, setHosts] = useState<PaneHosts | null>(null);
  useEffect(() => {
    const create = () => {
      const host = document.createElement("div");
      host.className = "flex h-full min-h-0 flex-col";
      return host;
    };
    setHosts({ panel: create(), inspector: create() });
  }, []);
  const choose = async (key: Key) => {
    if (key === activeTab) {
      if (wide) setPanelOpen((open) => !open);
      else setNarrowPanelOpen((open) => !open);
      return;
    }
    if (!await onTabChange(key)) return;
    if (wide) setPanelOpen(true);
    else setNarrowPanelOpen(true);
  };
  const toggleInspector = () => {
    if (wide) setInspectorOpen((open) => !open);
    else setNarrowInspectorOpen((open) => !open);
  };
  const active = tabs.find((tab) => tab.key === activeTab);
  const width = widthOf(activeTab);
  const showPanel = wide && panelOpen;
  const showInspector = wide && inspectorOpen;
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {topBar}
      <div className="flex min-h-0 flex-1">
        <StudioRail tabs={tabs} active={activeTab} open={wide ? panelOpen : narrowPanelOpen}
          onChoose={(key) => { void choose(key); }} label="Studio areas" />
        {showPanel && <>
          <section id="studio-rail-panel" role="tabpanel" aria-labelledby={`studio-rail-${activeTab}`}
            className="flex min-h-0 shrink-0 flex-col bg-background" style={{ width: `${width}rem` }}>
            <PaneSlot host={hosts?.panel ?? null} />
          </section>
          <PanelResizer width={width} onResize={(rem) => setWidth(activeTab, rem)}
            label={`Resize the ${active?.label ?? ""} panel`} />
        </>}
        <section aria-label="Canvas" className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/30">
          {canvas({ inspectorOpen: wide ? inspectorOpen : narrowInspectorOpen, toggleInspector })}
        </section>
        {showInspector && (
          <aside aria-label={inspectorLabel} className="flex min-h-0 w-80 shrink-0 flex-col border-l border-border bg-background">
            <PaneSlot host={hosts?.inspector ?? null} />
          </aside>
        )}
      </div>
      <Sheet open={!wide && narrowPanelOpen} onOpenChange={setNarrowPanelOpen}>
        <SheetContent side="left" className="w-80 max-w-full p-0">
          <SheetHeader className="sr-only"><SheetTitle>{active?.label}</SheetTitle>
            <SheetDescription>The {active?.label} panel.</SheetDescription></SheetHeader>
          <div id="studio-rail-panel" role="tabpanel" className="flex h-full min-h-0 flex-col">
            <PaneSlot host={hosts?.panel ?? null} />
          </div>
        </SheetContent>
      </Sheet>
      <Sheet open={!wide && narrowInspectorOpen} onOpenChange={setNarrowInspectorOpen}>
        <SheetContent side="right" className="w-96 max-w-full p-0">
          <SheetHeader className="sr-only"><SheetTitle>{inspectorLabel}</SheetTitle>
            <SheetDescription>Settings for the selected item.</SheetDescription></SheetHeader>
          <div aria-label={inspectorLabel} className="flex h-full min-h-0 flex-col"><PaneSlot host={hosts?.inspector ?? null} /></div>
        </SheetContent>
      </Sheet>
      {hosts !== null && createPortal(panel, hosts.panel)}
      {hosts !== null && createPortal(inspector, hosts.inspector)}
    </div>
  );
}

/** The chrome every Studio panel is built from: a titled header with an optional action, over scrolling content. */
export function StudioPanelShell({ title, description, action, hidden, children }: Readonly<{
  title: string;
  description?: string | undefined;
  action?: ReactNode;
  /** A panel of another rail tab stays mounted (keeping its state) but is not shown. */
  hidden?: boolean | undefined;
  children: ReactNode;
}>) {
  return (
    <div hidden={hidden} className={cn("min-h-0 flex-1 flex-col", hidden ? "hidden" : "flex")}>
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 flex-col">
          <h2 className="text-sm font-medium text-foreground">{title}</h2>
          {description === undefined ? null : <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">{children}</div>
    </div>
  );
}

/** A panel's search field with a clear button. */
export function StudioSearchBox({ value, onChange, placeholder, label }: Readonly<{
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}>) {
  return (
    <div className="relative">
      <Icon name="search" className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder}
        aria-label={label} className="px-8" />
      {value.length === 0 ? null : (
        <Button type="button" variant="ghost" size="icon-xs" aria-label={`Clear ${label.toLowerCase()}`}
          onClick={() => onChange("")} className="absolute top-1/2 right-1 -translate-y-1/2">
          <Icon name="close" />
        </Button>
      )}
    </div>
  );
}
