import "server-only";

import type {
  ApplicationContent,
  BuilderKey,
  DefinitionValidationLocation,
  DefinitionRuleFailure,
  DefinitionRuleFailureFamily,
  NamespacedKey,
  PlatformId,
  PlatformThemeRelease as ContractPlatformThemeRelease,
  ThemeColorRole,
} from "../schema";

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

export type ComponentThemeOverrideContext = Readonly<{
  /**
   * Component-level theme overrides (token key -> ThemeTokenValue).
   */
  overrides?: Readonly<Record<string, ThemeTokenValue>> | undefined;
  /**
   * Permitted token kinds for this component.
   * If omitted, all registered token kinds from themeTokenKindSchema are permitted.
   */
  permittedTokenKinds?:
    | ReadonlySet<ThemeTokenKind>
    | readonly ThemeTokenKind[]
    | undefined;
  /** Display-safe definition keys/aliases used only to locate a refusal. */
  pageKey?: BuilderKey | undefined;
  componentKey?: NamespacedKey | undefined;
  placementAlias?: BuilderKey | undefined;
}>;

export type ThemeResolutionOptions = Readonly<{
  /** Exact approval evidence supplied by the trusted publication/runtime caller. */
  approvedAssetIds?: ReadonlySet<PlatformId> | readonly PlatformId[] | undefined;
  /** Exact public-visibility evidence supplied by the trusted publication/runtime caller. */
  publicAssetIds?: ReadonlySet<PlatformId> | readonly PlatformId[] | undefined;
  contrastPairs?: readonly ContrastPairDeclaration[] | undefined;
  documentKey?: NamespacedKey | undefined;
}>;

export type ThemeResolutionInput = Readonly<{
  theme: ApplicationTheme;
  componentOverrideContext?: ComponentThemeOverrideContext | undefined;
  options?: ThemeResolutionOptions | undefined;
}>;

export type ResolvedTheme = Readonly<{
  base: ExactPlatformThemeDependency;
  /**
   * The catalogue-backed shadcn style id the theme selects; the platform default style when the
   * theme records no selection (a theme pinned to an earlier release than the catalogue's base).
   */
  style: string;
  tokens: Readonly<Record<string, ThemeTokenValue>>;
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
