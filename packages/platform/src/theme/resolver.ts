import "server-only";

import {
  applicationThemeSchema,
  type DefinitionRuleFailure,
} from "../schema";
import { validatePublicPlatformAssets } from "./assets";
import { validateThemeContrast } from "./contrast";
import { createLocatedFailure } from "./errors";
import { validateFocusVisibility } from "./focus";
import { validateThemeSelectionOptions } from "./selection";
import type {
  ApplicationTheme,
  ThemeResolutionOptions,
  ThemeValidationFailure,
  ThemeValidationResult,
} from "./types";

/**
 * Validates an application theme without throwing.
 * Returns a structured ThemeValidationResult with located definition failures.
 */
export function validateApplicationTheme(
  theme: ApplicationTheme,
  options?: ThemeResolutionOptions | undefined,
): ThemeValidationResult {
  const failures: ThemeValidationFailure[] = [];
  const ruleFailures: DefinitionRuleFailure[] = [];

  // 1. Schema check
  const parsedTheme = applicationThemeSchema.safeParse(theme);
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

  // 2. Validate the catalogue selection, and the release it applies to, when the theme records one
  const selection = parsedTheme.data.selection;
  if (selection !== undefined) {
    const selectionResult = validateThemeSelectionOptions(
      selection,
      options,
      parsedTheme.data.base,
    );
    failures.push(...selectionResult.failures);
    ruleFailures.push(...selectionResult.ruleFailures);
    if (failures.length > 0) return { valid: false, failures, ruleFailures };
  }

  // 3. Validate Contrast
  const contrastResult = validateThemeContrast(tokens, options);
  failures.push(...contrastResult.failures);
  ruleFailures.push(...contrastResult.ruleFailures);

  // 4. Validate Focus Visibility
  const focusResult = validateFocusVisibility(tokens, options);
  failures.push(...focusResult.failures);
  ruleFailures.push(...focusResult.ruleFailures);

  // 5. Validate Public Platform Assets
  const assetResult = validatePublicPlatformAssets(tokens, options);
  failures.push(...assetResult.failures);
  ruleFailures.push(...assetResult.ruleFailures);

  return {
    valid: failures.length === 0,
    failures,
    ruleFailures,
  };
}
