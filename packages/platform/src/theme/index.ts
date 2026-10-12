import "server-only";

import { contrastRatio, relativeLuminance, validateThemeContrast } from "./contrast";
import { validateFocusVisibility } from "./focus";
import { validatePublicPlatformAssets } from "./assets";
import { validateComponentThemeOverrides } from "./overrides";
import { resolveTheme, resolveThemeTokens, validateApplicationTheme } from "./resolver";
import { draftShadcnPresetImport } from "./preset-import";
import { resolveThemeSelection, validateThemeSelectionOptions } from "./selection";

export {
  contrastRatio,
  relativeLuminance,
  validateThemeContrast,
  WCAG_AA_NON_TEXT_MIN_CONTRAST,
} from "./contrast";

export { validateFocusVisibility } from "./focus";

export { validatePublicPlatformAssets } from "./assets";

export { validateComponentThemeOverrides } from "./overrides";

export { resolveTheme, resolveThemeTokens, validateApplicationTheme } from "./resolver";

export { draftShadcnPresetImport } from "./preset-import";

export type {
  ShadcnPresetDimensionNotYetImportable,
  ShadcnPresetImportDraft,
  ShadcnPresetImportFailure,
} from "./preset-import";

export { resolveThemeSelection, validateThemeSelectionOptions } from "./selection";

export {
  createLocatedFailure,
  createThemeLocation,
  ThemeResolutionError,
  ThemeValidationError,
  THEME_DEFAULT_RULE_CODE,
} from "./errors";

export type {
  ApplicationTheme,
  AssetToken,
  BorderToken,
  ColorPairToken,
  ComponentThemeOverrideContext,
  ContrastPairDeclaration,
  ContrastPairUsage,
  CornersToken,
  DensityToken,
  ElevationToken,
  ExactPlatformThemeDependency,
  FocusToken,
  PlatformThemeRelease,
  ResolvedTheme,
  SpacingToken,
  ThemeColorRole,
  ThemeResolutionInput,
  ThemeResolutionOptions,
  ThemeTokenKind,
  ThemeTokenValue,
  ThemeValidationFailure,
  ThemeValidationResult,
  TypographyToken,
} from "./types";

export type {
  ResolvedThemeSelection,
  ThemeSelectionResolution,
  ThemeSelectionResolutionInput,
} from "./selection";

export const ThemeService = Object.freeze({
  key: "theme",
  boundary: "./index",
  draftShadcnPresetImport,
  resolveTheme,
  resolveThemeTokens,
  validateApplicationTheme,
  resolveThemeSelection,
  validateThemeSelectionOptions,
  validateThemeContrast,
  validateFocusVisibility,
  validatePublicPlatformAssets,
  validateComponentThemeOverrides,
  contrastRatio,
  relativeLuminance,
});
