"use client";
import { Icon, type VortexIconName } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
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
export const studioCanvasZooms = [50, 75, 100, 125] as const;
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
  onZoom,
  showsCanvas,
  inspectorOpen,
  onToggleInspector,
  focused,
  onFocusCanvas,
  appearance,
  onAppearance,
  viewAs,
}: Readonly<{
  title: string;
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
  onZoom: (zoom: StudioCanvasZoom) => void;
  /** Screen size and zoom apply to the page canvas only. */
  showsCanvas: boolean;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  focused: boolean;
  onFocusCanvas: () => void;
}>) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-4">
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={title}>
        {title}
      </h2>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {showsCanvas && (
          <>
            <label className="flex items-center gap-2 text-sm">
              <span className="sr-only">View as</span>
              <NativeSelect
                size="sm"
                value={viewAs.value ?? ""}
                aria-label="Who can see this: view the canvas as a role"
                className="w-32 [&>select]:w-full [&>select]:truncate"
                onChange={(event) =>
                  viewAs.onChange(event.target.value === "" ? null : event.target.value)
                }
              >
                <NativeSelectOption value="">Builder (everything)</NativeSelectOption>
                {viewAs.roles.map((role) => (
                  <NativeSelectOption key={role.key} value={role.key}>
                    {role.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
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
                disabled={zoom === studioCanvasZooms[0]}
                onClick={() =>
                  onZoom(
                    zoom === "fit"
                      ? 50
                      : studioCanvasZooms[Math.max(0, studioCanvasZooms.indexOf(zoom) - 1)]!,
                  )
                }
              >
                <Icon name="minus" />
              </Button>
              <NativeSelect
                size="sm"
                aria-label="Canvas zoom"
                value={zoom}
                onChange={(event) =>
                  onZoom(
                    event.target.value === "fit"
                      ? "fit"
                      : (Number(event.target.value) as StudioCanvasZoom),
                  )
                }
              >
                <NativeSelectOption value="fit">Fit</NativeSelectOption>
                {studioCanvasZooms.map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {value}%
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Zoom in"
                disabled={zoom === studioCanvasZooms[studioCanvasZooms.length - 1]}
                onClick={() =>
                  onZoom(
                    zoom === "fit"
                      ? 100
                      : studioCanvasZooms[
                          Math.min(
                            studioCanvasZooms.length - 1,
                            studioCanvasZooms.indexOf(zoom) + 1,
                          )
                        ]!,
                  )
                }
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
      </div>
    </div>
  );
}
