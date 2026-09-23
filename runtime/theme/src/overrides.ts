import "server-only";

import {
  themeTokenKindV2Schema,
  themeTokenValueV2Schema,
  type DefinitionRuleFailure,
} from "@vortex/contracts";
import { createLocatedFailure, createThemeLocation } from "./errors";
import type {
  ComponentThemeOverrideContext,
  ThemeResolutionOptions,
  ThemeTokenKindV2,
  ThemeTokenValueV2,
  ThemeValidationFailure,
} from "./types";

export const REGISTERED_THEME_TOKEN_KINDS: ReadonlySet<ThemeTokenKindV2> = new Set(
  themeTokenKindV2Schema.options,
);

export function validateComponentThemeOverrides(
  baseTokens: Readonly<Record<string, ThemeTokenValueV2>>,
  context: ComponentThemeOverrideContext,
  options?: ThemeResolutionOptions | undefined,
): {
  effectiveOverrides: Record<string, ThemeTokenValueV2>;
  failures: ThemeValidationFailure[];
  ruleFailures: DefinitionRuleFailure[];
} {
  const failures: ThemeValidationFailure[] = [];
  const ruleFailures: DefinitionRuleFailure[] = [];

  const rawOverrides = context.overrides ?? {};
  const effectiveOverrides: Record<string, ThemeTokenValueV2> = {};

  const permittedSet: ReadonlySet<ThemeTokenKindV2> | undefined =
    context.permittedTokenKinds !== undefined
      ? new Set(context.permittedTokenKinds)
      : undefined;

  const extraSegments = [
    ...(context.pageKey !== undefined
      ? [{ kind: "page" as const, key: context.pageKey }]
      : []),
    ...(context.componentKey !== undefined
      ? [{ kind: "block" as const, key: context.componentKey }]
      : []),
    ...(context.placementAlias !== undefined
      ? [{ kind: "block" as const, key: context.placementAlias }]
      : []),
  ];

  const addFailure = (params: {
    code: string;
    ruleCode?: string;
    family?: "invalid_value" | "unsafe_content" | "broken_reference";
    message: string;
    tokenKey?: string;
  }) => {
    const location =
      options?.documentKey !== undefined
        ? createThemeLocation(options.documentKey, params.tokenKey, extraSegments)
        : undefined;

    const located = createLocatedFailure({
      ...params,
      ...(location !== undefined ? { location } : {}),
      documentKey: options?.documentKey,
    });
    failures.push(located.failure);
    ruleFailures.push(located.ruleFailure);
  };

  if (context.permittedTokenKinds !== undefined) {
    const invalidKinds = [...context.permittedTokenKinds]
      .filter((kind) => !REGISTERED_THEME_TOKEN_KINDS.has(kind))
      .sort();
    if (invalidKinds.length > 0) {
      addFailure({
        code: "INVALID_PERMITTED_TOKEN_KIND",
        family: "invalid_value",
        message: `Component override permission includes unregistered token kinds: ${invalidKinds.join(", ")}`,
      });
    }
  }

  for (const key of Object.keys(rawOverrides).sort()) {
    const rawValue = rawOverrides[key];
    if (rawValue === undefined) continue;
    // 1. Check if token kind is registered
    const candidateKind = (rawValue as { kind?: unknown })?.kind;
    if (
      typeof candidateKind !== "string" ||
      !REGISTERED_THEME_TOKEN_KINDS.has(candidateKind as ThemeTokenKindV2)
    ) {
      addFailure({
        code: "INVALID_TOKEN_KIND",
        family: "invalid_value",
        message: `Component override for "${key}" has unregistered token kind "${String(candidateKind)}". Registered kinds are: ${Array.from(REGISTERED_THEME_TOKEN_KINDS).sort().join(", ")}`,
        tokenKey: key,
      });
      continue;
    }

    const tokenKind = candidateKind as ThemeTokenKindV2;

    // 2. Check if token kind is permitted for this component
    if (permittedSet !== undefined && !permittedSet.has(tokenKind)) {
      addFailure({
        code: "UNPERMITTED_TOKEN_OVERRIDE",
        family: "invalid_value",
        message: `Token kind "${tokenKind}" is not permitted for component override on "${key}". Permitted kinds: ${Array.from(permittedSet).sort().join(", ")}`,
        tokenKey: key,
      });
      continue;
    }

    // 3. Check inherited base token existence
    const inherited = baseTokens[key];
    if (inherited === undefined) {
      addFailure({
        code: "UNKNOWN_TOKEN_OVERRIDE",
        family: "broken_reference",
        message: `Component override references unknown theme token "${key}". Component overrides may only override existing application theme tokens.`,
        tokenKey: key,
      });
      continue;
    }

    // 4. Token kind must match inherited token kind
    if (inherited.kind !== tokenKind) {
      addFailure({
        code: "TOKEN_KIND_MISMATCH",
        family: "broken_reference",
        message: `Component override for "${key}" has token kind "${tokenKind}" but inherited theme token has kind "${inherited.kind}". Token kinds must match.`,
        tokenKey: key,
      });
      continue;
    }

    // 5. Schema validation of the override value
    const parsed = themeTokenValueV2Schema.safeParse(rawValue);
    if (!parsed.success) {
      addFailure({
        code: "INVALID_TOKEN_VALUE",
        family: "invalid_value",
        message: `Component override value for "${key}" failed schema validation: ${parsed.error.message}`,
        tokenKey: key,
      });
      continue;
    }

    // 6. Colour roles come from the platform catalogue. An override inherits the role
    // and cannot re-declare it to escape the readability checks for that role.
    const value = parsed.data;
    if (value.kind === "color_pair" && inherited.kind === "color_pair") {
      if (value.role !== undefined && value.role !== inherited.role) {
        addFailure({
          code: "COLOR_ROLE_OVERRIDE",
          family: "invalid_value",
          message: `Component override for "${key}" cannot change the colour role declared by the theme`,
          tokenKey: key,
        });
        continue;
      }
      effectiveOverrides[key] =
        inherited.role === undefined ? value : { ...value, role: inherited.role };
      continue;
    }
    effectiveOverrides[key] = value;
  }

  return { effectiveOverrides, failures, ruleFailures };
}
