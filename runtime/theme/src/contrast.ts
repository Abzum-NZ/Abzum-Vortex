import "server-only";

import { platformThemeTokenRolesV2, type DefinitionRuleFailure } from "@vortex/contracts";
import { createLocatedFailure } from "./errors";
import type {
  ThemeResolutionOptions,
  ThemeTokenValueV2,
  ThemeValidationFailure,
} from "./types";

export const WCAG_AA_NORMAL_TEXT_MIN_CONTRAST = 4.5;
export const WCAG_AA_LARGE_TEXT_MIN_CONTRAST = 3.0;
export const WCAG_AA_NON_TEXT_MIN_CONTRAST = 3.0;

/** The vocabulary's brand fill, which the renderer also paints on the surface as the accent. */
const ACCENT_TOKEN_KEY = "primary";

export const DEFAULT_LIGHT_SURFACE = "#FFFFFF";
export const DEFAULT_DARK_SURFACE = "#000000";

type RgbaColor = Readonly<{ r: number; g: number; b: number; a: number }>;

const COLOR_COMPONENT = "(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
const OKLCH_COLOR = new RegExp(
  `^oklch\\(\\s*(${COLOR_COMPONENT})(%?)\\s+(${COLOR_COMPONENT})\\s+(${COLOR_COMPONENT})(?:deg)?\\s*(?:\\/\\s*(${COLOR_COMPONENT})(%?))?\\s*\\)$`,
);

/** The CSS Color 4 just-noticeable difference in OKLab used by its sRGB gamut mapping. */
const GAMUT_MAPPING_JND = 0.02;
const GAMUT_MAPPING_EPSILON = 0.0001;

type Triple = readonly [number, number, number];

function parseHex(hex: string): RgbaColor {
  const clean = hex.startsWith("#") ? hex.slice(1) : hex;
  if (!/^(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(clean))
    throw new Error(`Invalid hex color: "${hex}"`);
  const expanded =
    clean.length <= 4
      ? [...clean].map((character) => character + character).join("")
      : clean;
  return {
    r: parseInt(expanded.slice(0, 2), 16),
    g: parseInt(expanded.slice(2, 4), 16),
    b: parseInt(expanded.slice(4, 6), 16),
    a: expanded.length === 8 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1,
  };
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

/** OKLab to linear-light sRGB (Ottosson's published matrices). */
function oklabToLinearSrgb(lightness: number, labA: number, labB: number): Triple {
  const l = (lightness + 0.3963377774 * labA + 0.2158037573 * labB) ** 3;
  const m = (lightness - 0.1055613458 * labA - 0.0638541728 * labB) ** 3;
  const s = (lightness - 0.0894841775 * labA - 1.291485548 * labB) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Linear-light sRGB to OKLab, the inverse of `oklabToLinearSrgb`. */
function linearSrgbToOklab([r, g, b]: Triple): Triple {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

const encodeSrgb = (linear: number): number =>
  linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
const decodeSrgb = (encoded: number): number =>
  encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;

/** Clips each gamma-encoded channel into sRGB and returns the result in linear light. */
const clipLinearSrgb = (linear: Triple): Triple =>
  linear.map((channel) => decodeSrgb(clamp(encodeSrgb(channel), 0, 1))) as unknown as Triple;

const inSrgbGamut = (linear: Triple): boolean =>
  linear.every((channel) => {
    const encoded = encodeSrgb(channel);
    return encoded >= -GAMUT_MAPPING_EPSILON && encoded <= 1 + GAMUT_MAPPING_EPSILON;
  });

const deltaEOk = (left: Triple, right: Triple): number => {
  const [l1, a1, b1] = linearSrgbToOklab(left);
  const [l2, a2, b2] = linearSrgbToOklab(right);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};

/**
 * Maps one OKLCH colour into sRGB with the CSS Color 4 gamut-mapping algorithm: lightness at or
 * beyond the ends is white or black, and an out-of-gamut colour keeps its lightness and hue while
 * its chroma is reduced until clipping it moves it less than one just-noticeable difference. The
 * contrast checks therefore judge the colour a browser paints, not an unrepresentable one.
 */
function oklchToLinearSrgb(lightness: number, chroma: number, hueDegrees: number): Triple {
  if (lightness >= 1) return [1, 1, 1];
  if (lightness <= 0) return [0, 0, 0];
  const hue = (hueDegrees * Math.PI) / 180;
  const atChroma = (value: number): Triple =>
    oklabToLinearSrgb(lightness, value * Math.cos(hue), value * Math.sin(hue));
  const original = atChroma(chroma);
  if (inSrgbGamut(original)) return clipLinearSrgb(original);
  if (deltaEOk(original, clipLinearSrgb(original)) < GAMUT_MAPPING_JND)
    return clipLinearSrgb(original);
  let minimum = 0;
  let maximum = chroma;
  let minimumInGamut = true;
  while (maximum - minimum > GAMUT_MAPPING_EPSILON) {
    const candidateChroma = (minimum + maximum) / 2;
    const candidate = atChroma(candidateChroma);
    if (minimumInGamut && inSrgbGamut(candidate)) {
      minimum = candidateChroma;
      continue;
    }
    const clipped = clipLinearSrgb(candidate);
    const error = deltaEOk(candidate, clipped);
    if (error < GAMUT_MAPPING_JND) {
      if (GAMUT_MAPPING_JND - error < GAMUT_MAPPING_EPSILON) return clipped;
      minimumInGamut = false;
      minimum = candidateChroma;
    } else {
      maximum = candidateChroma;
    }
  }
  return clipLinearSrgb(atChroma(minimum));
}

/**
 * Converts one oklch() colour to 8-bit-scale sRGB. Lightness is a number or a percentage of 1,
 * alpha a number or a percentage of 1, both clamped to their CSS range as a browser does.
 */
function parseOklch(value: string): RgbaColor {
  const match = OKLCH_COLOR.exec(value);
  if (match === null) throw new Error(`Invalid oklch color: "${value}"`);
  const [, lightnessText, lightnessPercent, chromaText, hueText, alphaText, alphaPercent] = match;
  const lightness = clamp(Number(lightnessText) / (lightnessPercent === "%" ? 100 : 1), 0, 1);
  const alpha =
    alphaText === undefined ? 1 : clamp(Number(alphaText) / (alphaPercent === "%" ? 100 : 1), 0, 1);
  const [r, g, b] = oklchToLinearSrgb(lightness, Number(chromaText), Number(hueText) % 360);
  const toChannel = (linear: number): number => clamp(encodeSrgb(linear), 0, 1) * 255;
  return { r: toChannel(r), g: toChannel(g), b: toChannel(b), a: alpha };
}

/** Parses a six-digit hex or oklch() color value; any other form is refused. */
function parseColor(value: string): RgbaColor {
  return value.startsWith("oklch(") ? parseOklch(value) : parseHex(value);
}

/** Whether a six-digit hex or oklch() colour paints fully opaque. */
function isOpaqueColor(value: string): boolean {
  return parseColor(value).a === 1;
}

function composite(foreground: RgbaColor, background: RgbaColor): RgbaColor {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: alpha,
  };
}

function requireOpaque(color: RgbaColor, role: string): RgbaColor {
  if (color.a !== 1) throw new Error(`${role} must resolve to an opaque color`);
  return color;
}

function channelLuminance(channel: number): number {
  const sRGB = channel / 255;
  return sRGB <= 0.04045 ? sRGB / 12.92 : Math.pow((sRGB + 0.055) / 1.055, 2.4);
}

function colorLuminance({ r, g, b }: RgbaColor): number {
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/** Calculates luminance after composing a translucent color over an opaque background. */
export function relativeLuminance(color: string, background = DEFAULT_LIGHT_SURFACE): number {
  const backdrop = requireOpaque(parseColor(background), "Luminance background");
  return colorLuminance(composite(parseColor(color), backdrop));
}

/**
 * Calculates foreground/background contrast after alpha-compositing both layers onto
 * an opaque canvas. Argument order is significant when either color is translucent.
 * Either color may be a six-digit hex value or an oklch() function.
 */
export function contrastRatio(
  foreground: string,
  background: string,
  canvas = DEFAULT_LIGHT_SURFACE,
): number {
  const opaqueCanvas = requireOpaque(parseColor(canvas), "Contrast canvas");
  const effectiveBackground = composite(parseColor(background), opaqueCanvas);
  const effectiveForeground = composite(parseColor(foreground), effectiveBackground);
  const lumA = colorLuminance(effectiveForeground);
  const lumB = colorLuminance(effectiveBackground);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Whether a theme's catalogue declares any colour role. Every materialised theme comes from a
 * platform release that declares the shared vocabulary's roles, so readability is judged only
 * by those declarations and never by token names. A theme that declares no roles, or declares
 * one other than the vocabulary's, is refused by `validateThemeContrast`.
 */
export function declaresColorRoles(tokens: Readonly<Record<string, ThemeTokenValueV2>>): boolean {
  return Object.values(tokens).some(
    (token) => token.kind === "color_pair" && token.role !== undefined,
  );
}

/**
 * The surface a theme paints text and brand colours on: the colour pair the shared vocabulary
 * declares with the `background` role. The priority order only settles which declared
 * background role wins; token names never decide whether a colour is a surface.
 */
export function findThemeSurface(
  tokens: Readonly<Record<string, ThemeTokenValueV2>>,
): Readonly<{ key?: string; light: string; dark: string; name: string }> {
  const backgrounds = Object.keys(tokens)
    .sort()
    .flatMap((key) => {
      const token = tokens[key];
      return token?.kind === "color_pair" && token.role === "background"
        ? [[key, token] as const]
        : [];
    });
  const exactPriority = ["background", "canvas", "surface", "bg", "page_background", "app_background"];
  const selected =
    exactPriority.flatMap((candidate) =>
      backgrounds.filter(([key]) => key.toLowerCase() === candidate),
    )[0] ?? backgrounds[0];
  if (selected === undefined)
    return {
      light: DEFAULT_LIGHT_SURFACE,
      dark: DEFAULT_DARK_SURFACE,
      name: "default surface",
    };
  return {
    key: selected[0],
    light: selected[1].light,
    dark: selected[1].dark,
    name: selected[0],
  };
}

export function validateThemeContrast(
  tokens: Readonly<Record<string, ThemeTokenValueV2>>,
  options?: ThemeResolutionOptions | undefined,
): { failures: ThemeValidationFailure[]; ruleFailures: DefinitionRuleFailure[] } {
  const failures: ThemeValidationFailure[] = [];
  const ruleFailures: DefinitionRuleFailure[] = [];

  const addFailure = (params: {
    code: string;
    ruleCode?: string;
    family?: "invalid_value" | "unsafe_content" | "broken_reference";
    message: string;
    tokenKey?: string;
  }) => {
    const located = createLocatedFailure({
      ...params,
      documentKey: options?.documentKey,
    });
    failures.push(located.failure);
    ruleFailures.push(located.ruleFailure);
  };

  // The renderer paints each vocabulary colour by its key, so a vocabulary colour must carry
  // exactly the role the vocabulary declares for it; otherwise the checks below would judge it
  // as something other than what is painted.
  for (const role of platformThemeTokenRolesV2) {
    const token = tokens[role.key];
    if (token?.kind !== "color_pair") continue;
    const declared: string | undefined = "colorRole" in role ? role.colorRole : undefined;
    if (token.role !== declared)
      addFailure({
        code: "COLOR_ROLE_MISMATCH",
        family: "invalid_value",
        message:
          declared === undefined
            ? `Colour token "${role.key}" must not declare a colour role; the shared token vocabulary gives it none`
            : `Colour token "${role.key}" must declare the "${declared}" colour role the shared token vocabulary gives it`,
        tokenKey: role.key,
      });
  }

  const surface = findThemeSurface(tokens);
  if (surface.key === undefined) {
    addFailure({
      code: "MISSING_BACKGROUND_ROLE",
      family: "invalid_value",
      message: "A theme must declare a colour with the background role",
    });
  }
  // An oklch() value can carry alpha, but the surface is the opaque canvas every other colour is
  // judged on and painted over, so a translucent surface is refused rather than judged.
  if (surface.key !== undefined && !(isOpaqueColor(surface.light) && isOpaqueColor(surface.dark))) {
    addFailure({
      code: "TRANSLUCENT_BACKGROUND",
      family: "invalid_value",
      message: `Background colour token "${surface.key}" must be opaque in both light and dark mode`,
      tokenKey: surface.key,
    });
    return { failures, ruleFailures };
  }
  const lightSurface = surface.light;
  const darkSurface = surface.dark;
  const surfaceName = surface.name;
  // A fill's foreground is the vocabulary pair `<fill>_foreground`; nothing else marks it.
  const pairedForegroundKeys = new Set<string>();
  for (const key of Object.keys(tokens).sort()) {
    if (tokens[key]?.kind !== "color_pair") continue;
    if (tokens[`${key}_foreground`]?.kind === "color_pair")
      pairedForegroundKeys.add(`${key}_foreground`);
  }

  // Validate each declared text/foreground colour against what it is painted on, and each
  // declared foreground against its paired fill. Token names never decide a colour's role.
  for (const key of Object.keys(tokens).sort()) {
    const token = tokens[key];
    if (token === undefined) continue;
    if (token.kind !== "color_pair") continue;
    if (key === surface.key) continue;

    // A paired foreground is evaluated against its declared companion below. It
    // need not also contrast with the application surface on which it is not used.
    if (token.role === "foreground" && !pairedForegroundKeys.has(key)) {
      const lightRatio = contrastRatio(token.light, lightSurface, DEFAULT_LIGHT_SURFACE);
      if (lightRatio < WCAG_AA_NORMAL_TEXT_MIN_CONTRAST) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Text color token "${key}" has insufficient light mode contrast ratio (${lightRatio.toFixed(2)}:1 < ${WCAG_AA_NORMAL_TEXT_MIN_CONTRAST}:1) against ${surfaceName} (${lightSurface})`,
          tokenKey: key,
        });
      }
      const darkRatio = contrastRatio(token.dark, darkSurface, DEFAULT_DARK_SURFACE);
      if (darkRatio < WCAG_AA_NORMAL_TEXT_MIN_CONTRAST) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Text color token "${key}" has insufficient dark mode contrast ratio (${darkRatio.toFixed(2)}:1 < ${WCAG_AA_NORMAL_TEXT_MIN_CONTRAST}:1) against ${surfaceName} (${darkSurface})`,
          tokenKey: key,
        });
      }
    }

    // The renderer also paints the brand fill directly on the surface as the accent
    // (selection bars, checked controls, active tabs), so it must stay visible there.
    if (key === ACCENT_TOKEN_KEY) {
      const lightRatio = contrastRatio(token.light, lightSurface, DEFAULT_LIGHT_SURFACE);
      if (lightRatio < WCAG_AA_NON_TEXT_MIN_CONTRAST) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Brand color token "${key}" has insufficient light mode contrast ratio (${lightRatio.toFixed(2)}:1 < ${WCAG_AA_NON_TEXT_MIN_CONTRAST}:1) against ${surfaceName} (${lightSurface})`,
          tokenKey: key,
        });
      }
      const darkRatio = contrastRatio(token.dark, darkSurface, DEFAULT_DARK_SURFACE);
      if (darkRatio < WCAG_AA_NON_TEXT_MIN_CONTRAST) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Brand color token "${key}" has insufficient dark mode contrast ratio (${darkRatio.toFixed(2)}:1 < ${WCAG_AA_NON_TEXT_MIN_CONTRAST}:1) against ${surfaceName} (${darkSurface})`,
          tokenKey: key,
        });
      }
    }

    // Check paired tokens: the vocabulary names a fill's foreground `<fill>_foreground`.
    const foregroundKey = `${key}_foreground`;
    const pairedForeground = tokens[foregroundKey];
    if (pairedForeground !== undefined && pairedForeground.kind === "color_pair") {
      const lightRatio = contrastRatio(pairedForeground.light, token.light, lightSurface);
      if (lightRatio < WCAG_AA_NORMAL_TEXT_MIN_CONTRAST) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Paired color token "${foregroundKey}" has insufficient light mode contrast ratio (${lightRatio.toFixed(2)}:1 < ${WCAG_AA_NORMAL_TEXT_MIN_CONTRAST}:1) against "${key}"`,
          tokenKey: foregroundKey,
        });
      }
      const darkRatio = contrastRatio(pairedForeground.dark, token.dark, darkSurface);
      if (darkRatio < WCAG_AA_NORMAL_TEXT_MIN_CONTRAST) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Paired color token "${foregroundKey}" has insufficient dark mode contrast ratio (${darkRatio.toFixed(2)}:1 < ${WCAG_AA_NORMAL_TEXT_MIN_CONTRAST}:1) against "${key}"`,
          tokenKey: foregroundKey,
        });
      }
    }
  }

  // Check explicit contrast pairs if provided in options
  if (options?.contrastPairs !== undefined) {
    for (const pair of options.contrastPairs) {
      const fgToken = tokens[pair.foregroundTokenKey];
      const bgToken = tokens[pair.backgroundTokenKey];
      const requiredRatio =
        pair.usage === "large_text"
          ? WCAG_AA_LARGE_TEXT_MIN_CONTRAST
          : pair.usage === "non_text"
            ? WCAG_AA_NON_TEXT_MIN_CONTRAST
            : WCAG_AA_NORMAL_TEXT_MIN_CONTRAST;
      if (
        pair.minimumRatio !== undefined &&
        (!Number.isFinite(pair.minimumRatio) ||
          pair.minimumRatio < requiredRatio ||
          pair.minimumRatio > 21)
      ) {
        addFailure({
          code: "INVALID_CONTRAST_RATIO",
          family: "invalid_value",
          message: `Contrast pair "${pair.foregroundTokenKey}" on "${pair.backgroundTokenKey}" must use a finite minimum ratio from ${requiredRatio}:1 to 21:1 for ${pair.usage ?? "normal_text"}`,
          tokenKey: pair.foregroundTokenKey,
        });
        continue;
      }
      const minRatio = pair.minimumRatio ?? requiredRatio;

      if (fgToken === undefined) {
        addFailure({
          code: "BROKEN_TOKEN_REFERENCE",
          family: "broken_reference",
          message: `Contrast pair references missing foreground token "${pair.foregroundTokenKey}"`,
          tokenKey: pair.foregroundTokenKey,
        });
        continue;
      }
      if (bgToken === undefined) {
        addFailure({
          code: "BROKEN_TOKEN_REFERENCE",
          family: "broken_reference",
          message: `Contrast pair references missing background token "${pair.backgroundTokenKey}"`,
          tokenKey: pair.backgroundTokenKey,
        });
        continue;
      }
      if (fgToken.kind !== "color_pair") {
        addFailure({
          code: "INVALID_TOKEN_KIND",
          family: "invalid_value",
          message: `Foreground token "${pair.foregroundTokenKey}" in contrast pair must be of kind "color_pair", found "${fgToken.kind}"`,
          tokenKey: pair.foregroundTokenKey,
        });
        continue;
      }
      if (bgToken.kind !== "color_pair") {
        addFailure({
          code: "INVALID_TOKEN_KIND",
          family: "invalid_value",
          message: `Background token "${pair.backgroundTokenKey}" in contrast pair must be of kind "color_pair", found "${bgToken.kind}"`,
          tokenKey: pair.backgroundTokenKey,
        });
        continue;
      }

      const lightRatio = contrastRatio(fgToken.light, bgToken.light, lightSurface);
      if (lightRatio < minRatio) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Contrast pair "${pair.foregroundTokenKey}" on "${pair.backgroundTokenKey}" has insufficient light mode contrast ratio (${lightRatio.toFixed(2)}:1 < ${minRatio}:1)`,
          tokenKey: pair.foregroundTokenKey,
        });
      }
      const darkRatio = contrastRatio(fgToken.dark, bgToken.dark, darkSurface);
      if (darkRatio < minRatio) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Contrast pair "${pair.foregroundTokenKey}" on "${pair.backgroundTokenKey}" has insufficient dark mode contrast ratio (${darkRatio.toFixed(2)}:1 < ${minRatio}:1)`,
          tokenKey: pair.foregroundTokenKey,
        });
      }
    }
  }

  return { failures, ruleFailures };
}
