"use client";
import { Icon, type VortexIconName } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import type { StudioCanvasBreakpoint } from "@vortex/ui/studio/page-puck-editor";

const devices: readonly Readonly<{ value: StudioCanvasBreakpoint; label: string; icon: VortexIconName }>[] = [
  { value: "desktop", label: "Desktop", icon: "monitor" },
  { value: "tablet", label: "Tablet", icon: "tablet" },
  { value: "phone", label: "Phone", icon: "smartphone" },
];

/** The canvas zoom steps, in percent. */
export const studioCanvasZooms = [50, 75, 100, 125] as const;
export type StudioCanvasZoom = (typeof studioCanvasZooms)[number];

/** Above the canvas: what it is showing, the screen size and zoom it is drawn at, and the inspector toggle. */
export function StudioCanvasToolbar({ title, breakpoint, onBreakpoint, zoom, onZoom, showsCanvas, previewing, onEndPreview,
  inspectorOpen, onToggleInspector, appearance, onAppearance }: Readonly<{
  title: string;
  /** The appearance the canvas previews the application in; the running application keeps its own toggle. */
  appearance: "light" | "dark";
  onAppearance: (appearance: "light" | "dark") => void;
  breakpoint: StudioCanvasBreakpoint;
  onBreakpoint: (breakpoint: StudioCanvasBreakpoint) => void;
  zoom: StudioCanvasZoom;
  onZoom: (zoom: StudioCanvasZoom) => void;
  /** Screen size and zoom apply to the page canvas only. */
  showsCanvas: boolean;
  previewing: boolean;
  onEndPreview: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
}>) {
  const step = studioCanvasZooms.indexOf(zoom);
  return <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background px-3 py-1">
    <h2 className="min-w-0 truncate text-sm font-medium">{title}</h2>
    {previewing && <Button type="button" variant="outline" size="sm" onClick={onEndPreview}>
      <Icon name="chevron-left" />Back to editing</Button>}
    <div className="ml-auto flex flex-wrap items-center gap-2">
      {showsCanvas && <>
        <div role="group" aria-label="Screen size" className="flex gap-1">
          {devices.map((device) => <Button key={device.value} type="button" size="icon-sm" title={device.label}
            aria-label={device.label} variant={breakpoint === device.value ? "secondary" : "ghost"}
            aria-pressed={breakpoint === device.value} onClick={() => onBreakpoint(device.value)}>
            <Icon name={device.icon} /></Button>)}
        </div>
        <div role="group" aria-label="Preview appearance" className="flex gap-1">
          {(["light", "dark"] as const).map((mode) => <Button key={mode} type="button" size="sm"
            variant={appearance === mode ? "secondary" : "ghost"} aria-pressed={appearance === mode}
            onClick={() => onAppearance(mode)}>{mode === "light" ? "Light" : "Dark"}</Button>)}
        </div>
        <div role="group" aria-label="Zoom" className="flex items-center gap-1">
          <Button type="button" size="icon-sm" variant="ghost" aria-label="Zoom out" title="Zoom out" disabled={step <= 0}
            onClick={() => onZoom(studioCanvasZooms[step - 1]!)}><Icon name="minus" /></Button>
          <Button type="button" size="sm" variant="ghost" aria-label={`Zoom ${zoom}%, reset to 100%`} title="Reset zoom"
            onClick={() => onZoom(100)}><span className="tabular-nums">{zoom}%</span></Button>
          <Button type="button" size="icon-sm" variant="ghost" aria-label="Zoom in" title="Zoom in"
            disabled={step >= studioCanvasZooms.length - 1}
            onClick={() => onZoom(studioCanvasZooms[step + 1]!)}><Icon name="plus" /></Button>
        </div>
      </>}
      <Button type="button" size="sm" variant={inspectorOpen ? "secondary" : "ghost"} aria-pressed={inspectorOpen}
        onClick={onToggleInspector}><Icon name="panel-left" className="rotate-180" />Inspector</Button>
    </div>
  </div>;
}
