import "server-only";

import {
  applicationThemeV2Schema,
  type DefinitionRuleFailure,
} from "@vortex/contracts";
import { validatePublicPlatformAssets } from "./assets";
import { validateThemeContrast } from "./contrast";
import { createLocatedFailure, ThemeValidationError } from "./errors";
import { validateFocusVisibility } from "./focus";
import { validateComponentThemeOverrides } from "./overrides";
import type {
  ApplicationThemeV2,
  ComponentThemeOverrideContext,
  ResolvedTheme,
  ThemeResolutionInput,
  ThemeResolutionOptions,
  ThemeTokenValueV2,
  ThemeValidationFailure,
  ThemeValidationResult,
} from "./types";

function isThemeResolutionInput(value: unknown): value is ThemeResolutionInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "theme" in value &&
    typeof (value as { theme: unknown }).theme === "object"
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

/**
 * Validates an application theme without throwing.
 * Returns a structured ThemeValidationResult with located definition failures.
 */
export function validateApplicationTheme(
  theme: ApplicationThemeV2,
  options?: ThemeResolutionOptions | undefined,
): ThemeValidationResult {
  const failures: ThemeValidationFailure[] = [];
  const ruleFailures: DefinitionRuleFailure[] = [];

  // 1. Schema check
  const parsedTheme = applicationThemeV2Schema.safeParse(theme);
  if (!parsedTheme.success) {
    const located = createLocatedFailure({
      code: "INVALID_THEME_SCHEMA",
      family: "invalid_value",
      message: `Application theme failed schema validation: ${parsedTheme.error.message}`,
      documentKey: options?.documentKey,
    });
    failures.push(located.failure);
    ruleFailures.push(located.ruleFailure);
    return { valid: false, failures, ruleFailures };
  }

  const tokens = parsedTheme.data.tokens;

  const declaredPairs: ContrastPairDeclaration[] = [
    ...(parsedTheme.data.contrastPairs?.map((pair) => ({
      foregroundTokenKey: pair.foregroundToken,
      backgroundTokenKey: pair.backgroundToken,
      ...(pair.usage !== undefined ? { usage: pair.usage } : {}),
      ...(pair.minimumRatio !== undefined ? { minimumRatio: pair.minimumRatio } : {}),
    })) ?? []),
    ...(options?.contrastPairs ?? []),
  ];
  const effectiveOptions: ThemeResolutionOptions = {
    ...options,
    contrastPairs: declaredPairs.length > 0 ? declaredPairs : options?.contrastPairs,
  };

  // 2. Validate Contrast
  const contrastResult = validateThemeContrast(tokens, effectiveOptions);
  failures.push(...contrastResult.failures);
  ruleFailures.push(...contrastResult.ruleFailures);

  // 3. Validate Focus Visibility
  const focusResult = validateFocusVisibility(tokens, effectiveOptions);
  failures.push(...focusResult.failures);
  ruleFailures.push(...focusResult.ruleFailures);

  // 4. Validate Public Platform Assets
  const assetResult = validatePublicPlatformAssets(tokens, effectiveOptions);
  failures.push(...assetResult.failures);
  ruleFailures.push(...assetResult.ruleFailures);

  return {
    valid: failures.length === 0,
    failures,
    ruleFailures,
  };
}

/**
 * Resolves the complete, deterministic final token set from a materialized application
 * theme plus optional component overrides.
 *
 * Rejects insufficient contrast, hidden focus, private/unapproved assets, and invalid
 * token-kind/component overrides by throwing ThemeValidationError with located errors.
 *
 * Produces identical output for runtime and preview. Pure function: no organisation or
 * business name branches.
 */
export function resolveTheme(input: ThemeResolutionInput): ResolvedTheme;
export function resolveTheme(
  theme: ApplicationThemeV2,
  componentOverrideContext?: ComponentThemeOverrideContext | undefined,
  options?: ThemeResolutionOptions | undefined,
): ResolvedTheme;
export function resolveTheme(
  first: ApplicationThemeV2 | ThemeResolutionInput,
  second?: ComponentThemeOverrideContext | undefined,
  third?: ThemeResolutionOptions | undefined,
): ResolvedTheme {
  let theme: ApplicationThemeV2;
  let overrideContext: ComponentThemeOverrideContext | undefined;
  let options: ThemeResolutionOptions | undefined;

  if (isThemeResolutionInput(first)) {
    theme = first.theme;
    overrideContext = first.componentOverrideContext;
    options = first.options;
  } else {
    theme = first;
    overrideContext = second;
    options = third;
  }

  // 1. Validate Base Application Theme
  const baseValidation = validateApplicationTheme(theme, options);
  const allFailures: ThemeValidationFailure[] = [...baseValidation.failures];
  const allRuleFailures: DefinitionRuleFailure[] = [...baseValidation.ruleFailures];

  // 2. Process & Validate Component Overrides
  const parsedTheme = applicationThemeV2Schema.safeParse(theme);
  if (!parsedTheme.success) {
    throw new ThemeValidationError(allFailures, allRuleFailures);
  }
  const canonicalTheme = parsedTheme.data;
  let effectiveTokens: Record<string, ThemeTokenValueV2> = { ...canonicalTheme.tokens };

  if (overrideContext !== undefined && baseValidation.valid) {
    const overrideResult = validateComponentThemeOverrides(
      canonicalTheme.tokens,
      overrideContext,
      options,
    );
    allFailures.push(...overrideResult.failures);
    allRuleFailures.push(...overrideResult.ruleFailures);

    if (overrideResult.failures.length === 0) {
      effectiveTokens = { ...effectiveTokens, ...overrideResult.effectiveOverrides };

      // Re-verify contrast, focus and assets on the effective merged token set
      const mergedContrast = validateThemeContrast(effectiveTokens, options);
      allFailures.push(...mergedContrast.failures);
      allRuleFailures.push(...mergedContrast.ruleFailures);

      const mergedFocus = validateFocusVisibility(effectiveTokens, options);
      allFailures.push(...mergedFocus.failures);
      allRuleFailures.push(...mergedFocus.ruleFailures);

      const mergedAssets = validatePublicPlatformAssets(effectiveTokens, options);
      allFailures.push(...mergedAssets.failures);
      allRuleFailures.push(...mergedAssets.ruleFailures);
    }
  }

  // 3. Reject with located definition failures if any validation failed
  if (allFailures.length > 0) {
    throw new ThemeValidationError(allFailures, allRuleFailures);
  }

  // 4. Construct deterministic sorted token map
  const sortedKeys = Object.keys(effectiveTokens).sort();
  const deterministicTokens: Record<string, ThemeTokenValueV2> = {};
  for (const key of sortedKeys) {
    const token = effectiveTokens[key];
    if (token !== undefined) {
      deterministicTokens[key] = deepFreeze(structuredClone(token));
    }
  }
  Object.freeze(deterministicTokens);

  return deepFreeze({
    base: structuredClone(canonicalTheme.base),
    tokens: deterministicTokens,
    ...(canonicalTheme.contrastPairs !== undefined
      ? {
          contrastPairs: canonicalTheme.contrastPairs.map((pair) => ({
            foregroundTokenKey: pair.foregroundToken,
            backgroundTokenKey: pair.backgroundToken,
            ...(pair.usage !== undefined ? { usage: pair.usage } : {}),
            ...(pair.minimumRatio !== undefined ? { minimumRatio: pair.minimumRatio } : {}),
          })),
        }
      : {}),
  });
}

/**
 * Convenience helper returning just the deterministic final token map.
 */
export function resolveThemeTokens(input: ThemeResolutionInput): Readonly<Record<string, ThemeTokenValueV2>>;
export function resolveThemeTokens(
  theme: ApplicationThemeV2,
  componentOverrideContext?: ComponentThemeOverrideContext | undefined,
  options?: ThemeResolutionOptions | undefined,
): Readonly<Record<string, ThemeTokenValueV2>>;
export function resolveThemeTokens(
  first: ApplicationThemeV2 | ThemeResolutionInput,
  second?: ComponentThemeOverrideContext | undefined,
  third?: ThemeResolutionOptions | undefined,
): Readonly<Record<string, ThemeTokenValueV2>> {
  const resolved = isThemeResolutionInput(first)
    ? resolveTheme(first)
    : resolveTheme(first, second, third);
  return resolved.tokens;
}
