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
} as CSSProperties;
