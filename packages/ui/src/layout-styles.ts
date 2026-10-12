import type { CSSProperties } from "react";
import type { BlockPlacementContract } from "@vortex/platform/schema";

/**
 * One breakpoint's declared layout values. Derived from the canonical placement contract rather
 * than a separate declaration so the renderer and the schema cannot drift.
 */
type PlacementLayoutContract = BlockPlacementContract["responsive"]["desktop"];

/** Complete per-breakpoint layout declaration for one placement. */
export type ResponsivePlacementLayouts = BlockPlacementContract["responsive"];

/**
 * Breakpoint thresholds shared by the responsive stylesheet and the browser breakpoint provider.
 * Desktop is the base; tablet and phone override from the next wider declaration.
 */
const LAYOUT_BREAKPOINT_MAX_WIDTH = Object.freeze({
  tablet: 1024,
  phone: 640,
});

export const LAYOUT_BREAKPOINT_MEDIA = Object.freeze({
  tablet: `(max-width: ${LAYOUT_BREAKPOINT_MAX_WIDTH.tablet}px)`,
  phone: `(max-width: ${LAYOUT_BREAKPOINT_MAX_WIDTH.phone}px)`,
});

/** Breakpoints form their media rules widest first so narrower rules win the cascade. */
export const RESPONSIVE_BREAKPOINT_ORDER = ["desktop", "tablet", "phone"] as const;

/**
 * Class names used for deterministic layout rendering.
 */
export const LAYOUT_CLASS_NAMES = Object.freeze({
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
export function computePlacementStyle(layout: PlacementLayoutContract | undefined): CSSProperties {
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
    style.gridColumn = "1 / -1";
  } else if (layout.width.kind === "content") {
    style.width = "fit-content";
    style.maxWidth = "100%";
    style.gridColumn = "1 / -1";
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
export function computePlacementClassName(layout: PlacementLayoutContract | undefined): string {
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

/** The named gaps a block can declare between its slot children, on the shadcn spacing scale. */
export type SlotGapName = "none" | "small" | "medium" | "large";

const SLOT_GAP_UNITS: Readonly<Record<SlotGapName, number>> = Object.freeze({
  none: 0,
  small: 2,
  medium: 4,
  large: 6,
});

/** The CSS length of a named slot gap. Callers always name the gap; nothing here supplies one. */
export const slotGapLength = (gap: SlotGapName): string =>
  `calc(var(--spacing, 0.25rem) * ${SLOT_GAP_UNITS[gap]})`;

/**
 * CSS declarations for one breakpoint's layout. Visibility and geometry are explicit so a narrower
 * rule can always override a wider one, including resetting bounded height and grid placement.
 */
function responsiveLayoutDeclarations(layout: PlacementLayoutContract, gridItem: boolean): string {
  if (!layout.visible) return "display: none";

  const declarations: string[] = ["display: block"];

  if (layout.width.kind === "fill") {
    declarations.push("width: 100%", "max-width: none");
    if (gridItem) declarations.push("grid-column: 1 / -1");
  } else if (layout.width.kind === "content") {
    declarations.push("width: fit-content", "max-width: 100%");
    if (gridItem) declarations.push("grid-column: 1 / -1");
  } else {
    declarations.push(
      "width: auto",
      "max-width: none",
      `grid-column: ${layout.width.startColumn} / span ${layout.width.span}`,
    );
  }

  if (layout.height.kind === "bounded") {
    declarations.push(`max-height: ${layout.height.units}rem`, "overflow-y: auto");
  } else {
    declarations.push("max-height: none", "overflow-y: visible");
  }

  return declarations.join("; ");
}

/** The same per-breakpoint rules for any one selector, e.g. a placement wrapper that scopes itself. */
export function computeResponsiveSelectorCss(
  selector: string,
  responsive: ResponsivePlacementLayouts,
  gridItem: boolean,
): string {
  let css = `${selector} { ${responsiveLayoutDeclarations(responsive.desktop, gridItem)}; }\n`;
  for (const breakpoint of RESPONSIVE_BREAKPOINT_ORDER) {
    if (breakpoint === "desktop") continue;
    css += `@media ${LAYOUT_BREAKPOINT_MEDIA[breakpoint]} { ${selector} { ${responsiveLayoutDeclarations(responsive[breakpoint], gridItem)}; } }\n`;
  }
  return css;
}

/**
 * Layout-only CSS stylesheet string for browser-safe deterministic page layout rendering.
 */
const GRID_POSITION_STYLES = Array.from({ length: 12 }, (_, startIndex) => {
  const startColumn = startIndex + 1;
  return Array.from({ length: 13 - startColumn }, (_, spanIndex) => {
    const span = spanIndex + 1;
    return `.vortex-col-${startColumn}-span-${span} { grid-column: ${startColumn} / span ${span}; }`;
  }).join("\n");
}).join("\n");

export const LAYOUT_ONLY_STYLES_CSS = `
.vortex-placement-wrapper {
  box-sizing: border-box;
  min-width: 0;
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

.vortex-puck-slot {
  display: flex;
  flex-direction: column;
  width: 100%;
  box-sizing: border-box;
}

/* A Puck slot is always present, so a container region that holds no placement is not rendered. In
   the editor an empty region stays, as the drop target an author fills. */
[data-vortex-puck-root]:not([data-vortex-editing])
  [data-vortex-container-region]:not(:has([data-vortex-layout-wrapper])) {
  display: none;
}

.vortex-puck-slot:has(> [data-vortex-grid-child]) {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
}

${GRID_POSITION_STYLES}
`;
