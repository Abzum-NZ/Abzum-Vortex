"use client";

import { ActionBar, createUsePuck, useGetPuck, type Overrides } from "@puckeditor/core";
import { StudioOutlineRegion } from "./studio-puck-outline";
import { Copy } from "lucide-react";
import {
  Children,
  cloneElement,
  isValidElement,
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
import { Reasoned, type ReasonedTooltipProps } from "../components/reasoned";
import { studioLimitReason } from "./studio-limit";
import { studioCanvasPermissionReason } from "./studio-canvas-permissions";
import { puckNeighbourOf, puckSelectorOf, studioBlockName } from "./studio-canvas-data";
import { StudioCanvasMore, type StudioMoreChoice } from "./studio-canvas-more";
import { studioCanvasVisible, useStudioCanvasView } from "./studio-canvas-scale";
import { StudioCanvasIframe } from "./studio-canvas-root";
import { useStudioScreen } from "./studio-canvas-screen";
import { useStudioCanvasChannel } from "./studio-canvas-metadata";
import { useStudioCanvas, useStudioCanvasDragging } from "./studio-puck-provider";

const usePuckSelector = createUsePuck();

/**
 * The bar an action chose takes the keyboard focus when it appears: the bar of that block, or of
 * the next one to be selected (`id` null, as after Duplicate, whose copy gets its id from the
 * draft) within a moment. Never left set: it lapses.
 */
let focusBar: { id: string | null; until: number } | null = null;
const focusBarOn = (id: string | null) => {
  focusBar = { id, until: Date.now() + 1500 };
};

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
      <Reasoned reason={reason} contentProps={tooltip}>
        {cloneElement(button, undefined, children)}
      </Reasoned>
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
 * name comes first, then select-parent, Duplicate and the More menu (Move to, Wrap, Used in and
 * Remove, the one delete beside the Delete key). An action Puck's permissions forbid
 * stays in the bar, unavailable, and says why on hover and on keyboard focus.
 *
 * The page frame is scaled by the workspace, so the bar counter-scales to keep its size on screen,
 * and it moves along the block's edge to stay inside what the well shows (and below the block when
 * there is no room above it). Alt+F10 moves keyboard focus to it, and inside it the arrow keys move
 * between the actions.
 */
function StudioActionBar({ id, type }: Readonly<{ id: string; type: string }>) {
  const getPuck = useGetPuck();
  const { input, model } = useStudioCanvas();
  const { references } = useStudioCanvasChannel();
  const { breakpoint, label: screenLabel } = useStudioScreen();
  const view = useStudioCanvasView();
  // While a block is dragged the bar lets the pointer through.
  const dragging = useStudioCanvasDragging();
  // The page changed (an Undo, an insert above): a block may have moved without a new size.
  const data = usePuckSelector((state) => state.appState.data);
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
  // The global permissions (read-only, the canvas off, a full application); a block's own reasons
  // are the references.
  const permissions = usePuckSelector((state) => state.getPermissions());
  const parent = puck.getParentById(id);
  // The name the outline and the inspector use: the block's own item ("Button: Open").
  const name =
    studioBlockName(input.describePlacement, model.items, id) ??
    puck.config.components[type]?.label ??
    type;
  // Why a forbidden action is unavailable when the draft itself names no reason.
  const knownCause =
    breakpoint !== "desktop"
      ? `This is the ${screenLabel.toLowerCase()} view. Change blocks on Desktop.`
      : model.readOnlyCause !== undefined
        ? "This page is shown read-only, so its blocks can't be changed here."
        : !input.canvasShown
          ? "The canvas is not on show."
          : input.disabled
            ? (input.disabledReason ?? "Studio is busy; try again in a moment.")
            : undefined;
  const unavailable = knownCause ?? "This isn't available for this block.";
  const reasonFor = (reference: string | undefined, permitted: boolean) =>
    reference ?? (permitted ? undefined : unavailable);
  // A full application cannot take another block: Duplicate says so instead of failing on save.
  const placed =
    input.palette?.targets.kind === "available"
      ? (input.palette.targets.targets[0]?.placed ?? 0)
      : 0;
  const duplicateNamed =
    studioLimitReason("compositionPlacements", placed) ??
    studioCanvasPermissionReason(references, id, "duplicate");
  const deleteNamed = studioCanvasPermissionReason(references, id, "delete");
  const duplicateReason = reasonFor(duplicateNamed, permissions.duplicate);
  const deleteReason = reasonFor(deleteNamed, permissions.delete);
  const moveNamed = studioCanvasPermissionReason(references, id, "drag");
  const moveReason = reasonFor(moveNamed, permissions.drag);
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
    // Studio's own element around the bar, as big as the block (it fills Puck's overlay of it).
    const block = bar?.closest("[data-vortex-canvas-overlay]");
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
  }, [id, view, scrolled, name, shift, below, data]);
  // The block resizes (a drag, a setting), or the page does (content above it arrives and moves it
  // down): the bar follows its edges.
  useEffect(() => {
    const block = anchor.current?.closest("[data-vortex-canvas-overlay]");
    if (block == null) return;
    const observer = new ResizeObserver(() => setScrolled((count) => count + 1));
    observer.observe(block);
    observer.observe(block.ownerDocument.body);
    return () => observer.disconnect();
  }, [id]);

  const buttons = () => [...(anchor.current?.querySelectorAll("button") ?? [])];
  // Alt+F10 moves focus to the selected block's bar, as the toolbar convention has it. A key
  // pressed while focus is inside the canvas frame reaches only its document, so both are heard.
  useEffect(() => {
    const own = anchor.current?.ownerDocument;
    const documents = own === undefined || own === document ? [document] : [document, own];
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!event.altKey || event.key !== "F10") return;
      event.preventDefault();
      buttons()[stopped]?.focus();
    };
    for (const target of documents) target.addEventListener("keydown", onKey);
    return () => {
      for (const target of documents) target.removeEventListener("keydown", onKey);
    };
  }, [stopped]);
  // The bar of the block an action chose takes the focus, so the keyboard does not start over.
  useEffect(() => {
    if (
      focusBar === null ||
      Date.now() > focusBar.until ||
      (focusBar.id !== null && focusBar.id !== id)
    )
      return;
    focusBar = null;
    buttons()[0]?.focus({ preventScroll: true });
  }, [id]);
  // A bar that goes away with the keyboard focus inside it (the Delete key pressed on its block)
  // hands the focus to the next bar, as the bar's own actions do.
  useLayoutEffect(() => {
    const own = anchor.current;
    return () => {
      if (own?.contains(own.ownerDocument.activeElement) === true) focusBarOn(null);
    };
  }, []);
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
  const act = (action: "parent" | "duplicate" | StudioMoreChoice) => {
    const current = getPuck();
    const data = current.appState.data;
    const selector = puckSelectorOf(data, id);
    if (selector === undefined || current.getItemBySelector(selector)?.props.id !== id) {
      console.info(`[studio] the action bar of '${id}' found the block moved; nothing was changed`);
      return;
    }
    if (action === "parent") {
      const parentSelector =
        parent === undefined ? undefined : puckSelectorOf(data, parent.props.id);
      if (parent !== undefined && parentSelector !== undefined) {
        focusBarOn(parent.props.id);
        current.dispatch({ type: "setUi", ui: { itemSelector: parentSelector } });
      }
      return;
    }
    if (action === "move" || action === "wrap" || action === "usedIn") {
      input.blockActions.open(id, action);
      return;
    }
    if ((action === "duplicate" ? duplicateReason : deleteReason) !== undefined) return;
    if (action === "duplicate") {
      current.dispatch({
        type: "duplicate",
        sourceIndex: selector.index,
        sourceZone: selector.zone,
      });
      // Puck selects the copy; its bar takes the focus.
      focusBarOn(null);
      return;
    }
    // The selection goes to the neighbour (the provider sees to that for every removal).
    const neighbour = puckNeighbourOf(data, selector);
    if (neighbour !== undefined) focusBarOn(neighbour);
    current.dispatch({ type: "remove", index: selector.index, zone: selector.zone });
  };
  const stop = (index: number) => ({ stop: stopped === index, onStop: () => setStopped(index) });
  const style: CSSProperties = {
    scale: inverse,
    translate: `${shift}px 0`,
    transformOrigin: below ? "right top" : "right bottom",
    // Puck keeps an empty drag handle (16px wide on screen) at the block's top right corner; the bar
    // ends before it, so no action sits under it.
    right: 16 * inverse,
  };
  const first = parent === undefined ? 0 : 1;
  return (
    <div
      ref={anchor}
      data-vortex-canvas-action-bar-anchor=""
      className={`absolute z-20 ${below ? "top-full pt-2" : "bottom-full pb-2"} ${dragging ? "pointer-events-none" : "pointer-events-auto"}`}
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
        <StudioCanvasMore
          id={id}
          actions={input.blockActions}
          reasons={{ move: moveReason, wrap: knownCause, remove: deleteReason }}
          tooltip={tooltip}
          onChoose={act}
          {...stop(first + 1)}
        />
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
      {isSelected ? (
        <div data-vortex-canvas-overlay="" className="pointer-events-none absolute inset-0">
          <StudioActionBar id={componentId} type={componentType} />
        </div>
      ) : null}
    </>
  );
}

/**
 * Puck's own bar draws nothing. What it would have drawn (its Duplicate and Delete) is left out on
 * purpose; anything else in it, such as an inline rich-text menu, is a block Studio does not have,
 * so it is reported once instead of silently missing.
 */
let reportedBarContent = false;
function StudioPuckActionBar({ children }: Readonly<{ children?: ReactNode }>) {
  // Puck's own children are its Duplicate and Delete actions; anything else is content not drawn.
  const extra = Children.toArray(children).some(
    (child) => !isValidElement(child) || child.type !== ActionBar.Action,
  );
  useEffect(() => {
    if (!extra || reportedBarContent) return;
    reportedBarContent = true;
    console.error(
      "[studio] Puck's action bar holds content other than its Duplicate and Delete; it is not drawn",
    );
  }, [extra]);
  return <></>;
}

/**
 * Puck's overlay, iframe and outline, drawn by Studio: the outline in its labelled region, with
 * Studio's colours, height and edit lock.
 */
export const studioCanvasOverrides: Partial<Overrides> = {
  actionBar: StudioPuckActionBar,
  componentOverlay: StudioComponentOverlay,
  // Each setting field draws its own label, hint and message (StudioField): Puck's label is not drawn.
  fieldLabel: ({ children }) => <>{children}</>,
  iframe: StudioCanvasIframe,
  outline: StudioOutlineRegion,
};
