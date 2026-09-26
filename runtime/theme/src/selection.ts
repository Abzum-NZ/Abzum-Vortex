import "server-only";

import {
  DEFAULT_APPLICATION_THEME_SELECTION,
  applicationThemeSelectionV2Schema,
  findShadcnThemeCatalogueOption,
  themeTokenValueV2Schema,
  type ApplicationThemeSelectionV2,
  type DefinitionRuleFailure,
} from "@vortex/contracts";
import { findShadcnThemeRelease } from "@vortex/contracts/shadcn-theme-releases";
import { validateThemeContrast } from "./contrast";
import { createLocatedFailure } from "./errors";
import { validateFocusVisibility } from "./focus";
import type {
  ThemeResolutionOptions,
  ThemeTokenValueV2,
  ThemeValidationFailure,
} from "./types";

/**
 * The dimensions whose catalogue options set theme tokens, in the order they are applied. Each
 * option release is the base release with that option's token keys applied, so a later dimension
 * overrides an earlier one: the base colour lays the complete neutral palette, the theme colour
 * sets the brand and chart pairs, the chart colour sets the five chart pairs, and the radius sets
 * the base corner.
 */
const TOKEN_DIMENSION_ORDER = ["baseColor", "theme", "chartColor", "radius"] as const;

/** Menu colour, menu accent and style are variant descriptors, not tokens. */
export type ResolvedThemeSelection = Readonly<{
  selection: ApplicationThemeSelectionV2;
  /** The selected, catalogue-backed shadcn style id, for the style CSS loader. */
  style: string;
  menuColor: string;
  menuAccent: string;
  /** The complete resolved application token set: base release plus every selected option. */
  tokens: Readonly<Record<string, ThemeTokenValueV2>>;
}>;

export type ThemeSelectionResolutionInput = Readonly<{
  /** The pinned base release's tokens the selection is applied to. */
  baseTokens: Readonly<Record<string, ThemeTokenValueV2>>;
  /** The authored catalogue selection; absent means the platform default selection. */
  selection?: ApplicationThemeSelectionV2 | undefined;
  /** Already-canonical token overrides applied after the selection. */
  overrides?: Readonly<Record<string, ThemeTokenValueV2>> | undefined;
  options?: ThemeResolutionOptions | undefined;
}>;

export type ThemeSelectionResolution =
  | Readonly<{ valid: true; resolved: ResolvedThemeSelection }>
  | Readonly<{
      valid: false;
      failures: readonly ThemeValidationFailure[];
      ruleFailures: readonly DefinitionRuleFailure[];
    }>;

/**
 * Validates a selection names an offered, non-refused option of every dimension. It reads no token
 * values, so publication can refuse an invalid selection before it resolves any tokens.
 */
export function validateThemeSelectionOptions(
  selection: ApplicationThemeSelectionV2,
  options?: ThemeResolutionOptions | undefined,
): { failures: ThemeValidationFailure[]; ruleFailures: DefinitionRuleFailure[] } {
  const failures: ThemeValidationFailure[] = [];
  const ruleFailures: DefinitionRuleFailure[] = [];
  const documentKey = options?.documentKey;
  const addFailure = (params: {
    code: string;
    family: "invalid_value" | "broken_reference";
    message: string;
    tokenKey: string;
  }): void => {
    const located = createLocatedFailure({ ...params, documentKey });
    failures.push(located.failure);
    ruleFailures.push(located.ruleFailure);
  };
  for (const dimension of [
    "style",
    "baseColor",
    "theme",
    "chartColor",
    "radius",
    "menuColor",
    "menuAccent",
  ] as const) {
    const option = findShadcnThemeCatalogueOption(dimension, selection[dimension]);
    if (option === undefined) {
      addFailure({
        code: "UNKNOWN_THEME_OPTION",
        family: "invalid_value",
        message: `Theme selection names unknown ${dimension} option "${selection[dimension]}"`,
        tokenKey: dimension,
      });
      continue;
    }
    if (option.release?.refused === true)
      addFailure({
        code: "REFUSED_THEME_OPTION",
        family: "invalid_value",
        message: `Theme selection names ${dimension} option "${selection[dimension]}", which fails the platform contrast gate`,
        tokenKey: dimension,
      });
  }
  return { failures, ruleFailures };
}

/**
 * Resolves a catalogue selection into the complete token set and the style id, refusing an unknown
 * option id, a refused option, a missing dimension and a token override whose kind or role the
 * selected theme does not allow. The resolved tokens then pass the same contrast and focus checks
 * publication runs, so an override that hides focus or lowers required contrast is refused here.
 */
export function resolveThemeSelection(
  input: ThemeSelectionResolutionInput,
): ThemeSelectionResolution {
  const failures: ThemeValidationFailure[] = [];
  const ruleFailures: DefinitionRuleFailure[] = [];
  const documentKey = input.options?.documentKey;

  const addFailure = (params: {
    code: string;
    family: "invalid_value" | "broken_reference" | "unsafe_content";
    message: string;
    tokenKey?: string;
  }): void => {
    const located = createLocatedFailure({ ...params, documentKey });
    failures.push(located.failure);
    ruleFailures.push(located.ruleFailure);
  };

  const selectionInput = input.selection ?? DEFAULT_APPLICATION_THEME_SELECTION;
  const parsedSelection = applicationThemeSelectionV2Schema.safeParse(selectionInput);
  if (!parsedSelection.success) {
    addFailure({
      code: "INVALID_THEME_SELECTION",
      family: "invalid_value",
      message: `Application theme selection is invalid: ${parsedSelection.error.message}`,
    });
    return { valid: false, failures, ruleFailures };
  }
  const selection = parsedSelection.data;

  const tokens: Record<string, ThemeTokenValueV2> = { ...input.baseTokens };

  for (const dimension of TOKEN_DIMENSION_ORDER) {
    const optionId = selection[dimension];
    const option = findShadcnThemeCatalogueOption(dimension, optionId);
    if (option === undefined) {
      addFailure({
        code: "UNKNOWN_THEME_OPTION",
        family: "invalid_value",
        message: `Theme selection names unknown ${dimension} option "${optionId}"`,
        tokenKey: dimension,
      });
      continue;
    }
    if (option.release === undefined || option.release.refused === true) {
      addFailure({
        code: "REFUSED_THEME_OPTION",
        family: "invalid_value",
        message: `Theme selection names ${dimension} option "${optionId}", which fails the platform contrast gate`,
        tokenKey: dimension,
      });
      continue;
    }
    if (option.releaseKey === undefined) {
      addFailure({
        code: "UNKNOWN_THEME_OPTION_RELEASE",
        family: "broken_reference",
        message: `Theme selection ${dimension} option "${optionId}" declares no release key`,
        tokenKey: dimension,
      });
      continue;
    }
    const release = findShadcnThemeRelease(option.releaseKey);
    if (release === undefined) {
      addFailure({
        code: "UNKNOWN_THEME_OPTION_RELEASE",
        family: "broken_reference",
        message: `Theme selection ${dimension} option "${optionId}" has no catalogue release`,
        tokenKey: dimension,
      });
      continue;
    }
    for (const tokenKey of option.tokenKeys ?? []) {
      const raw = release.tokens[tokenKey];
      const parsed = raw === undefined ? undefined : themeTokenValueV2Schema.safeParse(raw);
      if (parsed === undefined || !parsed.success) {
        addFailure({
          code: "INVALID_THEME_OPTION_TOKEN",
          family: "invalid_value",
          message: `Theme selection ${dimension} option "${optionId}" does not map token "${tokenKey}"`,
          tokenKey,
        });
        continue;
      }
      tokens[tokenKey] = parsed.data;
    }
  }

  // Style, menu colour and menu accent are catalogue variants. The style id must name a shipped
  // style with its scoped CSS asset; the menu variants must name an offered descriptor.
  const styleOption = findShadcnThemeCatalogueOption("style", selection.style);
  if (styleOption === undefined || styleOption.asset === undefined) {
    addFailure({
      code: "UNKNOWN_THEME_OPTION",
      family: "invalid_value",
      message: `Theme selection names unknown style option "${selection.style}"`,
      tokenKey: "style",
    });
  }
  const menuColorOption = findShadcnThemeCatalogueOption("menuColor", selection.menuColor);
  if (menuColorOption === undefined) {
    addFailure({
      code: "UNKNOWN_THEME_OPTION",
      family: "invalid_value",
      message: `Theme selection names unknown menuColor option "${selection.menuColor}"`,
      tokenKey: "menuColor",
    });
  }
  const menuAccentOption = findShadcnThemeCatalogueOption("menuAccent", selection.menuAccent);
  if (menuAccentOption === undefined) {
    addFailure({
      code: "UNKNOWN_THEME_OPTION",
      family: "invalid_value",
      message: `Theme selection names unknown menuAccent option "${selection.menuAccent}"`,
      tokenKey: "menuAccent",
    });
  }

  for (const key of Object.keys(input.overrides ?? {}).sort()) {
    const override = input.overrides?.[key];
    if (override === undefined) continue;
    const inherited = tokens[key];
    if (inherited === undefined) {
      addFailure({
        code: "UNKNOWN_TOKEN_OVERRIDE",
        family: "broken_reference",
        message: `Theme token override references unknown token "${key}"`,
        tokenKey: key,
      });
      continue;
    }
    if (inherited.kind !== override.kind) {
      addFailure({
        code: "TOKEN_KIND_MISMATCH",
        family: "broken_reference",
        message: `Theme token override for "${key}" has kind "${override.kind}" but the selected theme token has kind "${inherited.kind}"`,
        tokenKey: key,
      });
      continue;
    }
    if (override.kind === "color_pair" && inherited.kind === "color_pair") {
      if (override.role !== undefined && override.role !== inherited.role) {
        addFailure({
          code: "COLOR_ROLE_OVERRIDE",
          family: "invalid_value",
          message: `Theme token override for "${key}" cannot change the colour role declared by the catalogue`,
          tokenKey: key,
        });
        continue;
      }
      tokens[key] =
        inherited.role === undefined ? override : { ...override, role: inherited.role };
      continue;
    }
    tokens[key] = override;
  }

  if (failures.length === 0) {
    const contrast = validateThemeContrast(tokens, input.options);
    failures.push(...contrast.failures);
    ruleFailures.push(...contrast.ruleFailures);
    const focus = validateFocusVisibility(tokens, input.options);
    failures.push(...focus.failures);
    ruleFailures.push(...focus.ruleFailures);
  }

  if (failures.length > 0) return { valid: false, failures, ruleFailures };

  return {
    valid: true,
    resolved: Object.freeze({
      selection: Object.freeze({ ...selection }),
      style: selection.style,
      menuColor: selection.menuColor,
      menuAccent: selection.menuAccent,
      tokens: Object.freeze(tokens),
    }),
  };
}
