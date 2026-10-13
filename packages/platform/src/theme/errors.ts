import "server-only";

import type {
  DefinitionRuleFailure,
  DefinitionRuleFailureFamily,
  DefinitionValidationLocation,
} from "../schema";
import type { ThemeValidationFailure } from "./types";

export const THEME_DEFAULT_RULE_CODE = "vortex.definition.application_block_settings";

export function createThemeLocation(
  documentKey: string,
  tokenKey?: string,
  scopeSegments?: readonly { kind: "block" | "setting" | "page"; key: string }[],
): DefinitionValidationLocation {
  const segments: DefinitionValidationLocation["segments"] = [
    { kind: "application", key: documentKey },
    { kind: "setting", key: "theme" },
  ];
  if (scopeSegments !== undefined) segments.push(...scopeSegments);
  if (tokenKey !== undefined) {
    segments.push({ kind: "setting", key: tokenKey });
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
  documentKey?: string | undefined;
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
