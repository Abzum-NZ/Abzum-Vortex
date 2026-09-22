import "server-only";

import type {
  DefinitionRuleFailure,
  DefinitionRuleFailureFamily,
  DefinitionValidationLocation,
} from "@vortex/contracts";
import type { ThemeValidationFailure } from "./types";

export const THEME_DEFAULT_RULE_CODE = "vortex.definition.application_block_settings";

export function createThemeLocation(
  documentKey: string,
  tokenKey?: string,
  extraSegments?: readonly { kind: "block" | "setting" | "page"; key: string }[],
): DefinitionValidationLocation {
  const segments: DefinitionValidationLocation["segments"] = [
    { kind: "document", key: "theme" },
  ];
  if (tokenKey !== undefined) {
    segments.push({ kind: "setting", key: tokenKey });
  }
  if (extraSegments !== undefined) {
    for (const segment of extraSegments) {
      segments.push(segment);
    }
  }
  return {
    documentKind: "application",
    documentKey,
    segments,
  };
}

export function createLocatedFailure(params: {
  code: string;
  ruleCode?: string;
  family?: DefinitionRuleFailureFamily;
  message: string;
  tokenKey?: string;
  documentKey?: string;
  location?: DefinitionValidationLocation;
}): { failure: ThemeValidationFailure; ruleFailure: DefinitionRuleFailure } {
  const ruleCode = params.ruleCode ?? THEME_DEFAULT_RULE_CODE;
  const family = params.family ?? "invalid_value";
  const location =
    params.location ??
    (params.documentKey !== undefined
      ? createThemeLocation(params.documentKey, params.tokenKey)
      : undefined);

  const failure: ThemeValidationFailure = {
    code: params.code,
    ruleCode,
    family,
    message: params.message,
    ...(params.tokenKey !== undefined ? { tokenKey: params.tokenKey } : {}),
    ...(location !== undefined ? { location } : {}),
  };

  const ruleFailure: DefinitionRuleFailure = {
    ruleCode,
    family,
    ...(location !== undefined ? { location } : {}),
  };

  return { failure, ruleFailure };
}

export class ThemeResolutionError extends Error {
  readonly code: string;
  readonly ruleCode: string;
  readonly family: DefinitionRuleFailureFamily;
  readonly location: DefinitionValidationLocation | undefined;
  readonly failures: readonly ThemeValidationFailure[];
  readonly ruleFailures: readonly DefinitionRuleFailure[];

  constructor(
    message: string,
    failures: readonly ThemeValidationFailure[],
    ruleFailures: readonly DefinitionRuleFailure[],
  ) {
    super(message);
    this.name = "ThemeResolutionError";
    const primary = failures[0];
    this.code = primary?.code ?? "THEME_RESOLUTION_FAILED";
    this.ruleCode = primary?.ruleCode ?? THEME_DEFAULT_RULE_CODE;
    this.family = primary?.family ?? "invalid_value";
    this.location = primary?.location;
    this.failures = failures;
    this.ruleFailures = ruleFailures;
  }
}

export class ThemeValidationError extends ThemeResolutionError {
  constructor(
    failures: readonly ThemeValidationFailure[],
    ruleFailures: readonly DefinitionRuleFailure[],
  ) {
    const primary = failures[0];
    super(primary?.message ?? "Theme validation failed", failures, ruleFailures);
    this.name = "ThemeValidationError";
  }
}
