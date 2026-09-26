import "server-only";

import type {
  ApplicationContentV2,
  BuilderKey,
  DefinitionValidationLocation,
  DefinitionRuleFailure,
  DefinitionRuleFailureFamily,
  NamespacedKey,
  PlatformId,
  PlatformThemeReleaseV2 as ContractPlatformThemeReleaseV2,
  ThemeColorRole,
} from "@vortex/contracts";

export type { ThemeColorRole };

export type ApplicationThemeV2 = ApplicationContentV2["theme"];
export type ExactPlatformThemeDependencyV2 = ApplicationThemeV2["base"];
export type ThemeTokenValueV2 = ApplicationThemeV2["tokens"][string];
export type ThemeTokenKindV2 = ThemeTokenValueV2["kind"];
export type PlatformThemeReleaseV2 = ContractPlatformThemeReleaseV2;

export type ColorPairToken = Extract<ThemeTokenValueV2, { kind: "color_pair" }>;
export type TypographyToken = Extract<ThemeTokenValueV2, { kind: "typography" }>;
export type SpacingToken = Extract<ThemeTokenValueV2, { kind: "spacing" }>;
export type CornersToken = Extract<ThemeTokenValueV2, { kind: "corners" }>;
export type BorderToken = Extract<ThemeTokenValueV2, { kind: "border" }>;
export type ElevationToken = Extract<ThemeTokenValueV2, { kind: "elevation" }>;
export type FocusToken = Extract<ThemeTokenValueV2, { kind: "focus" }>;
export type AssetToken = Extract<ThemeTokenValueV2, { kind: "asset" }>;
export type DensityToken = Extract<ThemeTokenValueV2, { kind: "density" }>;

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
   * Component-level theme overrides (token key -> ThemeTokenValueV2).
   */
  overrides?: Readonly<Record<string, ThemeTokenValueV2>> | undefined;
  /**
   * Permitted token kinds for this component.
   * If omitted, all registered token kinds from themeTokenKindV2Schema are permitted.
   */
  permittedTokenKinds?:
    | ReadonlySet<ThemeTokenKindV2>
    | readonly ThemeTokenKindV2[]
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
  theme: ApplicationThemeV2;
  componentOverrideContext?: ComponentThemeOverrideContext | undefined;
  options?: ThemeResolutionOptions | undefined;
}>;

export type ResolvedTheme = Readonly<{
  base: ExactPlatformThemeDependencyV2;
  /** The catalogue-backed shadcn style id the theme selects; the default when none is recorded. */
  style: string;
  tokens: Readonly<Record<string, ThemeTokenValueV2>>;
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
