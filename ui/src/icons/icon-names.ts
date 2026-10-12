import type { ComponentProps, ComponentType } from "react";
import { VORTEX_ICON_NAMES, type VortexIconName } from "@vortex/contracts";

/**
 * The semantic icon set every shared component and platform block asks for. A component names the
 * meaning ("close"), never a library's glyph ("XIcon"), and the adapter of the selected icon library
 * draws it. Adding a name means adding it to every adapter in ./adapters; the adapter types refuse a
 * library that does not map every name, so no library can render a blank icon.
 */
export { VORTEX_ICON_NAMES, type VortexIconName };

/** Resolve only declared semantic names; unknown source text has no exact glyph mapping. */
export const resolveVortexIconName = (value: string): VortexIconName | undefined =>
  VORTEX_ICON_NAMES.find((name) => name === value);

/** The SVG attributes a caller may pass to an icon: classes, data and ARIA attributes, and styling. */
export type VortexIconProps = Omit<ComponentProps<"svg">, "ref" | "children">;

/** One icon library's drawing of every semantic icon. */
export type VortexIconAdapter = Readonly<Record<VortexIconName, ComponentType<VortexIconProps>>>;
