import "server-only";

export * from "./platform-theme-catalogue";
export * from "./shadcn-theme-catalogue";
export * from "./shadcn-theme-releases";
export { STUDIO_THEME_ROOT } from "./studio-theme";

export {
  contrastRatio,
  relativeLuminance,
  validateThemeContrast,
  WCAG_AA_NON_TEXT_MIN_CONTRAST,
} from "./contrast";

export { validateFocusVisibility } from "./focus";

export { validatePublicPlatformAssets } from "./assets";

export { validateApplicationTheme } from "./resolver";

export { resolveThemeSelection, validateThemeSelectionOptions } from "./selection";

export {
  createLocatedFailure,
  createThemeLocation,
  THEME_DEFAULT_RULE_CODE,
} from "./errors";

export type {
  ApplicationTheme,
  AssetToken,
  BorderToken,
  ColorPairToken,
  ContrastPairDeclaration,
  ContrastPairUsage,
  CornersToken,
  DensityToken,
  ElevationToken,
  ExactPlatformThemeDependency,
  FocusToken,
  PlatformThemeRelease,
  SpacingToken,
  ThemeColorRole,
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
