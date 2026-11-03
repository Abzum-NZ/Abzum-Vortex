"use client";

import { createContext, useContext } from "react";

/** The part of the page frame the person can see, in the frame's own pixels. */
export type StudioCanvasVisible = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
}>;

/**
 * How the workspace draws the page frame: the scale it is drawn at (1 is the page's own size) and
 * the scrolling well it sits in. Puck's own zoom is unused (the workspace scales the whole frame
 * from outside), so what is drawn on the canvas for the person, not for the page (the action bar
 * and the empty-slot labels), counter-scales by the scale and keeps inside what the well shows.
 */
export type StudioCanvasView = Readonly<{ scale: number; well: HTMLElement | null }>;

const CanvasViewContext = createContext<StudioCanvasView>({ scale: 1, well: null });

export const StudioCanvasViewProvider = CanvasViewContext.Provider;

export const useStudioCanvasView = (): StudioCanvasView => useContext(CanvasViewContext);

/**
 * What the well shows of the page frame, in the frame's pixels, from where the well and the frame
 * are on screen. `undefined` when the well or the frame is not there.
 */
export const studioCanvasVisible = (view: StudioCanvasView): StudioCanvasVisible | undefined => {
  const frame = view.well?.querySelector("[data-vortex-studio-page-frame]");
  if (view.well == null || frame == null || view.scale <= 0) return undefined;
  const well = view.well.getBoundingClientRect();
  const page = frame.getBoundingClientRect();
  const { scale } = view;
  return {
    left: Math.max(0, (well.left - page.left) / scale),
    top: Math.max(0, (well.top - page.top) / scale),
    right: Math.min(page.width / scale, (well.left + view.well.clientWidth - page.left) / scale),
    bottom: Math.min(page.height / scale, (well.top + view.well.clientHeight - page.top) / scale),
  };
};
