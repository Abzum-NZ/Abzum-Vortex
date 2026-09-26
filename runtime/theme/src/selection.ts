import "server-only";

import {
  DEFAULT_APPLICATION_THEME_SELECTION,
  applicationThemeSelectionV2Schema,
  findShadcnThemeCatalogueOption,
  isShadcnThemeCatalogueBaseRelease,
  shadcnThemeCatalogueDimensionKeys,
  themeTokenValueV2Schema,
  type ApplicationThemeSelectionV2,
  type DefinitionRuleFailure,
} from "@vortex/contracts";
import { findShadcnThemeRelease } from "@vortex/contracts/shadcn-theme-releases";
import { validateThemeContrast } from "./contrast";
import { createLocatedFailure, createThemeLocation } from "./errors";
import { validateFocusVisibility } from "./focus";
import type {
  ExactPlatformThemeDependencyV2,
  ThemeResolutionOptions,
  ThemeTokenValueV2,
  ThemeValidationFailure,
} from "./types";

/**
 * The dimensions whose catalogue options set theme tokens, in the order they are applied. Each
 * option release is the catalogue's base release with that option's token keys applied, and only
 * those keys are copied, so a later dimension overrides an earlier one where their keys overlap:
 * the base colour lays the complete neutral palette (including chart pairs), the theme colour then
 * sets the brand and chart pairs, the chart colour then sets the five chart pairs, and the radius
 * sets the base corner. Authored token overrides are applied last, then contrast and focus are
 * checked on the result.
 */
const TOKEN_DIMENSION_ORDER = ["baseColor", "theme", "chartColor", "radius"] as const;

export type ResolvedThemeSelection = Readonly<{
  /**
   * The effective selection: the authored one, or the platform default when none was authored.
   * Absent only for a theme pinned to an earlier release than the catalogue's base release.
   */
  selection?: ApplicationThemeSelectionV2 | undefined;
  /** The selected, catalogue-backed shadcn style id, for the style CSS loader. */
  style: string;
  /** The complete resolved application token set: base release plus every selected option. */
  tokens: Readonly<Record<string, ThemeTokenValueV2>>;
}>;

export type ThemeSelectionResolutionInput = Readonly<{
  /** The pinned platform theme release the selection is applied to. */
  base: Pick<ExactPlatformThemeDependencyV2, "catalogueThemeId" | "releaseVersion">;
  /** The pinned base release's tokens. */
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

type FailureSink = (params: {
  code: string;
  family: "invalid_value" | "broken_reference";
  message: string;
  dimension?: string;
}) => void;

/** Locates selection failures at the theme's selection, and at the dimension when one is named. */
const selectionFailureSink = (
  failures: ThemeValidationFailure[],
  ruleFailures: DefinitionRuleFailure[],
  documentKey: string | undefined,
): FailureSink => {
  return ({ dimension, ...params }) => {
    const located = createLocatedFailure({
      ...params,
      ...(dimension === undefined ? {} : { tokenKey: dimension }),
      ...(documentKey === undefined
        ? {}
        : {
            location: createThemeLocation(documentKey, dimension, [
              { kind: "setting", key: "selection" },
            ]),
          }),
    });
    failures.push(located.failure);
    ruleFailures.push(located.ruleFailure);
  };
};

const checkSelectionOptions = (
  selection: ApplicationThemeSelectionV2,
  base: ThemeSelectionResolutionInput["base"] | undefined,
  addFailure: FailureSink,
): void => {
  if (base !== undefined && !isShadcnThemeCatalogueBaseRelease(base))
    addFailure({
      code: "THEME_SELECTION_BASE_MISMATCH",
      family: "broken_reference",
      message: `Theme selection requires the catalogue's base platform theme release; the theme pins release ${base.releaseVersion}`,
    });
  for (const dimension of shadcnThemeCatalogueDimensionKeys) {
    const optionId = selection[dimension];
    const option = findShadcnThemeCatalogueOption(dimension, optionId);
    if (option === undefined) {
      addFailure({
        code: "UNKNOWN_THEME_OPTION",
        family: "invalid_value",
        message: `Theme selection names unknown ${dimension} option "${optionId}"`,
        dimension,
      });
      continue;
    }
    if (option.release?.refused === true) {
      addFailure({
        code: "REFUSED_THEME_OPTION",
        family: "invalid_value",
        message: `Theme selection names ${dimension} option "${optionId}", which fails the platform contrast gate`,
        dimension,
      });
      continue;
    }
    if (dimension === "style" && option.asset === undefined)
      addFailure({
        code: "UNKNOWN_THEME_OPTION",
        family: "broken_reference",
        message: `Theme selection style option "${optionId}" ships no stylesheet`,
        dimension,
      });
  }
};

/**
 * Validates that a recorded selection names an offered, non-refused option of every dimension
 * and, when the pinned base release is given, that it is the catalogue's base release. It reads no
 * token values, so a stored theme's selection can be checked without resolving it again.
 */
export function validateThemeSelectionOptions(
  selection: ApplicationThemeSelectionV2,
  options?: ThemeResolutionOptions | undefined,
  base?: ThemeSelectionResolutionInput["base"] | undefined,
): { failures: ThemeValidationFailure[]; ruleFailures: DefinitionRuleFailure[] } {
  const failures: ThemeValidationFailure[] = [];
  const ruleFailures: DefinitionRuleFailure[] = [];
  checkSelectionOptions(
    selection,
    base,
    selectionFailureSink(failures, ruleFailures, options?.documentKey),
  );
  return { failures, ruleFailures };
}

/**
 * Resolves a catalogue selection into the complete token set and the style id. It refuses a
 * selection over any release other than the catalogue's base release, an unknown option id, a
 * refused option, a missing or extra dimension, and a token override whose key, kind or colour
 * role the selected theme does not allow. The resolved tokens then pass the same contrast and
 * focus checks publication runs, so an override cannot hide focus or lower required contrast.
 *
 * On the catalogue's base release an absent selection resolves as the platform default. On an
 * earlier release an absent selection keeps that release's exact tokens (plus the overrides), as
 * the platform theme catalogue promises for applications that still pin it.
 */
export function resolveThemeSelection(
  input: ThemeSelectionResolutionInput,
): ThemeSelectionResolution {
  const failures: ThemeValidationFailure[] = [];
  const ruleFailures: DefinitionRuleFailure[] = [];
  const documentKey = input.options?.documentKey;
  const addSelectionFailure = selectionFailureSink(failures, ruleFailures, documentKey);
  const addTokenFailure = (params: {
    code: string;
    family: "invalid_value" | "broken_reference";
    message: string;
    tokenKey: string;
  }): void => {
    const located = createLocatedFailure({ ...params, documentKey });
    failures.push(located.failure);
    ruleFailures.push(located.ruleFailure);
  };

  const tokens: Record<string, ThemeTokenValueV2> = { ...input.baseTokens };
  let selection: ApplicationThemeSelectionV2 | undefined;

  if (input.selection !== undefined || isShadcnThemeCatalogueBaseRelease(input.base)) {
    const parsedSelection = applicationThemeSelectionV2Schema.safeParse(
      input.selection ?? DEFAULT_APPLICATION_THEME_SELECTION,
    );
    if (!parsedSelection.success) {
      addSelectionFailure({
        code: "INVALID_THEME_SELECTION",
        family: "invalid_value",
        message: `Application theme selection is invalid: ${parsedSelection.error.message}`,
      });
      return { valid: false, failures, ruleFailures };
    }
    selection = parsedSelection.data;
    checkSelectionOptions(selection, input.base, addSelectionFailure);
    if (failures.length > 0) return { valid: false, failures, ruleFailures };

    for (const dimension of TOKEN_DIMENSION_ORDER) {
      const optionId = selection[dimension];
      const option = findShadcnThemeCatalogueOption(dimension, optionId);
      const release =
        option?.releaseKey === undefined ? undefined : findShadcnThemeRelease(option.releaseKey);
      if (option === undefined || release === undefined) {
        addSelectionFailure({
          code: "UNKNOWN_THEME_OPTION_RELEASE",
          family: "broken_reference",
          message: `Theme selection ${dimension} option "${optionId}" has no catalogue release`,
          dimension,
        });
        continue;
      }
      for (const tokenKey of option.tokenKeys ?? []) {
        const raw = release.tokens[tokenKey];
        const parsed = raw === undefined ? undefined : themeTokenValueV2Schema.safeParse(raw);
        if (parsed === undefined || !parsed.success) {
          addSelectionFailure({
            code: "INVALID_THEME_OPTION_TOKEN",
            family: "broken_reference",
            message: `Theme selection ${dimension} option "${optionId}" does not map token "${tokenKey}"`,
            dimension,
          });
          continue;
        }
        tokens[tokenKey] = parsed.data;
      }
    }
  }

  for (const key of Object.keys(input.overrides ?? {}).sort()) {
    const override = input.overrides?.[key];
    if (override === undefined) continue;
    const inherited = tokens[key];
    if (inherited === undefined) {
      addTokenFailure({
        code: "UNKNOWN_TOKEN_OVERRIDE",
        family: "broken_reference",
        message: `Theme token override references unknown token "${key}"`,
        tokenKey: key,
      });
      continue;
    }
    if (inherited.kind !== override.kind) {
      addTokenFailure({
        code: "TOKEN_KIND_MISMATCH",
        family: "broken_reference",
        message: `Theme token override for "${key}" has kind "${override.kind}" but the selected theme token has kind "${inherited.kind}"`,
        tokenKey: key,
      });
      continue;
    }
    if (override.kind === "color_pair" && inherited.kind === "color_pair") {
      if (override.role !== undefined && override.role !== inherited.role) {
        addTokenFailure({
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
      ...(selection === undefined ? {} : { selection: Object.freeze({ ...selection }) }),
      style: (selection ?? DEFAULT_APPLICATION_THEME_SELECTION).style,
      tokens: Object.freeze(tokens),
    }),
  };
}
