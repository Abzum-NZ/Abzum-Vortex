"use client";

import { createContext, useContext } from "react";

/** How much the workspace scales the page frame (1 is the page's own size). */
const CanvasScaleContext = createContext(1);

/**
 * Supplies the zoom the page frame is drawn at. Puck's own zoom is unused (the workspace scales the
 * whole frame from outside), so what is drawn on the canvas for the person, not for the page (the
 * action bar and the empty-slot labels), counter-scales by this to keep its size on screen.
 */
export const StudioCanvasScaleProvider = CanvasScaleContext.Provider;

export const useStudioCanvasScale = (): number => useContext(CanvasScaleContext);
