"use client";

import { createUsePuck, useGetPuck, type Overrides } from "@puckeditor/core";
import { sourceItemTree } from "@vortex/platform/schema";
import { Copy, Trash2 } from "lucide-react";
import {
  Children,
  cloneElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Button } from "../components/button";
import { ButtonGroup, ButtonGroupSeparator, ButtonGroupText } from "../components/button-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Icon } from "../icons";
import { StudioReasoned, studioLimitReason, type ReasonedTooltipProps } from "./studio-limit";
import { studioCanvasPermissionReason } from "./studio-canvas-permissions";
import { puckSelectedAlias, puckSelectorOf } from "./studio-canvas-data";
import { studioCanvasVisible, useStudioCanvasView } from "./studio-canvas-scale";
import { StudioCanvasIframe } from "./studio-canvas-root";
import { useStudioScreen } from "./studio-canvas-screen";
import { useStudioCanvas } from "./studio-puck-provider";

const usePuckSelector = createUsePuck();

/** Set by an action taken from the bar: the next bar to appear takes the keyboard focus. */
let focusNextBar = false;

type BarActionProps = Readonly<{
  label: string;
  reason: string | undefined;
  onAct: () => void;
  tooltip: ReasonedTooltipProps;
  /** The toolbar's roving tab stop: one button is in the Tab order, the arrow keys move it. */
  stop: boolean;
  onStop: () => void;
  children: ReactNode;
}>;

/** One action of the bar: its label as the tooltip, or its reason while it is unavailable. */
function BarAction({ label, reason, onAct, tooltip, stop, onStop, children }: BarActionProps) {
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      tabIndex={stop ? 0 : -1}
      onFocus={onStop}
      onClick={onAct}
    />
  );
  if (reason !== undefined)
    return (
      <StudioReasoned reason={reason} contentProps={tooltip}>
        {cloneElement(button, undefined, children)}
      </StudioReasoned>
    );
  return (
    <Tooltip>
      <TooltipTrigger render={button}>{children}</TooltipTrigger>
      <TooltipContent {...tooltip}>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The selected block's action bar, drawn in shadcn on the block itself. It is the content of
 * Puck's `componentOverlay` for the selected block, so it is given the block's own id and knows it
 * is the selected one, with no reading of Puck's markup and no writing to its elements. The block's
 * name comes first, then select-parent, Duplicate and Delete. An action Puck's permissions forbid
 * stays in the bar, unavailable, and says why on hover and on keyboard focus.
 *
 * The page frame is scaled by the workspace, so the bar counter-scales to keep its size on screen,
 * and it moves along the block's edge to stay inside what the well shows (and below the block when
 * there is no room above it). Alt+F10 moves keyboard focus to it, and inside it the arrow keys move
 * between the actions.
 */
function StudioActionBar({ id, type }: Readonly<{ id: string; type: string }>) {
  const getPuck = useGetPuck();
  const { input, model, references } = useStudioCanvas();
  const { breakpoint, label: screenLabel } = useStudioScreen();
  const view = useStudioCanvasView();
  // The overlay is not clickable by itself; while a block is dragged the bar lets the pointer through.
  const dragging = usePuckSelector((state) => state.appState.ui.isDragging);
  const anchor = useRef<HTMLDivElement | null>(null);
  const [stopped, setStopped] = useState(0);
  const [shift, setShift] = useState(0);
  const [below, setBelow] = useState(false);
  // The well scrolled: what it shows changed, so the bar is placed again.
  const [scrolled, setScrolled] = useState(0);
  useEffect(() => {
    const well = view.well;
    if (well === null) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setScrolled((count) => count + 1));
    };
    well.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      well.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [view.well]);
  const puck = getPuck();
  const permissions = puck.getPermissions({ item: puck.getItemById(id) ?? null });
  const parent = puck.getParentById(id);
  // The name the outline and the inspector use: the block's own item ("Button: Open").
  const item =
    model.slot === undefined
      ? undefined
      : sourceItemTree(model.slot.items).find((candidate) => candidate.props.id === id);
  const name =
    (item === undefined
      ? undefined
      : input.describePlacement({
          block: item.props.vortex.block,
          settings: Object.fromEntries(
            Object.entries(item.props).filter(
              ([key, value]) => key !== "id" && key !== "vortex" && !Array.isArray(value),
            ),
          ),
        })) ??
    puck.config.components[type]?.label ??
    type;
  // Why a forbidden action is unavailable when the draft itself names no reason.
  const unavailable =
    breakpoint !== "desktop"
      ? `This is the ${screenLabel.toLowerCase()} view. Change blocks on Desktop.`
      : model.readOnlyCause !== undefined
        ? "This page is shown read-only, so its blocks can't be changed here."
        : !input.canvasShown
          ? "The canvas is not on show."
          : input.disabled
            ? (input.disabledReason ?? "Studio is busy; try again in a moment.")
            : "This isn't available for this block.";
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
  const inverse = view.scale > 0 ? 1 / view.scale : 1;
  const visible = studioCanvasVisible(view);
  // A tooltip stays inside what the well shows, and is the size of the bar on screen.
  const tooltip: ReasonedTooltipProps = {
    style: { scale: inverse },
    collisionPadding: 4,
    ...(visible === undefined
      ? {}
      : {
          collisionBoundary: {
            x: visible.left,
            y: visible.top,
            width: visible.right - visible.left,
            height: visible.bottom - visible.top,
          },
        }),
  };

  // Place the bar on its block: counter-scaled, inside the visible part of the page frame.
  useLayoutEffect(() => {
    const bar = anchor.current;
    const block = bar?.parentElement;
    const shown = studioCanvasVisible(view);
    if (bar == null || block == null || shown === undefined) return;
    const box = bar.getBoundingClientRect();
    const blockBox = block.getBoundingClientRect();
    // `box` includes the shift in force, so the unshifted edges are found first.
    const left = box.left - shift;
    const right = box.right - shift;
    let next = 0;
    if (right > shown.right) next = shown.right - right;
    if (left + next < shown.left) next = shown.left - left;
    const rounded = Math.round(next);
    if (rounded !== shift) setShift(rounded);
    const flip = blockBox.top - box.height < shown.top;
    if (flip !== below) setBelow(flip);
  }, [id, view, scrolled, name, shift, below]);
  // The block resizes (a drag, a setting): the bar follows its edges.
  useEffect(() => {
    const block = anchor.current?.parentElement;
    if (block == null) return;
    const observer = new ResizeObserver(() => setScrolled((count) => count + 1));
    observer.observe(block);
    return () => observer.disconnect();
  }, [id]);

  const buttons = () => [...(anchor.current?.querySelectorAll("button") ?? [])];
  // Alt+F10 moves focus to the selected block's bar, as the toolbar convention has it.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!event.altKey || event.key !== "F10") return;
      event.preventDefault();
      buttons()[stopped]?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stopped]);
  // The bar of the block an action chose takes the focus, so the keyboard does not start over.
  useEffect(() => {
    if (!focusNextBar) return;
    focusNextBar = false;
    buttons()[0]?.focus({ preventScroll: true });
  }, [id]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = buttons();
    const at = all.findIndex((button) => button === event.target);
    if (at < 0) return;
    const to =
      event.key === "ArrowRight"
        ? (at + 1) % all.length
        : event.key === "ArrowLeft"
          ? (at - 1 + all.length) % all.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? all.length - 1
              : -1;
    if (to < 0) return;
    event.preventDefault();
    all[to]?.focus();
  };

  // What the action acts on is found in the data, and must be this bar's own block.
  const act = (action: "parent" | "duplicate" | "remove") => {
    const current = getPuck();
    const content = current.appState.data.content;
    const selector = puckSelectorOf(content, id);
    if (
      selector === undefined ||
      puckSelectedAlias(content, selector) !== id ||
      current.getItemBySelector(selector)?.props.id !== id
    ) {
      console.info(`[studio] the action bar of '${id}' found the block moved; nothing was changed`);
      return;
    }
    focusNextBar = true;
    if (action === "parent") {
      const parentSelector =
        parent === undefined ? undefined : puckSelectorOf(content, parent.props.id);
      if (parentSelector !== undefined)
        current.dispatch({ type: "setUi", ui: { itemSelector: parentSelector } });
      return;
    }
    const item = current.getItemBySelector(selector);
    const allowed = current.getPermissions({ item: item ?? null });
    if (!(action === "duplicate" ? allowed.duplicate : allowed.delete)) return;
    if (action === "duplicate") {
      current.dispatch({
        type: "duplicate",
        sourceIndex: selector.index,
        sourceZone: selector.zone,
      });
      return;
    }
    // After a delete the selection goes to the next block beside it, or the one before, or the parent.
    const zone = { zone: selector.zone };
    const neighbour =
      current.getItemBySelector({ ...zone, index: selector.index + 1 }) ??
      current.getItemBySelector({ ...zone, index: selector.index - 1 }) ??
      parent;
    current.dispatch({ type: "remove", index: selector.index, zone: selector.zone });
    const after = getPuck();
    const nextSelector =
      neighbour === undefined
        ? undefined
        : puckSelectorOf(after.appState.data.content, neighbour.props.id);
    if (nextSelector !== undefined)
      after.dispatch({ type: "setUi", ui: { itemSelector: nextSelector } });
  };
  const stop = (index: number) => ({ stop: stopped === index, onStop: () => setStopped(index) });
  const style: CSSProperties = {
    scale: inverse,
    translate: `${shift}px 0`,
    transformOrigin: below ? "left top" : "left bottom",
  };
  const first = parent === undefined ? 0 : 1;
  return (
    <div
      ref={anchor}
      data-vortex-canvas-action-bar-anchor=""
      className={`absolute left-0 z-20 ${below ? "top-full pt-2" : "bottom-full pb-2"} ${dragging ? "pointer-events-none" : "pointer-events-auto"}`}
      style={style}
    >
      <ButtonGroup
        role="toolbar"
        aria-label={`${name} actions`}
        aria-keyshortcuts="Alt+F10"
        data-vortex-canvas-action-bar=""
        // A click in the bar is the bar's own, never a click on the page behind it.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        className="border bg-popover text-popover-foreground shadow-md"
      >
        <ButtonGroupText className="max-w-56 truncate">{name}</ButtonGroupText>
        <ButtonGroupSeparator />
        {parent === undefined ? null : (
          <BarAction
            label="Select parent block"
            reason={undefined}
            tooltip={tooltip}
            onAct={() => act("parent")}
            {...stop(0)}
          >
            <Icon name="arrow-up" />
          </BarAction>
        )}
        <BarAction
          label="Duplicate block"
          reason={duplicateReason}
          tooltip={tooltip}
          onAct={() => act("duplicate")}
          {...stop(first)}
        >
          <Copy aria-hidden="true" />
        </BarAction>
        <BarAction
          label="Delete block"
          reason={deleteReason}
          tooltip={tooltip}
          onAct={() => act("remove")}
          {...stop(first + 1)}
        >
          <Trash2 aria-hidden="true" />
        </BarAction>
      </ButtonGroup>
    </div>
  );
}

/**
 * The overlay Puck draws on every block: its own outline, and the action bar on the selected one.
 * `componentOverlay` is given the block's id and whether it is selected, which the `actionBar`
 * override is not.
 */
function StudioComponentOverlay({
  children,
  isSelected,
  componentId,
  componentType,
}: Readonly<{
  children: ReactNode;
  isSelected: boolean;
  componentId: string;
  componentType: string;
}>) {
  return (
    <>
      {children}
      {isSelected ? <StudioActionBar id={componentId} type={componentType} /> : null}
    </>
  );
}

/**
 * Puck's overlay and iframe, drawn by Studio. Puck's own action bar is replaced with nothing: its
 * `children` (Puck's Duplicate and Delete, and the rich-text menu of an inline text field) are
 * deliberately not drawn, because the bar above is the one place a block's actions are. Studio's
 * blocks have no inline rich-text field; one that is added needs its menu drawn here.
 */
/**
 * Puck's own bar draws nothing. What it would have drawn (its Duplicate and Delete) is left out on
 * purpose; anything else in it, such as an inline rich-text menu, is a block Studio does not have,
 * so it is reported once instead of silently missing.
 */
let reportedBarContent = false;
function StudioPuckActionBar({ children }: Readonly<{ children?: ReactNode }>) {
  const extra = Children.toArray(children).length > 2;
  useEffect(() => {
    if (!extra || reportedBarContent) return;
    reportedBarContent = true;
    console.error(
      "[studio] Puck's action bar holds more than Duplicate and Delete; its other actions are not drawn",
    );
  }, [extra]);
  return <></>;
}

export const studioCanvasOverrides: Partial<Overrides> = {
  actionBar: StudioPuckActionBar,
  componentOverlay: StudioComponentOverlay,
  iframe: StudioCanvasIframe,
};
