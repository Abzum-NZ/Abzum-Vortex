import type { CSSProperties } from "react";
import type { PlacementLayoutV2Contract } from "@vortex/contracts";
import type { Breakpoint } from "./definition-error";

/**
 * Class names used for deterministic layout rendering.
 */
export const LAYOUT_CLASS_NAMES = Object.freeze({
  gridContainer: "vortex-grid-12",
  slotContainer: "vortex-slot-container",
  placementWrapper: "vortex-placement-wrapper",
  widthFill: "vortex-width-fill",
  widthContent: "vortex-width-content",
  heightContent: "vortex-height-content",
  heightBounded: "vortex-height-bounded",
  hidden: "vortex-hidden",
});

/**
 * Computes inline CSSProperties for a placement's layout declaration at a given breakpoint.
 */
export function computePlacementStyle(
  layout: PlacementLayoutV2Contract | undefined,
  _breakpoint?: Breakpoint,
): CSSProperties {
  if (!layout) {
    return { boxSizing: "border-box" };
  }

  const style: CSSProperties = {
    boxSizing: "border-box",
  };

  // Declared visibility
  if (!layout.visible) {
    style.display = "none";
    return style;
  }

  // Declared width
  if (layout.width.kind === "fill") {
    style.width = "100%";
  } else if (layout.width.kind === "content") {
    style.width = "fit-content";
    style.maxWidth = "100%";
  } else if (layout.width.kind === "grid") {
    const { startColumn, span } = layout.width;
    style.gridColumnStart = startColumn;
    style.gridColumnEnd = `span ${span}`;
  }

  // Declared height
  if (layout.height.kind === "content") {
    style.height = "auto";
  } else if (layout.height.kind === "bounded") {
    style.maxHeight = `${layout.height.units}rem`;
    style.overflowY = "auto";
  }

  return style;
}

/**
 * Computes standard CSS class names for a placement's layout declaration.
 */
export function computePlacementClassName(
  layout: PlacementLayoutV2Contract | undefined,
  _breakpoint?: Breakpoint,
): string {
  if (!layout) {
    return LAYOUT_CLASS_NAMES.placementWrapper;
  }

  const classes: string[] = [LAYOUT_CLASS_NAMES.placementWrapper];

  if (!layout.visible) {
    classes.push(LAYOUT_CLASS_NAMES.hidden);
    return classes.join(" ");
  }

  if (layout.width.kind === "fill") {
    classes.push(LAYOUT_CLASS_NAMES.widthFill);
  } else if (layout.width.kind === "content") {
    classes.push(LAYOUT_CLASS_NAMES.widthContent);
  } else if (layout.width.kind === "grid") {
    classes.push(`vortex-col-${layout.width.startColumn}-span-${layout.width.span}`);
  }

  if (layout.height.kind === "content") {
    classes.push(LAYOUT_CLASS_NAMES.heightContent);
  } else if (layout.height.kind === "bounded") {
    classes.push(LAYOUT_CLASS_NAMES.heightBounded);
  }

  return classes.join(" ");
}

/**
 * Computes slot container style, applying a 12-column grid when child placements declare grid placement.
 */
export function computeSlotContainerStyle(hasGridChildren: boolean): CSSProperties {
  if (hasGridChildren) {
    return {
      display: "grid",
      gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
      width: "100%",
      boxSizing: "border-box",
    };
  }

  return {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    boxSizing: "border-box",
  };
}

/**
 * Layout-only CSS stylesheet string for browser-safe deterministic page layout rendering.
 */
export const LAYOUT_ONLY_STYLES_CSS = `
.vortex-grid-12 {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  width: 100%;
  box-sizing: border-box;
}

.vortex-slot-container {
  display: flex;
  flex-direction: column;
  width: 100%;
  box-sizing: border-box;
}

.vortex-placement-wrapper {
  box-sizing: border-box;
}

.vortex-width-fill {
  width: 100%;
}

.vortex-width-content {
  width: fit-content;
  max-width: 100%;
}

.vortex-height-content {
  height: auto;
}

.vortex-height-bounded {
  overflow-y: auto;
}

.vortex-hidden {
  display: none !important;
}

/* 12-column grid position generator */
.vortex-col-1-span-12 { grid-column: 1 / span 12; }
.vortex-col-1-span-6  { grid-column: 1 / span 6; }
.vortex-col-7-span-6  { grid-column: 7 / span 6; }
.vortex-col-1-span-4  { grid-column: 1 / span 4; }
.vortex-col-5-span-4  { grid-column: 5 / span 4; }
.vortex-col-9-span-4  { grid-column: 9 / span 4; }
.vortex-col-1-span-3  { grid-column: 1 / span 3; }
.vortex-col-4-span-3  { grid-column: 4 / span 3; }
.vortex-col-7-span-3  { grid-column: 7 / span 3; }
.vortex-col-10-span-3 { grid-column: 10 / span 3; }
`;
