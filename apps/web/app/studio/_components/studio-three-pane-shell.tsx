"use client";
import { useState, useSyncExternalStore, type ReactNode } from "react";
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

/**
 * The Studio workspace frame: a top bar over an outline pane, a canvas pane and an inspector pane.
 * Wide windows show the three panes side by side; narrow windows stack them and open the outline
 * and the inspector in sheets. Each pane's content is rendered once, so editors keep their state.
 */
export function StudioThreePaneShell({ topBar, outline, canvas, inspector }: Readonly<{
  topBar: ReactNode; outline: ReactNode; canvas: ReactNode; inspector: ReactNode;
}>) {
  const wide = useSyncExternalStore(subscribeWide, readWide, readWideOnServer);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  return <div className="space-y-4">
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-background py-2">
      {topBar}
      {!wide && <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setOutlineOpen(true)}>Outline</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setInspectorOpen(true)}>Inspector</Button>
      </div>}
    </div>
    {wide
      ? <div className="grid grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)_minmax(16rem,22rem)] items-start gap-4">
        <nav aria-label="Application outline" className="max-h-[75vh] space-y-3 overflow-y-auto pr-1">
          <h2 className="font-semibold">Outline</h2>{outline}</nav>
        <section aria-label="Canvas" className="min-w-0 space-y-3">{canvas}</section>
        <aside aria-label="Selection inspector" className="max-h-[75vh] space-y-3 overflow-y-auto pr-1">
          <h2 className="font-semibold">Inspector</h2>{inspector}</aside>
      </div>
      : <>
        <section aria-label="Canvas" className="min-w-0 space-y-3">{canvas}</section>
        <Sheet open={outlineOpen} onOpenChange={setOutlineOpen}>
          <SheetContent side="left" className="w-80 max-w-full overflow-y-auto p-4">
            <SheetHeader><SheetTitle>Outline</SheetTitle>
              <SheetDescription>Choose the page, flow or item to work on.</SheetDescription></SheetHeader>
            <nav aria-label="Application outline" className="space-y-3">{outline}</nav>
          </SheetContent>
        </Sheet>
        <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen}>
          <SheetContent side="right" className="w-96 max-w-full overflow-y-auto p-4">
            <SheetHeader><SheetTitle>Inspector</SheetTitle>
              <SheetDescription>Settings for the selected item.</SheetDescription></SheetHeader>
            <div aria-label="Selection inspector" className="space-y-3">{inspector}</div>
          </SheetContent>
        </Sheet>
      </>}
  </div>;
}
