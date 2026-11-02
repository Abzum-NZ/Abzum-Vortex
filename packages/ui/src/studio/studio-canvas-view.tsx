"use client";

import { Puck } from "@puckeditor/core";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "../components/alert";
import { Badge } from "../components/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Button } from "../components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/empty";
import { Skeleton } from "../components/skeleton";
import { Label } from "../components/label";
import { Icon } from "../icons";
import { studioPageAreaLabel } from "./application-page-layout";
import type { StudioCompileFailure } from "./compile-failure";
import { StudioCanvasActions } from "./studio-canvas-actions";
import { useStudioScreen } from "./studio-canvas-screen";
import { StudioReferencePicker } from "./studio-reference-picker";
import { useStudioCanvas } from "./studio-puck-provider";

function CanvasEmpty({ title, description }: Readonly<{ title: string; description: string }>) {
  return (
    <Empty role="status" className="min-h-64 flex-1">
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
 * The canvas's first paint: the page's shape where the canvas will draw, until the saved draft's
 * first projection arrives. Without it the centre is blank for the seconds a compile and its
 * records take, which reads as an empty page.
 */
export function StudioCanvasSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading the canvas"
      aria-busy="true"
      data-vortex-canvas-skeleton=""
      className="flex min-h-0 flex-1 flex-col gap-3 p-4"
    >
      <Skeleton className="h-8 w-56 max-w-full" />
      <Skeleton className="h-4 w-80 max-w-full" />
      <div className="flex min-h-0 flex-1 flex-col gap-3 pt-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
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
  const { breakpoint, label, width } = useStudioScreen();
  const {
    source,
    disabled,
    compileFailure,
    platformThemeTokens,
    fieldInputControlReleases,
    arrangeGrid,
    onArrangeGrid,
  } = input;
  const { at, page, slot, shown } = model;
  const [well, setWell] = useState<HTMLDivElement | null>(null);
  // The canvas is a device screen: the iframe is as wide as the chosen screen and as tall as the
  // well, in the iframe's own pixels. The zoom only scales the iframe as a whole.
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  const scale = zoom === "fit" ? Math.min(1, available.width / width) : zoom / 100;
  useEffect(() => {
    if (well === null) return;
    // The well's own content box, fractional and without its padding or scrollbar gutter: Fit
    // scales to exactly this, so the screen can never be wider than the well.
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentBoxSize[0];
      if (box === undefined) return;
      const measured = { width: box.inlineSize, height: box.blockSize };
      setAvailable((current) =>
        current.width === measured.width && current.height === measured.height ? current : measured,
      );
      onFitZoom(Math.min(1, measured.width / width) * 100);
    });
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
  if (shown === undefined || platformThemeTokens === null || fieldInputControlReleases === null)
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
                {model.readOnlyCause !== undefined ? "Read-only" : `${label} view`}
              </TooltipTrigger>
              <TooltipContent>
                {model.readOnlyCause !== undefined
                  ? "Shown read-only to keep it exactly as it is. Its blocks can still be changed in the inspector."
                  : `This is the ${label.toLowerCase()} layout and order. Rearrange blocks on Desktop.`}
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
                    className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground"
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
          // Fit shows the whole screen, so it never has anything to scroll to.
          className={`min-h-0 flex-1 bg-muted/40 p-4 [scrollbar-gutter:stable_both-edges] ${zoom === "fit" ? "overflow-hidden" : "overflow-auto"}`}
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
              <Puck.Preview id="vortex-studio-canvas" />
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
