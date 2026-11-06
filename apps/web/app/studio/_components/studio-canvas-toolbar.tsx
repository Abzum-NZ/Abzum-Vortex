"use client";
import { memo } from "react";
import { StudioOptionControl } from "@vortex/ui/studio";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@vortex/ui/components/tooltip";
import { ToggleGroup, ToggleGroupItem } from "@vortex/ui/components/toggle-group";
import { Kbd } from "@vortex/ui/components/kbd";
import { Spinner } from "@vortex/ui/components/spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@vortex/ui/components/dropdown-menu";
import { studioScreens, useStudioScreen } from "@vortex/ui/studio/puck-provider";

/** The canvas zoom steps, in percent. */
const studioCanvasZooms = [50, 75, 100, 125] as const;
export type StudioCanvasZoom = (typeof studioCanvasZooms)[number] | "fit";

/**
 * Above the canvas: what it is showing, whose view it shows, the screen size and zoom it is drawn
 * at, and the inspector toggle.
 */
export const StudioCanvasToolbar = memo(function StudioCanvasToolbar({
  title,
  zoom,
  fitZoom,
  onZoom,
  showsCanvas,
  inspectorOpen,
  onToggleInspector,
  focused,
  onFocusCanvas,
  loading,
  appearance,
  onAppearance,
  viewAs,
  arrangeGrid,
  arrangeableGrids,
  locked,
  onArrangeGrid,
}: Readonly<{
  /** The draft is locked: nothing on the canvas can be arranged. */
  locked: boolean;
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
  zoom: StudioCanvasZoom;
  fitZoom: number;
  onZoom: (zoom: StudioCanvasZoom) => void;
  /** Screen size and zoom apply to the page canvas only. */
  showsCanvas: boolean;
  inspectorOpen: boolean;
  onToggleInspector: (() => void) | undefined;
  focused: boolean;
  onFocusCanvas: () => void;
  /** The editor is loading its view of the draft. */
  loading: boolean;
}>) {
  const screen = useStudioScreen();
  const effectiveZoom = zoom === "fit" ? fitZoom : zoom;
  const zoomOut = [...studioCanvasZooms].reverse().find((step) => step < effectiveZoom);
  const zoomIn = studioCanvasZooms.find((step) => step > effectiveZoom);
  const arrangeTip = locked
    ? "Arrange grid columns: the draft is locked"
    : arrangeGrid || arrangeableGrids
      ? "Arrange grid columns"
      : "Arrange grid columns: this page has no data grid with columns yet";
  return (
    // One row that never wraps. What does not fit a narrow centre moves into the More menu (the
    // appearance and the grid arrangement) or is dropped (the zoom steps, the title).
    <div className="@container/toolbar shrink-0 border-b border-border bg-background">
      <div className="flex h-12 min-w-0 flex-nowrap items-center gap-2 px-4">
        <h2
          className="min-w-0 flex-1 truncate text-sm font-semibold @max-[34rem]/toolbar:hidden"
          title={title}
        >
          {title}
        </h2>
        <div className="ml-auto flex min-w-0 shrink-0 flex-nowrap items-center gap-1">
          {loading && (
            <Tooltip>
              <TooltipTrigger render={<span className="flex size-8 items-center justify-center" />}>
                <Spinner />
              </TooltipTrigger>
              <TooltipContent>Loading this editor</TooltipContent>
            </Tooltip>
          )}
          {showsCanvas && (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <div className="flex w-32 shrink-0 items-center gap-1">
                      <Icon name="eye" className="shrink-0 text-muted-foreground" />
                      <StudioOptionControl
                        value={viewAs.value ?? ""}
                        aria-label="View as: who can see this"
                        disabled={false}
                        unset="Builder"
                        options={viewAs.roles.map((role) => ({
                          value: role.key,
                          label: role.name,
                        }))}
                        onChange={(value) => viewAs.onChange(value === "" ? null : value)}
                      />
                    </div>
                  }
                />
                <TooltipContent>View as: who can see this</TooltipContent>
              </Tooltip>
              <ToggleGroup
                aria-label="Screen size"
                size="sm"
                value={[screen.breakpoint]}
                // Tabbing into the group lands on the chosen screen, not on the first one.
                onFocus={(event) => {
                  const chosen =
                    event.currentTarget.querySelector<HTMLElement>('[aria-pressed="true"]');
                  const from = event.relatedTarget;
                  if (
                    chosen !== null &&
                    chosen !== event.target &&
                    !(from instanceof Node && event.currentTarget.contains(from))
                  )
                    chosen.focus();
                }}
                onValueChange={(values) => {
                  const chosen = studioScreens.find((entry) => entry.breakpoint === values[0]);
                  if (chosen) screen.choose(chosen.breakpoint);
                }}
              >
                {studioScreens.map((entry) => (
                  <Tooltip key={entry.breakpoint}>
                    <TooltipTrigger
                      render={
                        <ToggleGroupItem
                          value={entry.breakpoint}
                          aria-label={entry.label}
                          className="size-8"
                        />
                      }
                    >
                      <Icon name={entry.icon} />
                    </TooltipTrigger>
                    <TooltipContent>{entry.label}</TooltipContent>
                  </Tooltip>
                ))}
              </ToggleGroup>
              <div className="flex items-center gap-1 @max-[46rem]/toolbar:hidden">
                <ToggleGroup
                  aria-label="Preview appearance"
                  size="sm"
                  value={[appearance]}
                  onValueChange={(values) => {
                    const mode = values[0];
                    if (mode === "light" || mode === "dark") onAppearance(mode);
                  }}
                >
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <ToggleGroupItem
                          value="light"
                          aria-label="Light appearance"
                          className="size-8"
                        />
                      }
                    >
                      <Icon name="sun" />
                    </TooltipTrigger>
                    <TooltipContent>Light appearance</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <ToggleGroupItem
                          value="dark"
                          aria-label="Dark appearance"
                          className="size-8"
                        />
                      }
                    >
                      <Icon name="moon" />
                    </TooltipTrigger>
                    <TooltipContent>Dark appearance</TooltipContent>
                  </Tooltip>
                </ToggleGroup>
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
                        disabled={locked || (!arrangeGrid && !arrangeableGrids)}
                        focusableWhenDisabled
                        className="aria-disabled:opacity-50"
                        onClick={onArrangeGrid}
                      />
                    }
                  >
                    <Icon name="table-columns" />
                  </TooltipTrigger>
                  <TooltipContent>{arrangeTip}</TooltipContent>
                </Tooltip>
              </div>
              <div className="@min-[46rem]/toolbar:hidden">
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <DropdownMenuTrigger
                          render={
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              aria-label="More canvas controls"
                            />
                          }
                        />
                      }
                    >
                      <Icon name="more-horizontal" />
                    </TooltipTrigger>
                    <TooltipContent>Appearance and grid arrangement</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="end">
                    <DropdownMenuRadioGroup
                      value={appearance}
                      onValueChange={(mode) => {
                        if (mode === "light" || mode === "dark") onAppearance(mode);
                      }}
                    >
                      <DropdownMenuRadioItem value="light">
                        <Icon name="sun" />
                        Light appearance
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="dark">
                        <Icon name="moon" />
                        Dark appearance
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={locked || (!arrangeGrid && !arrangeableGrids)}
                      onClick={onArrangeGrid}
                    >
                      <Icon name="table-columns" />
                      {arrangeGrid ? "Stop arranging grid columns" : "Arrange grid columns"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div role="group" aria-label="Canvas zoom" className="flex items-center">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Zoom out"
                        className="@max-[40rem]/toolbar:hidden"
                        disabled={zoomOut === undefined}
                        onClick={() => {
                          if (zoomOut !== undefined) onZoom(zoomOut);
                        }}
                      />
                    }
                  >
                    <Icon name="minus" />
                  </TooltipTrigger>
                  <TooltipContent>Zoom out</TooltipContent>
                </Tooltip>
                <div className="w-20 shrink-0">
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
                </div>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Zoom in"
                        className="@max-[40rem]/toolbar:hidden"
                        disabled={zoomIn === undefined}
                        onClick={() => {
                          if (zoomIn !== undefined) onZoom(zoomIn);
                        }}
                      />
                    }
                  >
                    <Icon name="plus" />
                  </TooltipTrigger>
                  <TooltipContent>Zoom in</TooltipContent>
                </Tooltip>
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
              <Icon name="maximize" />
            </TooltipTrigger>
            <TooltipContent>
              Focus canvas <Kbd>{"Ctrl \\"}</Kbd>
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
    </div>
  );
});
