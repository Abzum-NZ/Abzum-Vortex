import { decodePreset, encodePreset, generateRandomConfig, isPresetCode, type PresetConfig } from "shadcn/preset";
import type { SourceApplicationThemeSelection } from "@vortex/platform/schema";

/**
 * shadcn create's preset codes and its Shuffle, from the pinned shadcn 4.21.0 package itself, so
 * Studio reads a pasted code exactly as shadcn create wrote it. Codes and shuffled settings are
 * mapped onto the application's one theme selection; whether each option is offered is judged by
 * the caller against the checked-in catalogue.
 */

/** The preset's settings in the application selection's own keys. */
const fromPreset = (config: PresetConfig & { chartColor: string }): SourceApplicationThemeSelection => ({
  style: config.style,
  base_color: config.baseColor,
  theme: config.theme,
  chart_color: config.chartColor,
  radius: config.radius,
  menu_color: config.menuColor,
  menu_accent: config.menuAccent,
  icon_library: config.iconLibrary,
  body_font: config.font,
  heading_font: config.fontHeading,
});

export type StudioThemePresetResult =
  | Readonly<{ kind: "decoded"; selection: SourceApplicationThemeSelection }>
  | Readonly<{ kind: "refused"; message: string }>;

/**
 * Reads one shadcn create preset code. A code is accepted only when the pinned decoder reads it and
 * encoding the result gives the same code back, so a mistyped character, a value outside the
 * pinned lists or a code from another shadcn version is refused rather than read as defaults.
 */
export const decodeStudioThemePreset = (code: string): StudioThemePresetResult => {
  const trimmed = code.trim();
  if (trimmed.length === 0) return { kind: "refused", message: "Paste a preset code, for example b5eFaVxg0." };
  if (!isPresetCode(trimmed))
    return { kind: "refused", message: `“${trimmed}” is not a shadcn preset code. A code starts with “b” and has at most 10 letters and digits.` };
  const decoded = decodePreset(trimmed);
  if (decoded === null || decoded.chartColor === undefined || encodePreset(decoded) !== trimmed)
    return { kind: "refused", message: `The preset code “${trimmed}” is not one shadcn 4.21.0 create produces. Copy the code again from shadcn create.` };
  return { kind: "decoded", selection: fromPreset({ ...decoded, chartColor: decoded.chartColor }) };
};

/** The preset code for a selection, as shadcn create would show it. */
export const encodeStudioThemePreset = (selection: SourceApplicationThemeSelection): string =>
  encodePreset({
    style: selection.style as PresetConfig["style"],
    baseColor: selection.base_color as PresetConfig["baseColor"],
    theme: selection.theme as PresetConfig["theme"],
    chartColor: selection.chart_color as NonNullable<PresetConfig["chartColor"]>,
    radius: selection.radius as PresetConfig["radius"],
    menuColor: selection.menu_color as PresetConfig["menuColor"],
    menuAccent: selection.menu_accent as PresetConfig["menuAccent"],
    iconLibrary: selection.icon_library as PresetConfig["iconLibrary"],
    font: selection.body_font as PresetConfig["font"],
    fontHeading: selection.heading_font as PresetConfig["fontHeading"],
  });

/** One random combination, drawn the way shadcn create's Shuffle draws it. */
export const shuffleStudioThemeSelection = (): SourceApplicationThemeSelection => {
  const config = generateRandomConfig();
  const chartColor = config.chartColor;
  if (chartColor === undefined) throw new Error("shadcn's Shuffle drew no chart colour");
  return fromPreset({ ...config, chartColor });
};
