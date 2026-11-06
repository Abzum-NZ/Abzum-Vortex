import { createContext, useContext, useMemo } from "react";
import type { SourceItem, StudioPlacementDescriber } from "@vortex/platform/schema";
import type { StudioCanvasModel } from "./studio-canvas-model";
import type { StudioBlockActions, StudioPuckInput } from "./studio-puck-provider";
import { useStableValue } from "./use-studio-canvas-channel";

/**
 * What the readers of the canvas take from the workspace's Puck editor, each from a value of its
 * own. A reader sees a change of only what it reads, so a reader that does not draw on every edit
 * (the Blocks panel while another tab is shown, the canvas's iframe override) is not drawn on
 * every edit: before, one value carried the whole per-edit input and every reader redrew with it.
 * A new reader takes one of these; a value that changes with each edit does not belong in
 * `StudioCanvasStatus`.
 */

/**
 * The state of the canvas that changes only when the page, the screen, the selection's place or
 * the draft's availability does: the same object (by value) through every edit of a block's text.
 */
export type StudioCanvasStatus = Readonly<{
  /** Whether the page or layout to show exists in the draft. */
  open: boolean;
  /** What the canvas shows the blocks of. */
  owner: "page" | "layout";
  /** Whether the page has a compiled version to draw. */
  ready: boolean;
  /** The draft takes no change now. */
  disabled: boolean;
  /** Why, when `disabled` says it does not take one. */
  disabledReason: string | undefined;
  /** Whether the open rail tab shows the canvas. */
  canvasShown: boolean;
  /** Why the page is shown read-only; `undefined` when it can be arranged. */
  readOnlyCause: string | undefined;
  /** Whether the page takes every edit: arrangeable and on the desktop screen. */
  editable: boolean;
  /** Whether a data grid of the page has columns the person can arrange. */
  arrangeable: boolean;
  /** The guided steps of the open page, or none. */
  steps: readonly Readonly<{ id: string; name: string }>[];
  /** The step on the canvas; `undefined` on a page without steps. */
  step: string | undefined;
  chooseStep: (step: string) => void;
  /** Why the last canvas change was refused; empty while the draft shows as it was edited. */
  refusal: string;
  /** The page slot address keys of the zones the canvas shows. */
  zoneKeys: ReadonlySet<string>;
  /** Puck's root slot of a page slot address key; `undefined` for the default zone. */
  slotOfZoneKey: (key: string) => string | undefined;
  /** The zone the Blocks panel adds to unless the person chose another. */
  defaultZoneKey: string | undefined;
}>;

export const StudioCanvasStatusContext = createContext<StudioCanvasStatus | null>(null);

/** The canvas's state; only inside the workspace's Puck editor. */
export const useStudioCanvasStatus = (): StudioCanvasStatus => {
  const status = useContext(StudioCanvasStatusContext);
  if (status === null) throw new Error("STUDIO_CANVAS_STATUS_MISSING: used outside the canvas");
  return status;
};

/**
 * What the selected block's action bar names the block and its Duplicate from. The bar is drawn
 * for the one selected block and follows the page, so these change with each edit.
 */
export type StudioCanvasBar = Readonly<{
  describePlacement: StudioPlacementDescriber;
  /** Every block of the page data on the canvas, in every zone. */
  items: readonly SourceItem[];
  /** The blocks the application holds, which the composition limit counts. */
  placed: number;
  blockActions: StudioBlockActions;
}>;

export const StudioCanvasBarContext = createContext<StudioCanvasBar | null>(null);

/** The action bar's inputs; only inside the workspace's Puck editor. */
export const useStudioCanvasBar = (): StudioCanvasBar => {
  const bar = useContext(StudioCanvasBarContext);
  if (bar === null) throw new Error("STUDIO_CANVAS_BAR_MISSING: used outside the canvas");
  return bar;
};

/**
 * The blocks that are a data grid or hold one, read when asked: the iframe override decides
 * whether a slot is drawn now from it and never needs to be drawn again for a new set.
 */
export const StudioGridHoldersContext = createContext<(() => ReadonlySet<string>) | null>(null);

/** The grid holders' reader; only inside the workspace's Puck editor. */
export const useStudioGridHolders = (): (() => ReadonlySet<string>) => {
  const read = useContext(StudioGridHoldersContext);
  if (read === null) throw new Error("STUDIO_GRID_HOLDERS_MISSING: used outside the canvas");
  return read;
};

/**
 * The canvas's state, the same object while each part of it is: the steps are kept by value (they
 * are read from the page, a new object after every edit of it) and every other part is a string, a
 * flag or a function the model keeps for as long as the page, the screen or the selection does.
 */
export const useStudioCanvasStatusValue = (
  input: StudioPuckInput,
  model: StudioCanvasModel,
  refusal: string,
): StudioCanvasStatus => {
  const steps = useStableValue(model.steps);
  const { disabled, disabledReason, canvasShown } = input;
  const { open, owner, readOnlyCause, editable, arrangeable, step, chooseStep } = model;
  const { zoneKeys, slotOfZoneKey, defaultZoneKey } = model;
  const ready = model.shown !== undefined;
  return useMemo(
    () => ({
      open,
      owner,
      ready,
      disabled,
      disabledReason,
      canvasShown,
      readOnlyCause,
      editable,
      arrangeable,
      steps,
      step,
      chooseStep,
      refusal,
      zoneKeys,
      slotOfZoneKey,
      defaultZoneKey,
    }),
    [
      open,
      owner,
      ready,
      disabled,
      disabledReason,
      canvasShown,
      readOnlyCause,
      editable,
      arrangeable,
      steps,
      step,
      chooseStep,
      refusal,
      zoneKeys,
      slotOfZoneKey,
      defaultZoneKey,
    ],
  );
};
