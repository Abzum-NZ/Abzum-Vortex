"use client";
import { StudioOptionControl } from "@vortex/ui/studio";
import { Icon, type VortexIconName } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@vortex/ui/components/tooltip";
import { ToggleGroup, ToggleGroupItem } from "@vortex/ui/components/toggle-group";
import { Kbd } from "@vortex/ui/components/kbd";
import type { StudioCanvasBreakpoint } from "@vortex/ui/studio/page-puck-editor";

const devices: readonly Readonly<{
  value: StudioCanvasBreakpoint;
  label: string;
  icon: VortexIconName;
}>[] = [
  { value: "desktop", label: "Desktop", icon: "monitor" },
  { value: "tablet", label: "Tablet", icon: "tablet" },
  { value: "phone", label: "Phone", icon: "smartphone" },
];

/** The canvas zoom steps, in percent. */
const studioCanvasZooms = [50, 75, 100, 125] as const;
export type StudioCanvasZoom = (typeof studioCanvasZooms)[number] | "fit";

/**
 * Above the canvas: what it is showing, whose view it shows, the screen size and zoom it is drawn
 * at, and the inspector toggle.
 */
export function StudioCanvasToolbar({
  title,
  breakpoint,
  onBreakpoint,
  zoom,
  fitZoom,
  onZoom,
  showsCanvas,
  inspectorOpen,
  onToggleInspector,
  focused,
  onFocusCanvas,
  appearance,
  onAppearance,
  viewAs,
  arrangeGrid,
  arrangeableGrids,
  onArrangeGrid,
}: Readonly<{
  title: string;
  arrangeGrid: boolean;
  /** Whether a data grid on the open page has columns to arrange. */
  arrangeableGrids: boolean;
  onArrangeGrid: () => void;
  /** "Who can see this": the roles the canvas and its menu can be previewed as, and the one shown (`null` is the design view). */
  viewAs: Readonly<{
    roles: readonly Readonly<{ key: string; name: string }>[];
    value: string | null;
    onChange: (roleKey: string | null) => void;
  }>;
  /** The appearance the canvas previews the application in; the running application keeps its own toggle. */
  appearance: "light" | "dark";
  onAppearance: (appearance: "light" | "dark") => void;
  breakpoint: StudioCanvasBreakpoint;
  onBreakpoint: (breakpoint: StudioCanvasBreakpoint) => void;
  zoom: StudioCanvasZoom;
  fitZoom: number;
  onZoom: (zoom: StudioCanvasZoom) => void;
  /** Screen size and zoom apply to the page canvas only. */
  showsCanvas: boolean;
  inspectorOpen: boolean;
  onToggleInspector: (() => void) | undefined;
  focused: boolean;
  onFocusCanvas: () => void;
}>) {
  const effectiveZoom = zoom === "fit" ? fitZoom : zoom;
  const zoomOut = [...studioCanvasZooms].reverse().find((step) => step < effectiveZoom);
  const zoomIn = studioCanvasZooms.find((step) => step > effectiveZoom);
  return (
    <div className="flex min-h-12 min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background px-4 py-2">
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={title}>
        {title}
      </h2>
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
        {showsCanvas && (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant={arrangeGrid ? "secondary" : "ghost"}
                    aria-label="Arrange grid columns"
                    aria-pressed={arrangeGrid}
                    // Stays focusable and hoverable, so its tooltip explains why it is off.
                    disabled={!arrangeGrid && !arrangeableGrids}
                    focusableWhenDisabled
                    className="aria-disabled:opacity-50"
                    onClick={onArrangeGrid}
                  />
                }
              >
                <Icon name="table-columns" />
              </TooltipTrigger>
              <TooltipContent>
                {arrangeGrid || arrangeableGrids
                  ? "Arrange grid columns"
                  : "Arrange grid columns: this page has no data grid with columns yet"}
              </TooltipContent>
            </Tooltip>
            <label className="flex items-center gap-2 text-sm">
              <span>View as:</span>
              <StudioOptionControl
                value={viewAs.value ?? ""}
                aria-label="Who can see this: view the canvas as a role"
                disabled={false}
                unset="Builder"
                options={viewAs.roles.map((role) => ({ value: role.key, label: role.name }))}
                onChange={(value) => viewAs.onChange(value === "" ? null : value)}
              />
            </label>
            <ToggleGroup
              aria-label="Screen size"
              size="sm"
              value={[breakpoint]}
              onValueChange={(values) => {
                const device = devices.find((entry) => entry.value === values[0]);
                if (device) onBreakpoint(device.value);
              }}
            >
              {devices.map((device) => (
                <ToggleGroupItem
                  key={device.value}
                  value={device.value}
                  aria-label={device.label}
                  title={device.label}
                  className="size-8"
                >
                  <Icon name={device.icon} />
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <ToggleGroup
              aria-label="Preview appearance"
              size="sm"
              value={[appearance]}
              onValueChange={(values) => {
                const mode = values[0];
                if (mode === "light" || mode === "dark") onAppearance(mode);
              }}
            >
              <ToggleGroupItem
                value="light"
                aria-label="Light appearance"
                title="Light appearance"
                className="size-8"
              >
                <Icon name="sun" />
              </ToggleGroupItem>
              <ToggleGroupItem
                value="dark"
                aria-label="Dark appearance"
                title="Dark appearance"
                className="size-8"
              >
                <Icon name="moon" />
              </ToggleGroupItem>
            </ToggleGroup>
            <div role="group" aria-label="Canvas zoom" className="flex items-center">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Zoom out"
                disabled={zoomOut === undefined}
                onClick={() => {
                  if (zoomOut !== undefined) onZoom(zoomOut);
                }}
              >
                <Icon name="minus" />
              </Button>
              <StudioOptionControl
                aria-label="Canvas zoom"
                value={String(zoom)}
                disabled={false}
                options={[
                  { value: "fit", label: "Fit" },
                  ...studioCanvasZooms.map((value) => ({
                    value: String(value),
                    label: `${value}%`,
                  })),
                ]}
                onChange={(value) =>
                  onZoom(value === "fit" ? "fit" : (Number(value) as StudioCanvasZoom))
                }
              />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Zoom in"
                disabled={zoomIn === undefined}
                onClick={() => {
                  if (zoomIn !== undefined) onZoom(zoomIn);
                }}
              >
                <Icon name="plus" />
              </Button>
            </div>
          </>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant={focused ? "secondary" : "ghost"}
                aria-label="Focus canvas"
                aria-pressed={focused}
                onClick={onFocusCanvas}
              />
            }
          >
            <Icon name="monitor" />
          </TooltipTrigger>
          <TooltipContent>
            Focus canvas <Kbd>Ctrl \\</Kbd>
          </TooltipContent>
        </Tooltip>
        {onToggleInspector !== undefined && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant={inspectorOpen ? "secondary" : "ghost"}
                  aria-label="Inspector"
                  aria-pressed={inspectorOpen}
                  onClick={onToggleInspector}
                />
              }
            >
              <Icon name="panel-left" className="rotate-180" />
            </TooltipTrigger>
            <TooltipContent>
              Inspector <Kbd>Ctrl .</Kbd>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
