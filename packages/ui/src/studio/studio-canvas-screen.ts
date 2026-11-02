"use client";

import { createUsePuck, type UiState, type Viewports } from "@puckeditor/core";
import { useCallback } from "react";
import type { Breakpoint } from "../definition-error";
import type { VortexIconName } from "../icons";

/** The screens the canvas previews, declared once: Puck's viewports and the toolbar read this. */
export const studioScreens: readonly Readonly<{
  breakpoint: Breakpoint;
  label: string;
  width: number;
  icon: VortexIconName;
}>[] = [
  { breakpoint: "desktop", label: "Desktop", width: 1280, icon: "monitor" },
  { breakpoint: "tablet", label: "Tablet", width: 820, icon: "tablet" },
  { breakpoint: "phone", label: "Phone", width: 390, icon: "smartphone" },
];

/**
 * Puck's `viewports` prop. In this setup it only declares the viewport list: Puck draws nothing
 * from it in composition mode (`Puck.Preview`), and Studio's canvas sizes the frame itself.
 */
export const studioViewports: Viewports = studioScreens.map((screen) => ({
  width: screen.width,
  height: "auto",
  label: screen.label,
}));

/** Puck's initial `ui`: the first screen is current, and Puck draws no viewport controls itself. */
export const studioInitialUi: Partial<UiState> = {
  viewports: {
    current: { width: studioScreens[0]!.width, height: "auto" },
    options: [],
    controlsVisible: false,
  },
};

/** The declared screen of a viewport width; a width Studio does not declare is a defect. */
export const studioScreenOfWidth = (width: number | "100%") => {
  const screen = studioScreens.find((entry) => entry.width === width);
  if (screen === undefined)
    throw new Error(`STUDIO_CANVAS_SCREEN_UNKNOWN: no declared screen is ${String(width)} wide`);
  return screen;
};

/** The breakpoint of the screen Puck starts on. */
export const studioInitialBreakpoint: Breakpoint = studioScreens[0]!.breakpoint;

const usePuckSelector = createUsePuck();

/**
 * The screen the canvas previews. Puck's `ui.viewports.current` is the only place it is kept; the
 * breakpoint and width are read from it, and choosing a screen writes it back there. Only inside
 * the workspace's Puck editor.
 */
export function useStudioScreen(): Readonly<{
  breakpoint: Breakpoint;
  label: string;
  width: number;
  choose: (breakpoint: Breakpoint) => void;
}> {
  const current = usePuckSelector((state) => state.appState.ui.viewports.current.width);
  const dispatch = usePuckSelector((state) => state.dispatch);
  const choose = useCallback(
    (breakpoint: Breakpoint) => {
      const screen = studioScreens.find((entry) => entry.breakpoint === breakpoint);
      if (screen === undefined)
        throw new Error(`STUDIO_CANVAS_SCREEN_UNKNOWN: no declared screen is ${breakpoint}`);
      dispatch({
        type: "setUi",
        ui: (ui) => ({
          viewports: { ...ui.viewports, current: { width: screen.width, height: "auto" } },
        }),
      });
    },
    [dispatch],
  );
  const screen = studioScreenOfWidth(current);
  return { breakpoint: screen.breakpoint, label: screen.label, width: screen.width, choose };
}
