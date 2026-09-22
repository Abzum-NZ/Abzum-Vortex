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
  overrideContext:
    | ComponentThemeOverrideContext
    | Readonly<Record<string, ThemeTokenValueV2>>,
  options?: ThemeResolutionOptions | undefined,
): {
  effectiveOverrides: Record<string, ThemeTokenValueV2>;
  failures: ThemeValidationFailure[];
  ruleFailures: DefinitionRuleFailure[];
} {
  const failures: ThemeValidationFailure[] = [];
  const ruleFailures: DefinitionRuleFailure[] = [];

  const isPlainRecord = (
    value: unknown,
  ): value is Readonly<Record<string, ThemeTokenValueV2>> => {
    if (typeof value !== "object" || value === null) return false;
    return !("overrides" in value || "permittedTokenKinds" in value);
  };

  const context: ComponentThemeOverrideContext = isPlainRecord(overrideContext)
    ? { overrides: overrideContext }
    : overrideContext;

  const rawOverrides = context.overrides ?? {};
  const effectiveOverrides: Record<string, ThemeTokenValueV2> = {};

  const permittedSet: ReadonlySet<ThemeTokenKindV2> | undefined =
    context.permittedTokenKinds !== undefined
      ? new Set(context.permittedTokenKinds)
      : undefined;

  const extraSegments = [
    ...(context.componentId !== undefined
      ? [{ kind: "block" as const, key: context.componentId }]
      : []),
    ...(context.placementId !== undefined
      ? [{ kind: "block" as const, key: context.placementId }]
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

  for (const [key, rawValue] of Object.entries(rawOverrides)) {
    // 1. Check if token kind is registered
    const candidateKind = (rawValue as { kind?: unknown })?.kind;
    if (
      typeof candidateKind !== "string" ||
      !REGISTERED_THEME_TOKEN_KINDS.has(candidateKind as ThemeTokenKindV2)
    ) {
      addFailure({
        code: "INVALID_TOKEN_KIND",
        family: "invalid_value",
        message: `Component override for "${key}" has unregistered token kind "${String(candidateKind)}". Registered kinds are: ${Array.from(REGISTERED_THEME_TOKEN_KINDS).join(", ")}`,
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
        message: `Token kind "${tokenKind}" is not permitted for component override on "${key}". Permitted kinds: ${Array.from(permittedSet).join(", ")}`,
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

    effectiveOverrides[key] = parsed.data;
  }

  return { effectiveOverrides, failures, ruleFailures };
}
