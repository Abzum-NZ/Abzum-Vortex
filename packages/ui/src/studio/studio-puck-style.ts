import type { CSSProperties } from "react";

const steps = Array.from({ length: 12 }, (_, index) => index + 1);
const step = (name: string, number: number): string =>
  `--puck-color-${name}-${String(number).padStart(2, "0")}`;
const mix = (colour: string, share: number, other: string): string =>
  `color-mix(in oklab, ${colour} ${String(share)}%, ${other})`;

/**
 * One of Puck's twelve-step palettes drawn from a theme token: steps 1 to 3 mix the token toward the
 * foreground (more contrast), step 4 is the token itself, and steps 5 to 12 fade it toward the background.
 * Puck's components read some palette steps directly rather than through its semantic aliases.
 */
const palette = (name: string, token: string): Array<[string, string]> => {
  const shares = [40, 60, 80, 100, 80, 60, 45, 30, 20, 12, 8, 4];
  return steps.map((number, index): [string, string] => [
    step(name, number),
    number === 4
      ? token
      : mix(token, shares[index] ?? 100, number < 4 ? "var(--foreground)" : "var(--background)"),
  ]);
};

/** Puck's neutral ramp from the foreground (step 1) to the background (step 12). */
const greys = (): Array<[string, string]> =>
  steps.map((number, index): [string, string] => [
    step("grey", number),
    mix(
      "var(--foreground)",
      [92, 80, 68, 56, 46, 36, 28, 20, 12, 8, 5, 2][index] ?? 50,
      "var(--background)",
    ),
  ]);

/** Puck chrome follows Studio's theme; the nested application keeps its own theme variables. */
export const studioPuckStyle = {
  ...Object.fromEntries([
    ...palette("azure", "var(--primary)"),
    ...palette("rose", "var(--primary)"),
    ...palette("green", "var(--success)"),
    ...palette("yellow", "var(--warning)"),
    ...palette("red", "var(--destructive)"),
    ...greys(),
  ]),
  "--puck-color-black": "var(--foreground)",
  "--puck-color-white": "var(--background)",
  "--puck-color-overlay-backdrop": `light-dark(${mix("var(--foreground)", 60, "transparent")}, ${mix("var(--background)", 60, "transparent")})`,
  // The theme's corner radius, spacing unit, focus width and fonts. What stays Puck's has no theme
  // counterpart: the pill and round shapes and `--puck-radius-none`, the font-size scale, weights,
  // line heights and letter spacing, the border widths (hairline, regular, strong), durations, icon
  // sizes, and the panel and sidebar widths.
  "--puck-radius-xs": "calc(var(--radius) * 0.25)",
  "--puck-radius-s": "calc(var(--radius) * 0.4)",
  "--puck-radius-m": "var(--radius-sm)",
  "--puck-radius-l": "var(--radius-md)",
  "--puck-space-1": "var(--spacing, 0.25rem)",
  "--puck-space-2": "calc(var(--spacing, 0.25rem) * 2)",
  "--puck-space-3": "calc(var(--spacing, 0.25rem) * 3)",
  "--puck-space-4": "calc(var(--spacing, 0.25rem) * 4)",
  "--puck-space-chrome-gutter": "var(--puck-space-4)",
  "--puck-space-5": "calc(var(--spacing, 0.25rem) * 6)",
  "--puck-border-width-focus": "var(--vortex-focus-width)",
  "--puck-font-family-monospaced": "var(--font-mono)",
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

const tokenReference = /var\((--[a-z0-9-]+)/g;

/** Every theme token the map above reads (`--primary`, `--spacing`), once. */
const referencedTokens = [
  ...new Set(
    Object.values(studioPuckStyle).flatMap((value) =>
      [...String(value).matchAll(tokenReference)].map((match) => match[1] ?? ""),
    ),
  ),
];

const studioToken = (name: string): string => `--studio-${name.slice(2)}`;

/**
 * The same variables for the canvas's iframe. Puck draws its overlay, selection and drop line in
 * the iframe's body, which the host's styles do not reach, and the frame's own `--primary` and the
 * like are the application's. So the frame's root receives Studio's values of the tokens the map
 * reads (copied from the host as they stand, with their light and dark pair) under a `--studio-`
 * prefix, and the map points at those. The application's variables are never overwritten, and the
 * overlay looks the same on every application. Puck draws an outline inside the box it outlines,
 * so an edge-to-edge block's outline is not cut off at the iframe's edge.
 */
export function studioPuckIframeCss(host: CSSStyleDeclaration): string {
  const values = referencedTokens.flatMap((name) => {
    const value = host.getPropertyValue(name).trim();
    return value === "" ? [] : [`${studioToken(name)}:${value}`];
  });
  const map = Object.entries(studioPuckStyle).map(
    ([key, value]) =>
      `${key}:${String(value).replace(tokenReference, (_, name: string) => `var(${studioToken(name)}`)}`,
  );
  return `:root{${values.join(";")}}body{${map.join(";")}}`;
}
