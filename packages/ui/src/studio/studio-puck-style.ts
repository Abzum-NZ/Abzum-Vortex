import type { CSSProperties } from "react";

/** Puck chrome follows Studio's theme; the nested application keeps its own theme variables. */
export const studioPuckStyle = {
  // Some Puck overlays still consume the palette directly rather than its semantic aliases.
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      `--puck-color-azure-${String(index + 1).padStart(2, "0")}`,
      "var(--primary)",
    ]),
  ),
  "--puck-color-surface": "var(--background)",
  "--puck-color-surface-muted": "var(--muted)",
  "--puck-color-surface-subtle": "var(--card)",
  "--puck-color-surface-inverse": "var(--foreground)",
  "--puck-color-border": "var(--border)",
  "--puck-color-border-hover": "var(--ring)",
  "--puck-color-border-muted": "var(--border)",
  "--puck-color-border-inverse": "var(--border)",
  "--puck-color-text": "var(--foreground)",
  "--puck-color-text-secondary": "var(--foreground)",
  "--puck-color-text-muted": "var(--muted-foreground)",
  "--puck-color-text-subtle": "var(--muted-foreground)",
  "--puck-color-text-inverse": "var(--background)",
  "--puck-color-interactive": "var(--primary)",
  "--puck-color-interactive-hover": "var(--primary)",
  "--puck-color-interactive-active": "var(--primary)",
  "--puck-color-interactive-neutral-hover": "var(--accent)",
  "--puck-color-interactive-inverse-hover": "var(--primary)",
  "--puck-color-interactive-inverse-active": "var(--primary)",
  "--puck-color-focus-ring": "var(--primary)",
  "--puck-color-selection-border": "var(--primary)",
  "--puck-color-line-placeholder": "var(--primary)",
  "--puck-color-highlight": "var(--primary)",
  "--puck-color-bg-disabled": "var(--muted)",
  "--puck-color-text-disabled": "var(--muted-foreground)",
  "--puck-color-interactive-subtle": "color-mix(in oklab, var(--primary) 10%, transparent)",
  "--puck-color-interactive-soft": "color-mix(in oklab, var(--primary) 10%, transparent)",
  "--puck-color-interactive-soft-hover": "color-mix(in oklab, var(--primary) 10%, transparent)",
  "--puck-color-selection-bg": "color-mix(in oklab, var(--primary) 10%, transparent)",
  "--puck-font-family": "var(--font-sans)",
  // The outline: Puck's default row colours are its own azure palette. Text is the theme's foreground
  // on a hover or selected fill (at least 13:1 in every shadcn base and theme colour, light and dark),
  // and the selected border and the drop line are the foreground, which keeps 3:1 against the
  // background and both fills where the primary or ring colour of some themes does not.
  "--puck-color-text-primary": "var(--foreground)",
  "--puck-outline-color-text": "var(--foreground)",
  "--puck-outline-color-text-hover": "var(--foreground)",
  "--puck-outline-color-text-helper": "var(--muted-foreground)",
  "--puck-outline-zone-color-text": "var(--muted-foreground)",
  "--puck-outline-color-icon": "var(--muted-foreground)",
  "--puck-outline-color-bg-hover": "var(--accent)",
  "--puck-outline-color-bg-selected": "color-mix(in oklab, var(--primary) 12%, var(--background))",
  "--puck-outline-color-border-hover": "var(--accent)",
  "--puck-outline-color-border-selected": "var(--foreground)",
  "--puck-outline-color-drop-indicator": "var(--foreground)",
  // The drawer's category headers (Puck's own buttons) are Studio headings: its size, colours and gap.
  "--puck-drawer-category-font-size": "var(--text-sm, 0.875rem)",
  "--puck-drawer-category-color-text": "var(--muted-foreground)",
  "--puck-drawer-category-color-bg-hover": "var(--accent)",
  "--puck-drawer-category-color-text-hover": "var(--accent-foreground)",
  "--puck-drawer-category-space": "calc(var(--spacing, 0.25rem) * 2)",
} as CSSProperties;

/**
 * The same variables for the canvas's iframe: Puck draws its overlay, selection and drop line in
 * the iframe's body, which the host's frame styles do not reach. Puck draws an outline inside the
 * box it outlines, so an edge-to-edge block's outline is not cut off at the iframe's edge.
 */
export const studioPuckIframeCss = `body{${Object.entries(studioPuckStyle)
  .map(([key, value]) => `${key}:${String(value)}`)
  .join(";")}}`;
