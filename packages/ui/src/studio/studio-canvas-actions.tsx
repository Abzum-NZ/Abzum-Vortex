"use client";

import type { Overrides } from "@puckeditor/core";
import { StudioCanvasIframe } from "./studio-canvas-root";

/** Puck supplies the action bar; Studio supplies the frame in its iframe. */
export const studioCanvasOverrides: Partial<Overrides> = {
  iframe: StudioCanvasIframe,
};
