"use client";
import { Icon, type VortexIconName } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import { Tooltip, TooltipTrigger, TooltipContent } from "@vortex/ui/components/tooltip";
import { Kbd } from "@vortex/ui/components/kbd";
import type { StudioCanvasBreakpoint } from "@vortex/ui/studio/page-puck-editor";

const devices: readonly Readonly<{ value: StudioCanvasBreakpoint; label: string; icon: VortexIconName }>[] = [
  { value: "desktop", label: "Desktop", icon: "monitor" },
  { value: "tablet", label: "Tablet", icon: "tablet" },
  { value: "phone", label: "Phone", icon: "smartphone" },
];

/** The canvas zoom steps, in percent. */
export const studioCanvasZooms = [50, 75, 100, 125] as const;
export type StudioCanvasZoom = (typeof studioCanvasZooms)[number];

/**
 * Above the canvas: what it is showing, whose view it shows, the screen size and zoom it is drawn
 * at, and the inspector toggle.
 */
export function StudioCanvasToolbar({ title, breakpoint, onBreakpoint, zoom, onZoom, showsCanvas,
  inspectorOpen, onToggleInspector, focused, onFocusCanvas, appearance, onAppearance, viewAs }: Readonly<{
  title: string;
  /** "Who can see this": the roles the canvas and its menu can be previewed as, and the one shown (`null` is the design view). */
  viewAs: Readonly<{ roles: readonly Readonly<{ key: string; name: string }>[]; value: string | null;
    onChange: (roleKey: string | null) => void }>;
  /** The appearance the canvas previews the application in; the running application keeps its own toggle. */
  appearance: "light" | "dark";
  onAppearance: (appearance: "light" | "dark") => void;
  breakpoint: StudioCanvasBreakpoint;
  onBreakpoint: (breakpoint: StudioCanvasBreakpoint) => void;
  zoom: StudioCanvasZoom;
  onZoom: (zoom: StudioCanvasZoom) => void;
  /** Screen size and zoom apply to the page canvas only. */
  showsCanvas: boolean;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  focused: boolean;
  onFocusCanvas: () => void;
}>) {
  const step = studioCanvasZooms.indexOf(zoom);
  return <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background px-3 py-1">
    <h2 className="min-w-0 truncate text-sm font-medium">{title}</h2>
    <div className="ml-auto flex flex-wrap items-center gap-2">
      {showsCanvas && <>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">View as</span>
          <NativeSelect size="sm" value={viewAs.value ?? ""} aria-label="Who can see this: view the canvas as a role"
            onChange={(event) => viewAs.onChange(event.target.value === "" ? null : event.target.value)}>
            <NativeSelectOption value="">Builder (everything)</NativeSelectOption>
            {viewAs.roles.map((role) => <NativeSelectOption key={role.key} value={role.key}>{role.name}</NativeSelectOption>)}
          </NativeSelect>
        </label>
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
      <Tooltip>
        <TooltipTrigger render={<Button type="button" size="icon-sm" variant={focused ? "secondary" : "ghost"}
          aria-label="Focus canvas" aria-pressed={focused} onClick={onFocusCanvas} />}><Icon name="monitor" /></TooltipTrigger>
        <TooltipContent>Focus canvas <Kbd>Ctrl \\</Kbd></TooltipContent>
      </Tooltip>
      <Button type="button" size="sm" variant={inspectorOpen ? "secondary" : "ghost"} aria-pressed={inspectorOpen}
        onClick={onToggleInspector}><Icon name="panel-left" className="rotate-180" />Inspector</Button>
    </div>
  </div>;
}
