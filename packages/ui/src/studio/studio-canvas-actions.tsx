"use client";

import { createUsePuck, useGetPuck, type Overrides } from "@puckeditor/core";
import { Copy, GripVertical, Trash2 } from "lucide-react";
import {
  cloneElement,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Button } from "../components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Icon } from "../icons";
import { StudioReasoned, studioLimitReason } from "./studio-limit";
import { studioCanvasPermissionReason } from "./studio-canvas-permissions";
import { StudioCanvasIframe } from "./studio-canvas-root";
import { useStudioCanvasScale } from "./studio-canvas-scale";
import { useStudioScreen } from "./studio-canvas-screen";
import { useStudioCanvas } from "./studio-puck-provider";

const usePuckSelector = createUsePuck();

/** The action's control: its label as the tooltip, or its reason while it is unavailable. */
function BarAction({
  label,
  reason,
  onAct,
  tooltipStyle,
  children,
  buttonRef,
}: Readonly<{
  label: string;
  reason: string | undefined;
  onAct: () => void;
  tooltipStyle: CSSProperties;
  children: ReactNode;
  buttonRef?: ((element: Element | null) => void) | undefined;
}>) {
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      onClick={onAct}
      {...(buttonRef === undefined ? {} : { ref: buttonRef })}
    />
  );
  if (reason !== undefined)
    return (
      <StudioReasoned reason={reason} contentStyle={tooltipStyle}>
        {cloneElement(button, undefined, children)}
      </StudioReasoned>
    );
  return (
    <Tooltip>
      <TooltipTrigger render={button}>{children}</TooltipTrigger>
      <TooltipContent style={tooltipStyle}>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Puck draws one action bar for every block under the pointer, but only the selected block's is
 * shown (its overlay is transparent otherwise). Only that one is drawn, so a bar nobody can see
 * never takes a tab stop.
 */
function useShownBar(dragging: boolean) {
  const root = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);
  const holder = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    // While a drag is in progress the bar stays as it was.
    if (dragging) return;
    const overlay = (root.current ?? holder.current)?.parentElement?.parentElement;
    const visible =
      overlay != null &&
      overlay.ownerDocument.defaultView?.getComputedStyle(overlay).opacity !== "0";
    setShown((current) => (current === visible ? current : visible));
  });
  // Puck sets the bar at the right edge of its block. A page wider than the well (Desktop at 100%
  // or more) would carry the bar of a full-width block out of view, so it sits at the block's left
  // edge, and at its right edge only where the bar would leave the page there. These are the same
  // properties Puck itself moves when the bar leaves the page on the left.
  useLayoutEffect(() => {
    const bar = root.current;
    const placed = bar?.parentElement;
    if (bar == null || placed == null) return;
    placed.style.right = "auto";
    placed.style.left = "0px";
    bar.style.transformOrigin = "left bottom";
    if (bar.getBoundingClientRect().right > bar.ownerDocument.documentElement.clientWidth) {
      placed.style.left = "auto";
      placed.style.right = "0px";
      bar.style.transformOrigin = "right bottom";
    }
  });
  return { root, holder, shown };
}

/**
 * Puck's action bar for the selected block, drawn in shadcn. The block's name comes first, then
 * select-parent, Duplicate and Delete, and the drag handle. An action Puck's permissions forbid
 * stays in the bar, unavailable, and says why on hover and on keyboard focus. The bar is inside
 * the scaled page frame, so it counter-scales to stay the same size on screen.
 */
function StudioActionBar({
  label,
  dragHandleRef,
}: Readonly<{
  label?: string | undefined;
  dragHandleRef?: ((element: Element | null) => void) | undefined;
}>) {
  const selected = usePuckSelector((state) => state.selectedItem);
  const dragging = usePuckSelector((state) => state.appState.ui.isDragging);
  const getPuck = useGetPuck();
  const { input, model, references } = useStudioCanvas();
  const { breakpoint, label: screenLabel } = useStudioScreen();
  const scale = useStudioCanvasScale();
  const { root, holder, shown } = useShownBar(dragging);
  if (selected === null) return <div ref={holder} hidden />;
  if (!shown) return <div ref={holder} hidden />;
  const inverse = scale > 0 ? 1 / scale : 1;
  const counterScale: CSSProperties = { scale: inverse };
  const tooltipStyle: CSSProperties = { scale: inverse };
  const id = selected.props.id;
  const puck = getPuck();
  const permissions = puck.getPermissions({ item: selected });
  const parent = puck.getParentById(id);
  const name = label ?? puck.config.components[selected.type]?.label ?? selected.type;
  // Why a forbidden action is unavailable when the draft itself names no reason.
  const unavailable =
    breakpoint !== "desktop"
      ? `This is the ${screenLabel.toLowerCase()} view. Change blocks on Desktop.`
      : model.readOnlyCause !== undefined
        ? "This page is shown read-only, so its blocks can't be changed here."
        : "Studio is busy; try again in a moment.";
  const reasonFor = (reference: string | undefined, allowed: boolean) =>
    reference ?? (allowed ? undefined : unavailable);
  // A full application cannot take another block: Duplicate says so instead of failing on save.
  const placed =
    input.palette?.targets.kind === "available"
      ? (input.palette.targets.targets[0]?.placed ?? 0)
      : 0;
  const duplicateReason = reasonFor(
    studioLimitReason("compositionPlacements", placed) ??
      studioCanvasPermissionReason(references, id, "duplicate"),
    permissions.duplicate,
  );
  const deleteReason = reasonFor(
    studioCanvasPermissionReason(references, id, "delete"),
    permissions.delete,
  );
  const dragReason = reasonFor(
    studioCanvasPermissionReason(references, id, "drag"),
    permissions.drag,
  );
  const act = (action: "duplicate" | "remove") => {
    const current = getPuck();
    const item = current.selectedItem;
    if (item === null || item.props.id !== id) return;
    const allowed = current.getPermissions({ item });
    if (!(action === "duplicate" ? allowed.duplicate : allowed.delete)) return;
    const selector = current.getSelectorForId(item.props.id);
    if (selector === undefined) return;
    current.dispatch(
      action === "duplicate"
        ? { type: "duplicate", sourceIndex: selector.index, sourceZone: selector.zone }
        : { type: "remove", index: selector.index, zone: selector.zone },
    );
  };
  return (
    <div
      ref={root}
      role="toolbar"
      aria-label={`${name} actions`}
      data-vortex-canvas-action-bar=""
      // A click in the bar is the bar's own, never a click on the page behind it.
      onClick={(event) => event.stopPropagation()}
      className="flex w-max cursor-default items-center gap-0.5 rounded-lg border bg-popover p-0.5 text-popover-foreground shadow-md"
      style={counterScale}
    >
      <span className="max-w-40 truncate pr-1 pl-2 text-sm font-medium">{name}</span>
      {parent === undefined ? null : (
        <BarAction
          label="Select parent block"
          reason={undefined}
          tooltipStyle={tooltipStyle}
          onAct={() => {
            const current = getPuck();
            const selector = current.getSelectorForId(parent.props.id);
            if (selector !== undefined)
              current.dispatch({ type: "setUi", ui: { itemSelector: selector } });
          }}
        >
          <Icon name="arrow-up" />
        </BarAction>
      )}
      <BarAction
        label="Duplicate block"
        reason={duplicateReason}
        tooltipStyle={tooltipStyle}
        onAct={() => act("duplicate")}
      >
        <Copy aria-hidden="true" />
      </BarAction>
      <BarAction
        label="Delete block"
        reason={deleteReason}
        tooltipStyle={tooltipStyle}
        onAct={() => act("remove")}
      >
        <Trash2 aria-hidden="true" />
      </BarAction>
      <BarAction
        label="Drag block"
        reason={dragReason}
        tooltipStyle={tooltipStyle}
        onAct={() => undefined}
        buttonRef={dragHandleRef}
      >
        <GripVertical aria-hidden="true" />
      </BarAction>
    </div>
  );
}

/** Puck's action bar and iframe, both drawn by Studio: the bar in shadcn, the frame from the host. */
export const studioCanvasOverrides: Partial<Overrides> = {
  actionBar: StudioActionBar,
  iframe: StudioCanvasIframe,
};
