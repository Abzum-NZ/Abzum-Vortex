import "server-only";

import type { NamespacedKey, PlatformId } from "../catalogue/identifiers";
import type {
  DefinitionValidationLocation,
  DefinitionRuleFailure,
  DefinitionRuleFailureFamily,
} from "../catalogue/validation-errors";
import type { PlatformThemeRelease as ContractPlatformThemeRelease } from "../definition/application-composition/theme";
import type { ApplicationContent } from "../definition/application-contracts";

export type ApplicationTheme = ApplicationContent["theme"];
export type ExactPlatformThemeDependency = ApplicationTheme["base"];
export type ThemeTokenValue = ApplicationTheme["tokens"][string];
export type PlatformThemeRelease = ContractPlatformThemeRelease;

type ContrastPairUsage = "normal_text" | "large_text" | "non_text";

type ContrastPairDeclaration = Readonly<{
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
