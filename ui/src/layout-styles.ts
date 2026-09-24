import type { CSSProperties } from "react";
import type { BlockPlacementV2Contract } from "@vortex/contracts";
import type { Breakpoint } from "./definition-error";

/**
 * One breakpoint's declared layout values. Derived from the canonical placement contract rather
 * than a separate declaration so the renderer and the schema cannot drift.
 */
export type PlacementLayoutV2Contract = BlockPlacementV2Contract["responsive"]["desktop"];

/** Complete per-breakpoint layout declaration for one placement. */
export type ResponsivePlacementLayoutsV2 = BlockPlacementV2Contract["responsive"];

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
 * Whether any child placement of this slot declares twelve-column grid width at any breakpoint.
 * A live slot keeps one container mode for every breakpoint so its responsive geometry stays pure
 * CSS; non-grid children span the full row through their own media rules.
 */
export function slotDeclaresGridChildren(slot: {
  placements: Readonly<Record<string, Readonly<{ responsive: ResponsivePlacementLayoutsV2 }>>>;
}): boolean {
  return Object.values(slot.placements).some((placement) =>
    RESPONSIVE_BREAKPOINT_ORDER.some(
      (breakpoint) => placement.responsive[breakpoint].width.kind === "grid",
    ),
  );
}

/**
 * Attribute the live layout root carries so responsive rules cannot leak into an explicit
 * breakpoint preview rendered on the same document. Escapes CSS string metacharacters.
 */
const LIVE_LAYOUT_SCOPE_ATTRIBUTE = "data-vortex-live-layout";

function placementCssSelector(placementId: string): string {
  const escaped = placementId
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\n\r]/g, "\\a ");
  return `[${LIVE_LAYOUT_SCOPE_ATTRIBUTE}] [data-vortex-placement-id="${escaped}"]`;
}

/**
 * CSS declarations for one breakpoint's layout. Visibility and geometry are explicit so a narrower
 * rule can always override a wider one, including resetting bounded height and grid placement.
 */
function responsiveLayoutDeclarations(
  layout: PlacementLayoutV2Contract,
  gridItem: boolean,
): string {
  if (!layout.visible) return "display: none";

  const declarations: string[] = ["display: block"];

  if (layout.width.kind === "fill") {
    declarations.push("width: 100%");
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

/**
 * Per-breakpoint width, visibility and height for one placement as a media-query stylesheet. This
 * is the live-page path: the server emits the same rules for every visitor and the browser applies
 * the matching breakpoint inline, so phone visitors never receive a desktop-only inline style.
 */
export function computeResponsivePlacementCss(
  placementId: string,
  responsive: ResponsivePlacementLayoutsV2,
  options: Readonly<{ gridItem?: boolean }> = {},
): string {
  const gridItem = options.gridItem ?? false;
  const selector = placementCssSelector(placementId);
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

${GRID_POSITION_STYLES}
`;
