"use client";

import { Puck } from "@puckeditor/core";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Breakpoint } from "../definition-error";
import { Alert, AlertDescription, AlertTitle } from "../components/alert";
import { Badge } from "../components/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Button } from "../components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/empty";
import { Label } from "../components/label";
import { Icon } from "../icons";
import { studioPageAreaLabel } from "./application-page-layout";
import type { StudioCompileFailure } from "./compile-failure";
import { StudioBlockPalette } from "./studio-block-palette";
import { StudioCanvasActions } from "./studio-canvas-actions";
import { StudioCanvasGridContext } from "./studio-canvas-grid";
import {
  StudioCanvasCompiledSettings,
  StudioCanvasControlsProvider,
  StudioCanvasRecordsProvider,
  StudioCanvasViewerProvider,
} from "./studio-canvas-render";
import { StudioCanvasFrameProvider } from "./studio-canvas-root";
import { StudioReferencePicker } from "./studio-reference-picker";
import { useStudioCanvas } from "./studio-puck-provider";
import { useStudioCanvasRecords } from "./use-studio-canvas-records";

const deviceWidths: Readonly<Record<Breakpoint, number>> = {
  desktop: 1280,
  tablet: 820,
  phone: 390,
};

function CanvasEmpty({ title, description }: Readonly<{ title: string; description: string }>) {
  return (
    <Empty role="status" className="min-h-64">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon name="blocks" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/**
 * Studio's Blocks panel: the places and blocks of the open page, drawn inside the workspace's
 * Puck editor so a block is dragged with Puck's own drag and drop. Every block is a Puck drawer
 * item; its Add button reaches the same add command.
 */
export function StudioCanvasPalette() {
  const { input, model } = useStudioCanvas();
  const palette = input.palette;
  // No page is open: the panel says so itself.
  if (palette === undefined || model.at === undefined || model.slot === undefined) return null;
  if (model.shown === undefined)
    return (
      <CanvasEmpty
        title="Blocks unavailable"
        description="Blocks can be added once this page has a compiled version, which follows shortly after your latest change is saved."
      />
    );
  if (palette.targets.kind !== "available")
    return (
      <CanvasEmpty
        title="Blocks unavailable"
        description={
          palette.targets.kind === "unsupported"
            ? "Blocks can't be added to this kind of page in Studio yet."
            : "This page is not in the current draft."
        }
      />
    );
  const at = model.at;
  return (
    <StudioBlockPalette
      targets={palette.targets.targets.filter(
        (target) => palette.owner === "layout" || target.area === at.key,
      )}
      editable={model.editable}
      owner={palette.owner}
      message={palette.message}
      onAdd={(request) => {
        palette.onAdd(request);
      }}
    />
  );
}

/**
 * The page canvas: the content area picker, the notices, the selection's actions and the
 * workspace's Puck preview, drawn as a device screen scaled inside its well. It unmounts with the
 * rail tabs that do not show a canvas.
 */
export function StudioCanvasView({
  zoom,
  onFitZoom,
  note,
}: Readonly<{
  /** Something the strip above the canvas says beside the canvas's own controls. */
  note?: ReactNode;
  /** Device width is preserved while the page frame scales inside the well. */
  zoom: number | "fit";
  /** Reports the measured Fit percentage to the workspace zoom controls. */
  onFitZoom: (percent: number) => void;
}>) {
  const { input, model, refusal } = useStudioCanvas();
  const {
    source,
    compiledSource,
    breakpoint,
    appearance,
    frame,
    viewer,
    disabled,
    compileFailure,
    platformThemeTokens,
    fieldInputControlReleases,
    readRecords,
    gridReads,
    onGridChange,
    arrangeGrid,
    onArrangeGrid,
    updating,
  } = input;
  const { at, page, slot, shown } = model;
  const [well, setWell] = useState<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  // The canvas is a device screen: the iframe is as wide as the chosen screen and as tall as the
  // well, in the iframe's own pixels. The zoom only scales the iframe as a whole.
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  const width = deviceWidths[breakpoint];
  const scale = zoom === "fit" ? Math.min(1, available.width / width) : zoom / 100;
  const { records, chooseControlValue, gridContext } = useStudioCanvasRecords({
    area: model.area,
    areaKey: at?.key ?? "",
    readRecords,
    catalogue: model.catalogue,
    compiledSource,
    originalSlot: model.originalSlot,
    slot,
    visible,
    gridReads,
    onGridChange,
    arrangeGrid: arrangeGrid === true,
    updating: updating === true,
    compileFailure,
  });
  const frameContext = useMemo(
    () =>
      platformThemeTokens === null || fieldInputControlReleases === null
        ? null
        : {
            frame,
            appearance,
            platformThemeTokens,
            registry: model.registry,
            fieldInputControlReleases,
            breakpoint,
            empty: slot?.items.length === 0,
          },
    [
      frame,
      appearance,
      platformThemeTokens,
      model.registry,
      fieldInputControlReleases,
      breakpoint,
      slot?.items.length,
    ],
  );
  useEffect(() => {
    if (well === null) return;
    // An area reads once it has been on screen; scrolling it away later does not read it again.
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting === true) setVisible(true);
    });
    observer.observe(well);
    return () => observer.disconnect();
  }, [well]);
  useEffect(() => {
    if (well === null) return;
    const measure = () => {
      const style = getComputedStyle(well);
      const measured = {
        width: well.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        height: well.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
      };
      setAvailable((current) =>
        current.width === measured.width && current.height === measured.height ? current : measured,
      );
      onFitZoom(Math.min(1, measured.width / width) * 100);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(well);
    return () => observer.disconnect();
  }, [well, width, onFitZoom]);

  if (at === undefined || page === undefined)
    return (
      <CanvasEmpty
        title="No content area"
        description="This page has no content area to arrange."
      />
    );
  if (slot === undefined)
    return (
      <CanvasEmpty
        title="Content area unavailable"
        description="Choose another page or content area to keep working."
      />
    );
  const picker =
    model.addresses.length < 2 ? null : (
      <div className="w-56 shrink-0">
        <Label htmlFor="studio-canvas-area" className="sr-only">
          Content area
        </Label>
        <StudioReferencePicker
          id="studio-canvas-area"
          value={at.key}
          onChange={model.chooseArea}
          options={model.addresses.map((candidate) => ({
            value: candidate.key,
            label: studioPageAreaLabel(source, page, candidate),
          }))}
        />
      </div>
    );
  if (shown === undefined || frameContext === null)
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4">
        {picker}
        <section className="space-y-3" aria-label="Page canvas">
          <CanvasEmpty
            title="Waiting for the canvas"
            description="Your page appears here after its latest saved changes compile."
          />
          {compileFailure == null ? null : <CompileFailureNotice failure={compileFailure} />}
          {refusal.length === 0 ? null : <p role="status">{refusal}</p>}
        </section>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <section
        className="flex min-h-0 flex-1 flex-col gap-2"
        aria-label="Page canvas"
        aria-busy={disabled}
      >
        {/* The screen size is chosen in Studio's canvas toolbar. One strip of fixed height: the
            content area, what the canvas does, and the selection's actions. */}
        <div className="flex h-9 shrink-0 items-center gap-3 px-4">
          {picker}
          {model.readOnlyCause !== undefined || breakpoint !== "desktop" ? (
            <Tooltip>
              <TooltipTrigger render={<Badge variant="secondary" className="shrink-0" />}>
                {model.readOnlyCause !== undefined
                  ? "Read-only"
                  : `${breakpoint === "tablet" ? "Tablet" : "Phone"} view`}
              </TooltipTrigger>
              <TooltipContent>
                {model.readOnlyCause !== undefined
                  ? "Shown read-only to keep it exactly as it is. Its blocks can still be changed in the inspector."
                  : `This is the ${breakpoint} layout and order. Rearrange blocks on Desktop.`}
              </TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    tabIndex={0}
                    role="img"
                    aria-label="How the canvas works"
                    className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                <Icon name="info" className="size-4" />
              </TooltipTrigger>
              <TooltipContent>
                Click a block to select it. Drag blocks to rearrange them.
              </TooltipContent>
            </Tooltip>
          )}
          <div className="flex min-w-0 flex-1 items-center gap-1">{note}</div>
          {arrangeGrid === true ? (
            <StudioArrangeBar
              arrangeable={model.arrangeable}
              onDone={() => onArrangeGrid?.(false)}
            />
          ) : (
            <StudioCanvasActions />
          )}
        </div>
        {compileFailure == null ? null : <CompileFailureNotice failure={compileFailure} />}
        {refusal.length === 0 ? null : (
          <Alert variant="destructive">
            <AlertTitle>Page change refused</AlertTitle>
            <AlertDescription>{refusal}</AlertDescription>
          </Alert>
        )}
        <div
          ref={setWell}
          data-vortex-studio-canvas-well=""
          className="min-h-0 flex-1 overflow-auto bg-muted/40 p-4 [scrollbar-gutter:stable]"
        >
          <div className="mx-auto" style={{ width: width * scale, height: available.height }}>
            <div
              data-vortex-studio-page-frame=""
              className="rounded-xl shadow-lg ring-1 ring-border"
              style={{
                width,
                height: scale > 0 ? available.height / scale : available.height,
                transform: `scale(${scale > 0 ? scale : 1})`,
                transformOrigin: "0 0",
                visibility: available.width === 0 ? "hidden" : "visible",
              }}
            >
              <StudioCanvasCompiledSettings settings={model.compiledSettings ?? {}}>
                <StudioCanvasRecordsProvider records={records}>
                  <StudioCanvasControlsProvider onValue={chooseControlValue}>
                    <StudioCanvasViewerProvider viewer={viewer ?? null}>
                      <StudioCanvasGridContext.Provider value={gridContext}>
                        <StudioCanvasFrameProvider value={frameContext}>
                          <Puck.Preview id="vortex-studio-canvas" />
                        </StudioCanvasFrameProvider>
                      </StudioCanvasGridContext.Provider>
                    </StudioCanvasViewerProvider>
                  </StudioCanvasControlsProvider>
                </StudioCanvasRecordsProvider>
              </StudioCanvasCompiledSettings>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/** The on-canvas state of the Arrange grid columns mode, in the bar above the canvas. */
function StudioArrangeBar({
  arrangeable,
  onDone,
}: Readonly<{ arrangeable: boolean; onDone: () => void }>) {
  return (
    <div role="status" className="flex min-w-0 items-center gap-2">
      <Icon name="table-columns" aria-hidden="true" />
      <p className="min-w-0 truncate text-sm">
        {arrangeable
          ? "Arranging grid columns: drag edges to resize, headers to move."
          : "No data grid with columns to arrange on this page."}
      </p>
      <Button type="button" size="sm" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

const tokenLabel = (key: string): string =>
  key.replace(/_/gu, " ").replace(/^./u, (first) => first.toUpperCase());

function CompileFailureNotice({ failure }: Readonly<{ failure: StudioCompileFailure }>) {
  const alias = failure.blockAlias;
  return (
    <Alert variant="destructive">
      <AlertTitle>This draft does not compile</AlertTitle>
      <AlertDescription>
        <p>Fix the draft to update the canvas. Your edits are preserved.</p>
        <Collapsible>
          <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" />}>
            Details
            <Icon name="chevron-down" />
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            Reason {failure.reasonCode} ({failure.family})
            {alias === undefined ? "" : `, block ${alias}`}
            {failure.tokenKey === undefined ? "" : `, ${tokenLabel(failure.tokenKey)}`}.
          </CollapsibleContent>
        </Collapsible>
      </AlertDescription>
    </Alert>
  );
}
