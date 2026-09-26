/**
 * The shadcn visual styles whose CSS ships in the `ui` package. Each style's CSS is scoped to
 * `[data-vortex-style="<style>"]` on the root element, so one component source serves every style
 * and selecting a style needs no code change. The other shadcn styles arrive with the theme
 * catalogue import.
 */
export const VORTEX_STYLES = ["nova"] as const;

export type VortexStyle = (typeof VORTEX_STYLES)[number];

export const DEFAULT_VORTEX_STYLE: VortexStyle = "nova";

/**
 * The style for the `data-vortex-style` root attribute: the resolved theme's style when it is a
 * shipped one, otherwise the default. Themes do not carry a style dimension yet, so every caller
 * currently receives the default.
 */
export function resolveVortexStyle(requested?: string | null): VortexStyle {
  return VORTEX_STYLES.find((style) => style === requested) ?? DEFAULT_VORTEX_STYLE;
}
