import type { ComponentProps, ComponentType } from "react";

/**
 * The semantic icon set every shared component and platform block asks for. A component names the
 * meaning ("close"), never a library's glyph ("XIcon"), and the adapter of the selected icon library
 * draws it. Adding a name means adding it to every adapter in ./adapters; the adapter types refuse a
 * library that does not map every name, so no library can render a blank icon.
 */
export const VORTEX_ICON_NAMES = [
  "arrow-down",
  "arrow-up",
  "calendar",
  "check",
  "chevron-down",
  "chevron-left",
  "chevron-right",
  "chevron-up",
  "circle",
  "close",
  "loader",
  "menu",
  "minus",
  "more-horizontal",
  "more-vertical",
  "panel-left",
  "plus",
  "search",
  "grid",
  "contact-round",
  "users",
  "sliders-horizontal",
  "life-buoy",
  "building-2",
] as const;

export type VortexIconName = (typeof VORTEX_ICON_NAMES)[number];

/** Resolve only declared semantic names; unknown source text has no exact glyph mapping. */
export const resolveVortexIconName = (value: string): VortexIconName | undefined =>
  VORTEX_ICON_NAMES.find((name) => name === value);

/** The SVG attributes a caller may pass to an icon: classes, data and ARIA attributes, and styling. */
export type VortexIconProps = Omit<ComponentProps<"svg">, "ref" | "children">;

/** One icon library's drawing of every semantic icon. */
export type VortexIconAdapter = Readonly<Record<VortexIconName, ComponentType<VortexIconProps>>>;
