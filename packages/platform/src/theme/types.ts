import "server-only";

import type { NamespacedKey, PlatformId } from "../catalogue/identifiers";
import type {
  DefinitionValidationLocation,
  DefinitionRuleFailure,
  DefinitionRuleFailureFamily,
} from "../catalogue/validation-errors";
import type {
  PlatformThemeRelease as ContractPlatformThemeRelease,
  ThemeColorRole,
} from "../definition/application-composition/theme";
import type { ApplicationContent } from "../definition/application-contracts";

export type { ThemeColorRole };

export type ApplicationTheme = ApplicationContent["theme"];
export type ExactPlatformThemeDependency = ApplicationTheme["base"];
export type ThemeTokenValue = ApplicationTheme["tokens"][string];
export type ThemeTokenKind = ThemeTokenValue["kind"];
export type PlatformThemeRelease = ContractPlatformThemeRelease;

export type ColorPairToken = Extract<ThemeTokenValue, { kind: "color_pair" }>;
export type TypographyToken = Extract<ThemeTokenValue, { kind: "typography" }>;
export type SpacingToken = Extract<ThemeTokenValue, { kind: "spacing" }>;
export type CornersToken = Extract<ThemeTokenValue, { kind: "corners" }>;
export type BorderToken = Extract<ThemeTokenValue, { kind: "border" }>;
export type ElevationToken = Extract<ThemeTokenValue, { kind: "elevation" }>;
export type FocusToken = Extract<ThemeTokenValue, { kind: "focus" }>;
export type AssetToken = Extract<ThemeTokenValue, { kind: "asset" }>;
export type DensityToken = Extract<ThemeTokenValue, { kind: "density" }>;

export type ContrastPairUsage = "normal_text" | "large_text" | "non_text";

export type ContrastPairDeclaration = Readonly<{
  foregroundTokenKey: string;
  backgroundTokenKey: string;
  usage?: ContrastPairUsage | undefined;
  /** May strengthen, but never lower, the WCAG AA minimum for the declared usage. */
  minimumRatio?: number | undefined;
  label?: string | undefined;
}>;

export type ThemeResolutionOptions = Readonly<{
  /** Exact approval evidence supplied by the trusted publication/runtime caller. */
  approvedAssetIds?: ReadonlySet<PlatformId> | readonly PlatformId[] | undefined;
  /** Exact public-visibility evidence supplied by the trusted publication/runtime caller. */
  publicAssetIds?: ReadonlySet<PlatformId> | readonly PlatformId[] | undefined;
  contrastPairs?: readonly ContrastPairDeclaration[] | undefined;
  documentKey?: NamespacedKey | undefined;
}>;

export type ThemeValidationFailure = Readonly<{
  code: string;
  ruleCode: string;
  family: DefinitionRuleFailureFamily;
  message: string;
  tokenKey?: string | undefined;
  location?: DefinitionValidationLocation | undefined;
}>;

export type ThemeValidationResult = Readonly<{
  valid: boolean;
  failures: readonly ThemeValidationFailure[];
  ruleFailures: readonly DefinitionRuleFailure[];
}>;
