import type { CSSProperties } from "react";
import {
  createThemeRootProps,
  type ApplicationTheme,
  type PlatformThemeTokens,
} from "./theme-variables";
import { createVortexStyleRootProps, resolveVortexStyleSelection } from "./vortex-style";

const platformDefaults = new WeakMap<PlatformThemeTokens, CSSProperties>();

/** Every variable of the platform default root rule: the theme and style a root has with no theme. */
const platformDefaultVariables = (platformThemeTokens: PlatformThemeTokens): CSSProperties => {
  const known = platformDefaults.get(platformThemeTokens);
  if (known !== undefined) return known;
  const defaults = {
    ...createThemeRootProps(undefined, platformThemeTokens).style,
    ...createVortexStyleRootProps(resolveVortexStyleSelection()).style,
  };
  platformDefaults.set(platformThemeTokens, defaults);
  return defaults;
};

/**
 * The variables an application's theme gives its document root beyond the platform default root
 * rule, which the document already carries as a cached stylesheet: every variable whose value is
 * not the platform's. The root writes each value once, here, and the platform rule supplies the
 * rest, so the page does not repeat the whole variable set.
 */
export function createDocumentThemeVariables(
  theme: ApplicationTheme | undefined,
  platformThemeTokens: PlatformThemeTokens,
): CSSProperties {
  const defaults = platformDefaultVariables(platformThemeTokens) as Readonly<
    Record<string, unknown>
  >;
  const full: Readonly<Record<string, unknown>> = {
    ...createThemeRootProps(theme, platformThemeTokens).style,
    ...createVortexStyleRootProps(resolveVortexStyleSelection(theme?.selection)).style,
  };
  return Object.fromEntries(
    Object.entries(full).filter(([name, value]) => defaults[name] !== value),
  ) as CSSProperties;
}

/**
 * The theme variables the platform loader (`BrandLoader`) reads: its colour, the surface it sits on
 * and its cycle. Its size and timing tokens come only from the platform stylesheet, never from a
 * theme; everything else a theme sets (component styles included) is the loaded page's.
 */
const LOADER_VARIABLES: ReadonlySet<string> = new Set([
  "--primary",
  "--background",
  "--vortex-loader-cycle",
]);

/**
 * The variables an application's theme gives the loader drawn before its frame is composed: the
 * document variables the loader reads, without the rest of the theme the frame writes itself.
 */
export function createLoaderThemeVariables(
  theme: ApplicationTheme | undefined,
  platformThemeTokens: PlatformThemeTokens,
): CSSProperties {
  return Object.fromEntries(
    Object.entries(createDocumentThemeVariables(theme, platformThemeTokens)).filter(([name]) =>
      LOADER_VARIABLES.has(name),
    ),
  ) as CSSProperties;
}
