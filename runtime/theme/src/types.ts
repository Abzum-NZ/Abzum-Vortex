import "server-only";

import type { z } from "zod";
import type {
  applicationThemeV2Schema,
  exactPlatformThemeDependencyV2Schema,
  themeTokenValueV2Schema,
  themeTokenKindV2Schema,
  platformThemeReleaseV2Schema,
  DefinitionValidationLocation,
  DefinitionRuleFailure,
  DefinitionRuleFailureFamily,
} from "@vortex/contracts";

export type ApplicationThemeV2 = z.infer<typeof applicationThemeV2Schema>;
export type ExactPlatformThemeDependencyV2 = z.infer<typeof exactPlatformThemeDependencyV2Schema>;
export type ThemeTokenValueV2 = z.infer<typeof themeTokenValueV2Schema>;
export type ThemeTokenKindV2 = z.infer<typeof themeTokenKindV2Schema>;
export type PlatformThemeReleaseV2 = z.infer<typeof platformThemeReleaseV2Schema>;

export type ColorPairToken = Extract<ThemeTokenValueV2, { kind: "color_pair" }>;
export type TypographyToken = Extract<ThemeTokenValueV2, { kind: "typography" }>;
export type SpacingToken = Extract<ThemeTokenValueV2, { kind: "spacing" }>;
export type CornersToken = Extract<ThemeTokenValueV2, { kind: "corners" }>;
export type BorderToken = Extract<ThemeTokenValueV2, { kind: "border" }>;
export type ElevationToken = Extract<ThemeTokenValueV2, { kind: "elevation" }>;
export type FocusToken = Extract<ThemeTokenValueV2, { kind: "focus" }>;
export type AssetToken = Extract<ThemeTokenValueV2, { kind: "asset" }>;
export type DensityToken = Extract<ThemeTokenValueV2, { kind: "density" }>;

export type ThemeResolutionMode = "runtime" | "preview";

export type ContrastPairDeclaration = Readonly<{
  foregroundTokenKey: string;
  backgroundTokenKey: string;
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
  /**
   * Component identifier or placement alias for error location.
   */
  componentId?: string | undefined;
  placementId?: string | undefined;
}>;

export type AssetApprovalChecker = (assetId: string) => boolean;

export type ThemeResolutionOptions = Readonly<{
  mode?: ThemeResolutionMode | undefined;
  approvedAssetIds?: ReadonlySet<string> | readonly string[] | undefined;
  unapprovedAssetIds?: ReadonlySet<string> | readonly string[] | undefined;
  privateAssetIds?: ReadonlySet<string> | readonly string[] | undefined;
  isAssetApproved?: AssetApprovalChecker | undefined;
  isAssetPublic?: AssetApprovalChecker | undefined;
  contrastPairs?: readonly ContrastPairDeclaration[] | undefined;
  documentKey?: string | undefined;
  correlationId?: string | undefined;
}>;

export type ThemeResolutionInput = Readonly<{
  theme: ApplicationThemeV2;
  componentOverrideContext?:
    | ComponentThemeOverrideContext
    | Readonly<Record<string, ThemeTokenValueV2>>
    | undefined;
  options?: ThemeResolutionOptions | undefined;
}>;

export type ResolvedTheme = Readonly<{
  base: ExactPlatformThemeDependencyV2;
  tokens: Readonly<Record<string, ThemeTokenValueV2>>;
  mode: ThemeResolutionMode;
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
