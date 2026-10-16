import type { CSSProperties } from "react";
import {
  DEFAULT_APPLICATION_THEME_SELECTION,
  findShadcnFontByFamilyKey,
  resolveShadcnFontSelection,
  shadcnFontStack,
  type ApplicationContent,
  type PlatformThemeTokenRoleKey,
  type PlatformThemeRelease,
  type ShadcnFontOption,
} from "@vortex/platform/schema";

/** Resolved #594 application theme, as materialised in application content. */
export type ApplicationTheme = ApplicationContent["theme"];
type ThemeTokenValue = ApplicationTheme["tokens"][string];

/** The viewer's appearance choice. `system` follows the person's browser colour-scheme preference. */
export type ThemeMode = "light" | "dark" | "system";

/** Resolved, validated #594 theme tokens keyed by builder key. */
type ThemeTokens = Readonly<Record<string, ThemeTokenValue>>;
export type PlatformThemeTokens = PlatformThemeRelease["tokens"];

/**
 * The only CSS custom properties the shared component stylesheet reads. Names are fixed
 * platform names; application token keys never become CSS names, selectors or class names.
 */
const THEME_VARIABLE_NAMES = [
  "--vortex-surface",
  "--vortex-text",
  "--vortex-text-muted",
  "--vortex-border-color",
  "--vortex-accent",
  "--vortex-primary",
  "--vortex-on-primary",
  "--vortex-secondary",
  "--vortex-on-secondary",
  "--vortex-danger",
  "--vortex-on-danger",
  "--vortex-danger-text",
  "--vortex-warning-text",
  "--vortex-info-text",
  "--vortex-success-text",
  "--vortex-focus-color",
  "--vortex-focus-width",
  "--vortex-font-family",
  "--vortex-font-size",
  "--vortex-line-height",
  "--vortex-font-weight",
  "--vortex-heading-font-family",
  "--vortex-heading-font-size",
  "--vortex-heading-line-height",
  "--vortex-heading-font-weight",
  // The shadcn font variables: the shared stylesheet's `font-sans` and `font-heading` read them,
  // so the selected body and heading fonts reach the shadcn components.
  "--font-sans-family",
  "--font-heading-family",
  "--vortex-space-xs",
  "--vortex-space-sm",
  "--vortex-space-md",
  "--vortex-space-lg",
  "--vortex-radius-sm",
  "--vortex-radius-md",
  "--vortex-radius-lg",
  "--vortex-border-width",
  "--vortex-border-style",
  "--vortex-elevation-low",
  "--vortex-elevation-high",
  "--vortex-control-padding-y",
  "--vortex-control-padding-x",
  "--vortex-control-min-height",
  "--vortex-cell-padding-y",
  "--vortex-cell-padding-x",
  // The shadcn CSS variables the shared components read. The bridge sets every one of them from
  // the same resolved theme, so a re-theme restyles the shadcn components without a code change.
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--border",
  "--input",
  "--ring",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--radius",
  "--sidebar",
  "--sidebar-foreground",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-border",
  "--sidebar-ring",
] as const;

type ThemeVariableName = (typeof THEME_VARIABLE_NAMES)[number];
type ThemeCssVariables = Readonly<Record<ThemeVariableName, string>>;

type ColorPair = Readonly<{ light: string; dark: string }>;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const COLOR_COMPONENT = "(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
const OKLCH_COLOR = new RegExp(
  `^oklch\\(\\s*${COLOR_COMPONENT}%?\\s+${COLOR_COMPONENT}\\s+${COLOR_COMPONENT}(?:deg)?\\s*(?:\\/\\s*${COLOR_COMPONENT}%?)?\\s*\\)$`,
);
const BUILDER_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const FONT_FALLBACK = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

/** Only a validated six-digit hex or oklch() value reaches the stylesheet, never raw token text. */
const isColorValue = (value: string): boolean =>
  HEX_COLOR.test(value) || OKLCH_COLOR.test(value);

/**
 * Surface keys in the exact order #594 selects the surface its text, brand and focus
 * contrast checks run against. The painted surface must be that same surface.
 */
const SURFACE_PRIORITY = ["background", "canvas", "surface", "bg", "page_background", "app_background"];

/** The registered release's value for one shared colour role, or a loud failure if absent. */
function platformColor(tokens: ThemeTokens, role: PlatformThemeTokenRoleKey): ColorPair {
  const pair = colorPair(tokens, role);
  if (pair === undefined)
    throw new Error(`Platform theme release is missing colour role "${role}"`);
  return pair;
}

/** The shadcn surfaces the vocabulary pairs with a `<role>_foreground` role. */
type ShadcnFilledRole = "card" | "popover" | "accent" | "sidebar" | "sidebar_primary" | "sidebar_accent";

/** Platform fallbacks, each read from the registered release's matching vocabulary role. */
function platformDefaults(tokens: ThemeTokens): Readonly<{
  textMuted: ColorPair;
  border: ColorPair;
  accent: ColorPair;
  primary: ColorPair;
  onPrimary: ColorPair;
  secondary: ColorPair;
  onSecondary: ColorPair;
  danger: ColorPair;
  onDanger: ColorPair;
  dangerText: ColorPair;
  warningText: ColorPair;
  infoText: ColorPair;
  successText: ColorPair;
  focus: ColorPair;
}> {
  const focus = tokens.focus;
  if (focus?.kind !== "focus")
    throw new Error('Platform theme release is missing focus role "focus"');
  return {
    textMuted: platformColor(tokens, "muted_text"),
    border: platformColor(tokens, "border_color"),
    accent: platformColor(tokens, "primary"),
    primary: platformColor(tokens, "primary"),
    onPrimary: platformColor(tokens, "primary_foreground"),
    secondary: platformColor(tokens, "secondary"),
    onSecondary: platformColor(tokens, "secondary_foreground"),
    danger: platformColor(tokens, "danger"),
    onDanger: platformColor(tokens, "danger_foreground"),
    dangerText: platformColor(tokens, "danger_text"),
    warningText: platformColor(tokens, "warning_text"),
    infoText: platformColor(tokens, "info_text"),
    successText: platformColor(tokens, "success_text"),
    focus: platformColor(tokens, focus.colorToken as PlatformThemeTokenRoleKey),
  };
}

/** The catalogue's default body and heading fonts, which a theme without a font of its own paints. */
const PLATFORM_FONTS = resolveShadcnFontSelection(DEFAULT_APPLICATION_THEME_SELECTION);

const PLATFORM_ELEVATION = [
  "none",
  "0 1px 2px rgba(0, 0, 0, 0.12)",
  "0 4px 8px rgba(0, 0, 0, 0.16)",
  "0 10px 24px rgba(0, 0, 0, 0.2)",
  "0 20px 48px rgba(0, 0, 0, 0.26)",
] as const;

const DENSITY = {
  comfortable: { controlY: "0.5rem", controlX: "0.75rem", minHeight: "2.5rem", cellY: "0.625rem", cellX: "0.875rem" },
  compact: { controlY: "0.25rem", controlX: "0.5rem", minHeight: "2rem", cellY: "0.375rem", cellX: "0.5rem" },
} as const;

const colorValue = (pair: ColorPair): string => `light-dark(${pair.light}, ${pair.dark})`;

const rem = (value: number, minimum = 0): string | undefined =>
  Number.isFinite(value) && value >= minimum ? `${value}rem` : undefined;

const plainNumber = (value: number): string | undefined =>
  Number.isFinite(value) && value > 0 ? String(value) : undefined;

const fontWeight = (value: number): string | undefined =>
  Number.isInteger(value) && value >= 100 && value <= 900 ? String(value) : undefined;

/**
 * The catalogue font a typography family key names, or a registered-release placeholder, which
 * stands for the default font. Any other key names a font the catalogue does not ship.
 */
const catalogueFont = (familyKey: string, platformTokens: ThemeTokens): ShadcnFontOption | undefined => {
  const registeredFamily = (["body", "heading"] as const).find((key) => {
    const token = platformTokens[key];
    return token?.kind === "typography" && token.family === familyKey;
  });
  return findShadcnFontByFamilyKey(familyKey) ??
    (registeredFamily === undefined ? undefined : PLATFORM_FONTS[registeredFamily]);
};

const fontStack = (font: ShadcnFontOption): string =>
  `var(--vortex-font-${font.id}, ${shadcnFontStack(font)})`;

const fontFamily = (familyKey: string, platformTokens: ThemeTokens): string | undefined => {
  const font = catalogueFont(familyKey, platformTokens);
  if (font !== undefined) return fontStack(font);
  return BUILDER_KEY.test(familyKey) ? `"${familyKey.replace(/_/g, " ")}", ${FONT_FALLBACK}` : undefined;
};

function colorPair(tokens: ThemeTokens, key: string): ColorPair | undefined {
  const token = tokens[key];
  if (token?.kind !== "color_pair") return undefined;
  return isColorValue(token.light) && isColorValue(token.dark)
    ? { light: token.light, dark: token.dark }
    : undefined;
}

function tokenOfKind<Kind extends ThemeTokenValue["kind"]>(
  tokens: ThemeTokens,
  key: string,
  kind: Kind,
): Extract<ThemeTokenValue, { kind: Kind }> | undefined {
  const token = tokens[key];
  return token?.kind === kind ? (token as Extract<ThemeTokenValue, { kind: Kind }>) : undefined;
}

/**
 * Mirrors #594's surface selection: the colour pair the shared vocabulary declares with the
 * background role, so painted text is always on its validated surface. Token names never
 * choose the surface; the priority order only settles which declared background role wins.
 */
function themeSurface(tokens: ThemeTokens): ColorPair | undefined {
  const backgrounds = Object.keys(tokens).filter((key) => {
    const token = tokens[key];
    return token?.kind === "color_pair" && token.role === "background";
  });
  const selected =
    SURFACE_PRIORITY.find((key) => backgrounds.includes(key)) ?? backgrounds.sort()[0];
  return selected === undefined ? undefined : colorPair(tokens, selected);
}

/** A fill and its #594-validated foreground from the vocabulary pair `<key>_foreground`. */
function filledPair(tokens: ThemeTokens, key: string): readonly [ColorPair, ColorPair] | undefined {
  const fill = colorPair(tokens, key);
  const foreground = colorPair(tokens, `${key}_foreground`);
  return fill === undefined || foreground === undefined ? undefined : [fill, foreground];
}

/**
 * Generates the complete, bounded CSS-variable map for shared components from resolved
 * #594 tokens. Every colour carries both appearances through `light-dark()`, so one map
 * serves light, dark and system selection through the container's `color-scheme`.
 *
 * Token keys are the shared vocabulary's roles (one key per role, no aliases):
 * - colour: the #594-selected `background` with `text`; `muted_text`; `border_color`; `primary`
 *   (accent); the filled pairs `primary`, `secondary`, `danger` with `<key>_foreground`;
 *   `danger_text`, `warning_text`, `info_text`, `success_text`.
 * - typography `body` and `heading`; spacing `space_xs`..`space_lg`; corners
 *   `radius_sm`..`radius_lg`; border `border`; elevation `elevation_low`, `elevation_high`;
 *   focus `focus`; density `density`.
 *
 * Every shadcn CSS variable the shared components read is set from the same resolved theme:
 * `--background`/`--foreground` from the validated surface and text; `--card`, `--popover`,
 * `--muted`, `--accent`, `--chart-1`..`--chart-5`, `--sidebar*`, `--input`, `--ring` and
 * `--destructive` from the matching colour role; `--radius` from `radius_base`. A fill and its
 * `<role>_foreground` (card, popover, accent, sidebar, sidebar_primary, sidebar_accent) change
 * together. `--font-sans-family` and `--font-heading-family` carry the `body` and `heading`
 * typography families through their self-hosted `next/font` variables. A theme without a body token
 * paints the default catalogue font.
 * `light-dark()` serves forced light, forced dark and the system preference through the
 * container's `color-scheme` (a `.dark` ancestor sets it dark), and the shadcn `dark:` variant in
 * packages/ui/src/styles/globals.css follows the same resolved mode, so `.dark` and `prefers-color-scheme`
 * selections resolve the same map.
 *
 * A colour is applied only where #594 validated it against what is painted beneath it;
 * otherwise the registered platform theme's value for that role is kept. Only validated hex or
 * oklch() colours, finite numbers and builder-key font families are emitted, so a definition
 * cannot inject CSS.
 */
function generateThemeCssVariables(
  platformThemeTokens: PlatformThemeTokens,
  themeTokens?: ThemeTokens,
): ThemeCssVariables {
  const platformTokens: ThemeTokens = platformThemeTokens;
  const PLATFORM_DEFAULTS = platformDefaults(platformTokens);
  const platformRadiusToken = tokenOfKind(platformTokens, "radius_base", "corners");
  if (platformRadiusToken === undefined || !Number.isFinite(platformRadiusToken.rem) || platformRadiusToken.rem < 0)
    throw new Error('Platform theme release is missing corners role "radius_base"');
  const platformRadiusBase = `${platformRadiusToken.rem}rem`;
  const DEFAULT_SURFACE = platformColor(platformTokens, "background");
  const DEFAULT_TEXT = platformColor(platformTokens, "text");
  const tokens = themeTokens ?? {};
  const appSurface = themeSurface(tokens);
  const appText = colorPair(tokens, "text");
  // Surface and text change together so body text is never painted on an unvalidated surface.
  // #594 refuses a theme without a declared background, so without one no surface-relative
  // theme colour is trusted and the registered platform values are painted instead.
  const surfaceValidated = appSurface !== undefined && appText !== undefined;
  const surface = (surfaceValidated ? appSurface : undefined) ?? DEFAULT_SURFACE;
  const text = (surfaceValidated ? appText : undefined) ?? DEFAULT_TEXT;

  // Fallbacks are concrete values rather than var() references, so a placement override
  // that changes one role never leaves a derived role holding an inherited colour.
  /** A surface-relative colour: the theme's validated value, else a readable fallback. */
  const onSurface = (key: string, platform: ColorPair): string => {
    const themed = surfaceValidated ? colorPair(tokens, key) : undefined;
    return colorValue(themed ?? (surfaceValidated ? text : platform));
  };

  const primary = filledPair(tokens, "primary");
  const secondary = filledPair(tokens, "secondary");
  const danger = filledPair(tokens, "danger");

  const focus = tokenOfKind(tokens, "focus", "focus");
  const focusColor = focus === undefined || !surfaceValidated ? undefined : colorPair(tokens, focus.colorToken);
  const border = tokens.border;
  const borderColor =
    border?.kind === "border"
      ? colorPair(tokens, border.colorToken)
      : border?.kind === "color_pair"
        ? colorPair(tokens, "border")
        : undefined;

  const body = tokenOfKind(tokens, "body", "typography");
  const heading = tokenOfKind(tokens, "heading", "typography");
  const density = DENSITY[tokenOfKind(tokens, "density", "density")?.value ?? "comfortable"];

  const spacing = (key: string, fallback: string): string => {
    const token = tokenOfKind(tokens, key, "spacing");
    return (token === undefined ? undefined : rem(token.rem)) ?? fallback;
  };
  const corners = (key: string, fallback: string): string => {
    const token = tokenOfKind(tokens, key, "corners");
    return (token === undefined ? undefined : rem(token.rem)) ?? fallback;
  };
  const elevation = (key: string, fallback: string): string => {
    const token = tokenOfKind(tokens, key, "elevation");
    if (token === undefined || !Number.isInteger(token.level) || token.level < 0) return fallback;
    return PLATFORM_ELEVATION[Math.min(token.level, PLATFORM_ELEVATION.length - 1)] ?? fallback;
  };

  // Without a body token the page paints the default catalogue font; the heading paints the body
  // font unless the theme has a heading token.
  const bodyFamily = body === undefined ? fontStack(PLATFORM_FONTS.body) :
    (fontFamily(body.family, platformTokens) ?? FONT_FALLBACK);
  const headingFamily = (heading === undefined ? undefined : fontFamily(heading.family, platformTokens)) ?? bodyFamily;

  // Every shadcn colour comes from the resolved theme when the role is present and well formed,
  // otherwise from the registered platform release, so the bridge holds no second palette.
  const shadcnColour = (role: PlatformThemeTokenRoleKey): string =>
    colorValue(colorPair(tokens, role) ?? platformColor(platformTokens, role));
  // A fill and its #594-validated foreground change together, so a foreground is never painted on
  // a fill it was not judged against.
  const shadcnFill = (
    role: ShadcnFilledRole,
  ): readonly [fill: string, foreground: string] => {
    const [fill, foreground]: readonly [ColorPair, ColorPair] = filledPair(tokens, role) ?? [
      platformColor(platformTokens, role),
      platformColor(platformTokens, `${role}_foreground` as const),
    ];
    return [colorValue(fill), colorValue(foreground)];
  };
  const [card, cardForeground] = shadcnFill("card");
  const [popover, popoverForeground] = shadcnFill("popover");
  const [accent, accentForeground] = shadcnFill("accent");
  const [sidebar, sidebarForeground] = shadcnFill("sidebar");
  const [sidebarPrimary, sidebarPrimaryForeground] = shadcnFill("sidebar_primary");
  const [sidebarAccent, sidebarAccentForeground] = shadcnFill("sidebar_accent");

  return Object.freeze({
    "--vortex-surface": colorValue(surface),
    "--vortex-text": colorValue(text),
    "--vortex-text-muted": onSurface("muted_text", PLATFORM_DEFAULTS.textMuted),
    "--vortex-border-color": colorValue(borderColor ?? PLATFORM_DEFAULTS.border),
    "--vortex-accent": onSurface("primary", PLATFORM_DEFAULTS.accent),
    "--vortex-primary": colorValue(primary?.[0] ?? PLATFORM_DEFAULTS.primary),
    "--vortex-on-primary": colorValue(primary?.[1] ?? PLATFORM_DEFAULTS.onPrimary),
    "--vortex-secondary": colorValue(secondary?.[0] ?? PLATFORM_DEFAULTS.secondary),
    "--vortex-on-secondary": colorValue(secondary?.[1] ?? PLATFORM_DEFAULTS.onSecondary),
    "--vortex-danger": colorValue(danger?.[0] ?? PLATFORM_DEFAULTS.danger),
    "--vortex-on-danger": colorValue(danger?.[1] ?? PLATFORM_DEFAULTS.onDanger),
    "--vortex-danger-text": onSurface("danger_text", PLATFORM_DEFAULTS.dangerText),
    "--vortex-warning-text": onSurface("warning_text", PLATFORM_DEFAULTS.warningText),
    "--vortex-info-text": onSurface("info_text", PLATFORM_DEFAULTS.infoText),
    "--vortex-success-text": onSurface("success_text", PLATFORM_DEFAULTS.successText),
    "--vortex-focus-color": colorValue(
      focusColor ?? (surfaceValidated ? text : PLATFORM_DEFAULTS.focus),
    ),
    // Visible focus is never thinner than #594's 1px minimum.
    "--vortex-focus-width": (focus === undefined ? undefined : rem(focus.widthRem, 0.0625)) ?? "0.125rem",
    "--vortex-font-family": bodyFamily,
    "--vortex-font-size": (body === undefined ? undefined : rem(body.sizeRem, 0.5)) ?? "1rem",
    "--vortex-line-height": (body === undefined ? undefined : plainNumber(body.lineHeight)) ?? "1.5",
    "--vortex-font-weight": (body === undefined ? undefined : fontWeight(body.weight)) ?? "400",
    "--vortex-heading-font-family": headingFamily,
    "--vortex-heading-font-size": (heading === undefined ? undefined : rem(heading.sizeRem, 0.5)) ?? "1.25rem",
    "--vortex-heading-line-height":
      (heading === undefined ? undefined : plainNumber(heading.lineHeight)) ?? "1.25",
    "--vortex-heading-font-weight":
      (heading === undefined ? undefined : fontWeight(heading.weight)) ?? "700",
    "--font-sans-family": bodyFamily,
    "--font-heading-family": headingFamily,
    "--vortex-space-xs": spacing("space_xs", "0.25rem"),
    "--vortex-space-sm": spacing("space_sm", "0.5rem"),
    "--vortex-space-md": spacing("space_md", "1rem"),
    "--vortex-space-lg": spacing("space_lg", "1.5rem"),
    "--vortex-radius-sm": corners("radius_sm", "0.125rem"),
    "--vortex-radius-md": corners("radius_md", "0.25rem"),
    "--vortex-radius-lg": corners("radius_lg", "0.5rem"),
    "--vortex-border-width":
      (border?.kind === "border" ? rem(border.widthRem, 0.0625) : undefined) ?? "0.0625rem",
    "--vortex-border-style": border?.kind === "border" && border.style === "dashed" ? "dashed" : "solid",
    "--vortex-elevation-low": elevation("elevation_low", PLATFORM_ELEVATION[1]),
    "--vortex-elevation-high": elevation("elevation_high", PLATFORM_ELEVATION[3]),
    "--vortex-control-padding-y": density.controlY,
    "--vortex-control-padding-x": density.controlX,
    "--vortex-control-min-height": density.minHeight,
    "--vortex-cell-padding-y": density.cellY,
    "--vortex-cell-padding-x": density.cellX,
    "--background": colorValue(surface),
    "--foreground": colorValue(text),
    "--card": card,
    "--card-foreground": cardForeground,
    "--popover": popover,
    "--popover-foreground": popoverForeground,
    "--primary": colorValue(primary?.[0] ?? PLATFORM_DEFAULTS.primary),
    "--primary-foreground": colorValue(primary?.[1] ?? PLATFORM_DEFAULTS.onPrimary),
    "--secondary": colorValue(secondary?.[0] ?? PLATFORM_DEFAULTS.secondary),
    "--secondary-foreground": colorValue(secondary?.[1] ?? PLATFORM_DEFAULTS.onSecondary),
    "--muted": shadcnColour("muted"),
    "--muted-foreground": onSurface("muted_text", PLATFORM_DEFAULTS.textMuted),
    "--accent": accent,
    "--accent-foreground": accentForeground,
    "--destructive": colorValue(danger?.[0] ?? PLATFORM_DEFAULTS.danger),
    "--border": colorValue(borderColor ?? PLATFORM_DEFAULTS.border),
    "--input": shadcnColour("input"),
    "--ring": shadcnColour("ring"),
    "--chart-1": shadcnColour("chart_1"),
    "--chart-2": shadcnColour("chart_2"),
    "--chart-3": shadcnColour("chart_3"),
    "--chart-4": shadcnColour("chart_4"),
    "--chart-5": shadcnColour("chart_5"),
    "--radius": corners("radius_base", platformRadiusBase),
    "--sidebar": sidebar,
    "--sidebar-foreground": sidebarForeground,
    "--sidebar-primary": sidebarPrimary,
    "--sidebar-primary-foreground": sidebarPrimaryForeground,
    "--sidebar-accent": sidebarAccent,
    "--sidebar-accent-foreground": sidebarAccentForeground,
    "--sidebar-border": shadcnColour("sidebar_border"),
    "--sidebar-ring": shadcnColour("sidebar_ring"),
  } satisfies Record<ThemeVariableName, string>);
}

const COLOR_SCHEME: Readonly<Record<ThemeMode, string>> = {
  light: "light",
  dark: "dark",
  system: "light dark",
};

/** The cookie that holds the viewer's appearance choice, read by the server render. */
export const APPEARANCE_COOKIE = "vortex-appearance";

/** The appearance a cookie value names; anything else is the system preference. */
export function parseThemeMode(value: string | undefined): ThemeMode {
  return value === "light" || value === "dark" ? value : "system";
}

export type ThemeRootProps = Readonly<{
  style: CSSProperties;
  "data-vortex-theme": "";
}>;

export type AppearanceRootProps = Readonly<{
  style: CSSProperties;
  "data-vortex-theme-mode": ThemeMode;
}>;

/**
 * The viewer's appearance on the document root. Themed containers inherit the colour scheme and the
 * stylesheet's mode selectors match through this ancestor, so it is the one place appearance is set.
 */
export function createAppearanceRootProps(mode: ThemeMode): AppearanceRootProps {
  return { style: { colorScheme: COLOR_SCHEME[mode] }, "data-vortex-theme-mode": mode };
}

/**
 * Props that mount the theme on a runtime page or preview canvas container. The shared
 * component stylesheet is scoped to `[data-vortex-theme]`.
 */
export function createThemeRootProps(
  theme: ApplicationTheme | undefined,
  platformThemeTokens: PlatformThemeTokens,
): ThemeRootProps {
  // The theme's own loader cycle replaces the platform's 5s token; a theme without one keeps it.
  const loaderCycle = theme?.loaderMark?.cycleSeconds;
  const style: CSSProperties & ThemeCssVariables = {
    ...generateThemeCssVariables(platformThemeTokens, theme?.tokens),
    ...(loaderCycle !== undefined && Number.isFinite(loaderCycle) && loaderCycle > 0
      ? { "--vortex-loader-cycle": `${loaderCycle}s` }
      : {}),
  };
  return { style, "data-vortex-theme": "" };
}

/**
 * Theme tokens in force at one point of the placement tree: the application tokens and the
 * effective tokens of the nearest ancestor placement that declared overrides.
 */
export type PlacementThemeScope = Readonly<{
  application: ThemeTokens;
  inherited: ThemeTokens;
}>;

/**
 * Applies one placement's declared theme overrides. Its subtree uses exactly the token set
 * that definition compilation and #594 validated for it (application tokens plus its own
 * overrides), expressed as the variables that differ from what it would otherwise inherit.
 */
export function resolvePlacementTheme(
  scope: PlacementThemeScope,
  overrides: ThemeTokens,
  platformThemeTokens: PlatformThemeTokens,
): Readonly<{ style: CSSProperties | undefined; scope: PlacementThemeScope }> {
  if (Object.keys(overrides).length === 0) return { style: undefined, scope };
  const effective: ThemeTokens = { ...scope.application, ...overrides };
  const next = generateThemeCssVariables(platformThemeTokens, effective);
  const current = generateThemeCssVariables(platformThemeTokens, scope.inherited);
  const changed: CSSProperties & Partial<Record<ThemeVariableName, string>> = {};
  for (const name of THEME_VARIABLE_NAMES) {
    if (next[name] !== current[name]) changed[name] = next[name];
  }
  return {
    style: Object.keys(changed).length === 0 ? undefined : changed,
    scope: { application: scope.application, inherited: effective },
  };
}
