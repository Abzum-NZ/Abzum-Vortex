import "server-only";

import {
  SHADCN_HEADING_FONT_INHERIT,
  findShadcnFont,
  findShadcnThemeCatalogueOption,
  isShadcnIconLibrary,
  shadcnThemeCatalogueDimensionKeys,
  sourceApplicationThemeSelectionV2Schema,
  type ShadcnThemeCatalogueDimensionKey,
  type SourceApplicationThemeSelectionV2,
} from "@vortex/contracts";
import { findShadcnThemeRelease } from "@vortex/contracts/shadcn-theme-releases";
import {
  decodePreset,
  encodePreset,
  isPresetCode,
  V1_CHART_COLOR_MAP,
} from "shadcn/preset";

type PresetSourceKind = "code" | "url";

type ParsedPresetInput = Readonly<{
  kind: PresetSourceKind;
  code: string;
}>;

type PresetInputFailure = Readonly<{
  code:
    | "INVALID_PRESET_SOURCE"
    | "INVALID_PRESET_CODE"
    | "UNSUPPORTED_PRESET_URL"
    | "PRESET_SOURCE_TOO_LONG";
  message: string;
}>;

const MAX_PRESET_SOURCE_LENGTH = 2048;

const RELEASE_BACKED_DIMENSIONS: ReadonlySet<ShadcnThemeCatalogueDimensionKey> = new Set([
  "baseColor",
  "theme",
  "chartColor",
  "radius",
]);

export type ShadcnPresetImportFailure = Readonly<{
  code:
    | "UNKNOWN_THEME_OPTION"
    | "REFUSED_THEME_OPTION"
    | "MISSING_THEME_RELEASE"
    | "MISSING_STYLE_ASSET"
    | "INVALID_THEME_SELECTION";
  dimension?: ShadcnThemeCatalogueDimensionKey | "iconLibrary" | "bodyFont" | "headingFont" | undefined;
  value?: string | undefined;
  message: string;
}>;

export type ShadcnPresetDimensionNotYetImportable = Readonly<{
  dimension: "font" | "fontHeading" | "iconLibrary";
  value: string;
  status: "not_yet_importable";
  message: string;
}>;

export type ShadcnPresetImportDraft =
  | Readonly<{
      status: "draft";
      applied: false;
      source: PresetSourceKind;
      presetCode: string;
      version: "a" | "b";
      selection: SourceApplicationThemeSelectionV2;
      notYetImportable: readonly ShadcnPresetDimensionNotYetImportable[];
    }>
  | Readonly<{
      status: "refused";
      applied: false;
      source?: PresetSourceKind | undefined;
      presetCode?: string | undefined;
      version?: "a" | "b" | undefined;
      failures: readonly (PresetInputFailure | ShadcnPresetImportFailure)[];
      notYetImportable: readonly ShadcnPresetDimensionNotYetImportable[];
    }>;

const parsePresetInput = (input: unknown): ParsedPresetInput | PresetInputFailure => {
  if (typeof input !== "string") {
    return {
      code: "INVALID_PRESET_SOURCE",
      message: "The preset input must be a string containing a preset code or URL.",
    };
  }

  if (input.length > MAX_PRESET_SOURCE_LENGTH) {
    return {
      code: "PRESET_SOURCE_TOO_LONG",
      message: "The preset code or URL must be no longer than 2048 characters.",
    };
  }

  const value = input.trim();
  if (isPresetCode(value)) return { kind: "code", code: value };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      code: "INVALID_PRESET_SOURCE",
      message:
        "Enter a shadcn preset code or an HTTPS preset URL from ui.shadcn.com/create.",
    };
  }

  if (
    url.origin !== "https://ui.shadcn.com" ||
    url.pathname !== "/create" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    return {
      code: "UNSUPPORTED_PRESET_URL",
      message:
        "The preset URL must use https://ui.shadcn.com/create and must not include credentials or a fragment.",
    };
  }

  const queryKeys = [...url.searchParams.keys()];
  if (queryKeys.some((key) => key !== "preset")) {
    return {
      code: "UNSUPPORTED_PRESET_URL",
      message: "The preset URL may contain only one preset query parameter.",
    };
  }

  const codes = url.searchParams.getAll("preset");
  const code = codes[0];
  if (codes.length !== 1 || code === undefined || !isPresetCode(code)) {
    return {
      code: "INVALID_PRESET_CODE",
      message: "The shadcn preset URL must contain exactly one valid preset code.",
    };
  }

  return { kind: "url", code };
};

const unavailableOptionFailure = (
  dimension: ShadcnThemeCatalogueDimensionKey,
  value: string,
): ShadcnPresetImportFailure => ({
  code: "UNKNOWN_THEME_OPTION",
  dimension,
  value,
  message: `The preset ${dimension} value "${value}" is not available in the pinned theme catalogue.`,
});

const presetSelectionValues = (
  decoded: PresetConfig,
): Record<ShadcnThemeCatalogueDimensionKey, string> => ({
  style: decoded.style,
  baseColor: decoded.baseColor,
  theme: decoded.theme,
  chartColor: decoded.chartColor ?? V1_CHART_COLOR_MAP[decoded.theme] ?? decoded.theme,
  radius: decoded.radius,
  menuColor: decoded.menuColor,
  menuAccent: decoded.menuAccent,
});

/**
 * Drafts the application theme selection represented by a shadcn preset code or create URL.
 * This is a pure operation shared by the designer, API and MCP: it returns selections for review
 * and never writes them into an application draft. Preset URLs are parsed locally and never fetched.
 */
export const draftShadcnPresetImport = (input: unknown): ShadcnPresetImportDraft => {
  const parsedInput = parsePresetInput(input);
  if (!("kind" in parsedInput)) {
    return {
      status: "refused",
      applied: false,
      failures: [parsedInput],
      notYetImportable: [],
    };
  }

  const { kind, code } = parsedInput;
  const version = code[0] === "a" ? "a" : "b";
  const decoded = decodePreset(code);
  // The pinned decoder substitutes defaults for out-of-range field indexes. Re-encoding must
  // reproduce the exact payload so malformed indexes, overflow bits and aliases are refused.
  // Version "a" has no chart colour or heading font, so its decoded defaults add only zero bits.
  if (decoded === null || encodePreset(decoded).slice(1) !== code.slice(1)) {
    return {
      status: "refused",
      applied: false,
      source: kind,
      presetCode: code,
      version,
      failures: [
        {
          code: "INVALID_PRESET_CODE",
          message: "The shadcn preset code is invalid or not in its canonical form.",
        },
      ],
      notYetImportable: [],
    };
  }

  const unsupportedDimensions: readonly ShadcnPresetDimensionNotYetImportable[] = [];
  const values = presetSelectionValues(decoded);
  const selectedOptions: Partial<Record<ShadcnThemeCatalogueDimensionKey, string>> = {};
  const failures: ShadcnPresetImportFailure[] = [];

  for (const dimension of shadcnThemeCatalogueDimensionKeys) {
    const value = values[dimension];
    const option = findShadcnThemeCatalogueOption(dimension, value);
    if (option === undefined) {
      failures.push(unavailableOptionFailure(dimension, value));
      continue;
    }
    if (option.release?.refused === true) {
      failures.push({
        code: "REFUSED_THEME_OPTION",
        dimension,
        value,
        message: `The preset ${dimension} value "${value}" is refused by the pinned theme catalogue.`,
      });
      continue;
    }
    const release =
      option.releaseKey === undefined ? undefined : findShadcnThemeRelease(option.releaseKey);
    if (
      (RELEASE_BACKED_DIMENSIONS.has(dimension) && release === undefined) ||
      (option.releaseKey !== undefined && release === undefined)
    ) {
      failures.push({
        code: "MISSING_THEME_RELEASE",
        dimension,
        value,
        message: `The preset ${dimension} value "${value}" has no theme release in the pinned catalogue.`,
      });
      continue;
    }
    if (dimension === "style" && option.asset === undefined) {
      failures.push({
        code: "MISSING_STYLE_ASSET",
        dimension,
        value,
        message: `The preset style value "${value}" has no stylesheet in the pinned catalogue.`,
      });
      continue;
    }

    selectedOptions[dimension] = option.id;
  }

  if (!isShadcnIconLibrary(decoded.iconLibrary))
    failures.push({
      code: "UNKNOWN_THEME_OPTION",
      dimension: "iconLibrary",
      value: decoded.iconLibrary,
      message: `The preset iconLibrary value "${decoded.iconLibrary}" is not available in the pinned icon catalogue.`,
    });
  // The preset's `font` is the body font and its `fontHeading` the heading font, which may be
  // `inherit`; both are offered by the font catalogue rather than the colour and style index.
  if (findShadcnFont(decoded.font) === undefined)
    failures.push({
      code: "UNKNOWN_THEME_OPTION",
      dimension: "bodyFont",
      value: decoded.font,
      message: `The preset font value "${decoded.font}" is not available in the pinned font catalogue.`,
    });
  if (decoded.fontHeading !== SHADCN_HEADING_FONT_INHERIT && findShadcnFont(decoded.fontHeading) === undefined)
    failures.push({
      code: "UNKNOWN_THEME_OPTION",
      dimension: "headingFont",
      value: decoded.fontHeading,
      message: `The preset fontHeading value "${decoded.fontHeading}" is not available in the pinned font catalogue.`,
    });

  if (failures.length > 0) {
    return {
      status: "refused",
      applied: false,
      source: kind,
      presetCode: code,
      version,
      failures: Object.freeze(failures),
      notYetImportable: unsupportedDimensions,
    };
  }

  const parsedSelection = sourceApplicationThemeSelectionV2Schema.safeParse({
    style: selectedOptions.style,
    base_color: selectedOptions.baseColor,
    theme: selectedOptions.theme,
    chart_color: selectedOptions.chartColor,
    radius: selectedOptions.radius,
    menu_color: selectedOptions.menuColor,
    menu_accent: selectedOptions.menuAccent,
    icon_library: decoded.iconLibrary,
    body_font: decoded.font,
    heading_font: decoded.fontHeading,
  });
  if (!parsedSelection.success) {
    return {
      status: "refused",
      applied: false,
      source: kind,
      presetCode: code,
      version,
      failures: [
        {
          code: "INVALID_THEME_SELECTION",
          message: `The decoded preset selection does not match the application draft theme contract: ${parsedSelection.error.message}`,
        },
      ],
      notYetImportable: unsupportedDimensions,
    };
  }

  return {
    status: "draft",
    applied: false,
    source: kind,
    presetCode: code,
    version,
    selection: parsedSelection.data,
    notYetImportable: unsupportedDimensions,
  };
};
