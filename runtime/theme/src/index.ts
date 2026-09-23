import "server-only";

import {
  contrastRatio,
  relativeLuminance,
  validateThemeContrast,
  WCAG_AA_LARGE_TEXT_MIN_CONTRAST,
  WCAG_AA_NON_TEXT_MIN_CONTRAST,
  WCAG_AA_NORMAL_TEXT_MIN_CONTRAST,
} from "./contrast";
import { validateFocusVisibility } from "./focus";
import { validatePublicPlatformAssets } from "./assets";
import {
  REGISTERED_THEME_TOKEN_KINDS,
  validateComponentThemeOverrides,
} from "./overrides";
import {
  resolveTheme,
  resolveThemeTokens,
  validateApplicationTheme,
} from "./resolver";

export {
  contrastRatio,
  relativeLuminance,
  validateThemeContrast,
  WCAG_AA_LARGE_TEXT_MIN_CONTRAST,
  WCAG_AA_NON_TEXT_MIN_CONTRAST,
  WCAG_AA_NORMAL_TEXT_MIN_CONTRAST,
} from "./contrast";

export { validateFocusVisibility } from "./focus";

export { validatePublicPlatformAssets } from "./assets";

export {
  REGISTERED_THEME_TOKEN_KINDS,
  validateComponentThemeOverrides,
} from "./overrides";

export {
  resolveTheme,
  resolveThemeTokens,
  validateApplicationTheme,
} from "./resolver";

export {
  createLocatedFailure,
  createThemeLocation,
  ThemeResolutionError,
  ThemeValidationError,
  THEME_DEFAULT_RULE_CODE,
} from "./errors";

export type {
  ApplicationThemeV2,
  AssetToken,
  BorderToken,
  ColorPairToken,
  ComponentThemeOverrideContext,
  ContrastPairDeclaration,
  ContrastPairUsage,
  CornersToken,
  DensityToken,
  ElevationToken,
  ExactPlatformThemeDependencyV2,
  FocusToken,
  PlatformThemeReleaseV2,
  ResolvedTheme,
  SpacingToken,
  ThemeColorRole,
  ThemeContrastPairUsage,
  ThemeContrastPairV2,
  ThemeResolutionInput,
  ThemeResolutionOptions,
  ThemeTokenKindV2,
  ThemeTokenValueV2,
  ThemeValidationFailure,
  ThemeValidationResult,
  TypographyToken,
} from "./types";

export const ThemeService = Object.freeze({
  key: "theme",
  boundary: "@vortex/theme",
  resolveTheme,
  resolveThemeTokens,
  validateApplicationTheme,
  validateThemeContrast,
  validateFocusVisibility,
  validatePublicPlatformAssets,
  validateComponentThemeOverrides,
  contrastRatio,
  relativeLuminance,
});
