import "server-only";

export * from "./platform-theme-catalogue";
export * from "./shadcn-theme-catalogue";
export * from "./shadcn-theme-releases";
export { STUDIO_THEME } from "./studio-theme";

export { contrastRatio, validateThemeContrast, WCAG_AA_NON_TEXT_MIN_CONTRAST } from "./contrast";

export { validateFocusVisibility } from "./focus";

export { validatePublicPlatformAssets } from "./assets";

export { validateApplicationTheme } from "./resolver";

export { resolveThemeSelection, validateThemeSelectionOptions } from "./selection";

export { createLocatedFailure, createThemeLocation } from "./errors";

export type {
  ApplicationTheme,
  StoredApplicationTheme,
  ExactPlatformThemeDependency,
  PlatformThemeRelease,
  ThemeResolutionOptions,
  ThemeTokenValue,
  ThemeValidationFailure,
  ThemeValidationResult,
} from "./types";

export { ApplicationThemeResolutionError, resolveApplicationTheme } from "./application-theme";
