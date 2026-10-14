"use client";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@vortex/ui/components/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@vortex/ui/components/sheet";

const wideQuery = "(min-width: 1024px)";
const subscribeWide = (notify: () => void) => {
  const list = window.matchMedia(wideQuery);
  list.addEventListener("change", notify);
  return () => list.removeEventListener("change", notify);
};
const readWide = () => window.matchMedia(wideQuery).matches;
// The server and the first client render use the stacked layout; a wide window switches after hydration.
const readWideOnServer = () => false;

type PaneHosts = Readonly<{ outline: HTMLDivElement; inspector: HTMLDivElement }>;

/**
 * Attaches a pane's persistent host element to whichever slot is currently on screen. The pane's
 * React content is portalled into the host once, so moving the host between the side-by-side
 * layout and a sheet changes where it is drawn without remounting the editors inside it.
 */
function PaneSlot({ host }: Readonly<{ host: HTMLDivElement | null }>) {
  const attach = useCallback((slot: HTMLDivElement | null) => {
    if (slot !== null && host !== null) slot.appendChild(host);
  }, [host]);
  return <div ref={attach} className="contents" />;
}

/**
 * The Studio workspace frame: a top bar over an outline pane, a canvas pane and an inspector pane.
 * Wide windows show the three panes side by side; narrow windows stack the canvas and open the
 * outline and the inspector in sheets. Each pane's content is rendered exactly once and stays
 * mounted across the breakpoint and while its sheet is closed (a closed pane is detached from the
 * document, so it neither shows nor takes focus), so unapplied editor input and pending flags
 * stay consistent. `outline` receives a function that closes the narrow outline sheet.
 */
export function StudioThreePaneShell({ topBar, outline, canvas, inspector }: Readonly<{
  topBar: ReactNode; outline: (closeOutline: () => void) => ReactNode; canvas: ReactNode; inspector: ReactNode;
}>) {
  const wide = useSyncExternalStore(subscribeWide, readWide, readWideOnServer);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [hosts, setHosts] = useState<PaneHosts | null>(null);
  useEffect(() => {
    const create = () => {
      const host = document.createElement("div");
      host.className = "space-y-3";
      return host;
    };
    setHosts({ outline: create(), inspector: create() });
  }, []);
  const closeOutline = useCallback(() => setOutlineOpen(false), []);
  return <div className="space-y-4">
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-background py-2">
      {topBar}
      {!wide && <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setOutlineOpen(true)}>Outline</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setInspectorOpen(true)}>Inspector</Button>
      </div>}
    </div>
    <div className={wide ? "grid grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)_minmax(16rem,22rem)] items-start gap-4" : "space-y-4"}>
      {wide && <nav aria-label="Application outline" className="max-h-[75vh] min-w-0 space-y-3 overflow-y-auto pr-1">
        <h2 className="font-semibold">Outline</h2><PaneSlot host={hosts?.outline ?? null} /></nav>}
      <section aria-label="Canvas" className="min-w-0 space-y-3">{canvas}</section>
      {wide && <aside aria-label="Selection inspector" className="max-h-[75vh] min-w-0 space-y-3 overflow-y-auto pr-1">
        <h2 className="font-semibold">Inspector</h2><PaneSlot host={hosts?.inspector ?? null} /></aside>}
    </div>
    <Sheet open={!wide && outlineOpen} onOpenChange={setOutlineOpen}>
      <SheetContent side="left" className="w-80 max-w-full overflow-y-auto p-4">
        <SheetHeader><SheetTitle>Outline</SheetTitle>
          <SheetDescription>Choose the page, flow or item to work on.</SheetDescription></SheetHeader>
        <nav aria-label="Application outline" className="space-y-3"><PaneSlot host={hosts?.outline ?? null} /></nav>
      </SheetContent>
    </Sheet>
    <Sheet open={!wide && inspectorOpen} onOpenChange={setInspectorOpen}>
      <SheetContent side="right" className="w-96 max-w-full overflow-y-auto p-4">
        <SheetHeader><SheetTitle>Inspector</SheetTitle>
          <SheetDescription>Settings for the selected item.</SheetDescription></SheetHeader>
        <div aria-label="Selection inspector" className="space-y-3"><PaneSlot host={hosts?.inspector ?? null} /></div>
      </SheetContent>
    </Sheet>
    {hosts !== null && createPortal(outline(closeOutline), hosts.outline)}
    {hosts !== null && createPortal(inspector, hosts.inspector)}
  </div>;
}
