import {
  applicationRootIdSchema,
  applicationSourceDocumentV2Schema,
  isRecord,
  revisionSchema,
  sourceApplicationThemeV2Schema,
  type ApplicationSourceDocumentV2,
} from "@vortex/contracts";

export type StudioApplicationTheme = ApplicationSourceDocumentV2["body"]["theme"];
export type StudioThemeTokenValue = StudioApplicationTheme["token_overrides"][string];
export type StudioAppearanceRequest = Readonly<{
  rootId: string;
  expectedDraftRevision: number;
  tokenOverrides: Record<string, StudioThemeTokenValue>;
}>;
export type StudioAppearanceToken = Readonly<{ key: string; inherited: StudioThemeTokenValue }>;

/** Codes are safe descriptions of real engine failures; arbitrary messages never leave the server. */
export const studioAppearanceFailureCodes = [
  "INVALID_THEME_SCHEMA", "INVALID_THEME_SELECTION", "THEME_SELECTION_BASE_MISMATCH",
  "UNKNOWN_THEME_OPTION", "REFUSED_THEME_OPTION", "UNKNOWN_THEME_OPTION_RELEASE",
  "INVALID_THEME_OPTION_TOKEN", "UNKNOWN_TOKEN_OVERRIDE", "TOKEN_KIND_MISMATCH",
  "COLOR_ROLE_OVERRIDE", "COLOR_ROLE_MISMATCH", "MISSING_BACKGROUND_ROLE",
  "TRANSLUCENT_BACKGROUND", "INSUFFICIENT_CONTRAST", "INVALID_CONTRAST_RATIO",
  "BROKEN_TOKEN_REFERENCE", "INVALID_TOKEN_KIND", "HIDDEN_FOCUS", "MISSING_FOCUS_TOKEN",
  "INVALID_ASSET_IDENTIFIER", "ASSET_APPROVAL_UNVERIFIED", "UNAPPROVED_ASSET",
  "ASSET_VISIBILITY_UNVERIFIED", "PRIVATE_ASSET", "VALIDATION_FAILED",
] as const;
export type StudioAppearanceFailureCode = (typeof studioAppearanceFailureCodes)[number];
export type StudioAppearanceFailure = Readonly<{
  code: StudioAppearanceFailureCode;
  ruleCode: "vortex.definition.application_block_settings";
  family: "invalid_value" | "broken_reference" | "unsafe_content";
  tokenKey?: string;
}>;
export type StudioAppearanceResult =
  | Readonly<{
      kind: "available"; rootId: string; draftRevision: number; theme: StudioApplicationTheme;
      tokens: readonly StudioAppearanceToken[]; publicAssetIds: readonly string[];
      valid: boolean; failures: readonly StudioAppearanceFailure[];
    }>
  | Readonly<{ kind: "refused" | "conflict" | "temporarily_unavailable" }>;

/** This is authored input only. The server independently reads authority, pin and revision. */
export const parseStudioAppearanceRequest = (candidate: unknown): StudioAppearanceRequest | undefined => {
  if (!isRecord(candidate) || Reflect.ownKeys(candidate).length !== 3 ||
      !Object.hasOwn(candidate, "rootId") || !Object.hasOwn(candidate, "expectedDraftRevision") ||
      !Object.hasOwn(candidate, "tokenOverrides")) return undefined;
  const root = applicationRootIdSchema.safeParse(candidate.rootId);
  const revision = revisionSchema.safeParse(candidate.expectedDraftRevision);
  const overrides = sourceApplicationThemeV2Schema.pick({ token_overrides: true }).strict()
    .safeParse({ token_overrides: candidate.tokenOverrides });
  return root.success && revision.success && overrides.success
    ? { rootId: root.data, expectedDraftRevision: revision.data, tokenOverrides: overrides.data.token_overrides }
    : undefined;
};

/** Stable JSON equality for the closed authored theme shape, including its immutable pin. */
export const studioAppearanceValueKey = (value: unknown): string => {
  const canonical = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonical);
    if (isRecord(entry)) return Object.fromEntries(Object.keys(entry).sort()
      .filter((key) => entry[key] !== undefined).map((key) => [key, canonical(entry[key])]));
    return entry;
  };
  return JSON.stringify(canonical(value)) ?? "undefined";
};

/** A matched valid advisory response changes only overrides; saving still uses the human writer. */
export const applyStudioAppearance = (
  source: ApplicationSourceDocumentV2,
  rootId: string,
  draftRevision: number,
  submitted: StudioAppearanceRequest,
  response: StudioAppearanceResult,
): ApplicationSourceDocumentV2 | undefined => {
  if (response.kind !== "available" || !response.valid || response.failures.length !== 0 ||
      rootId !== submitted.rootId || rootId !== response.rootId ||
      draftRevision !== submitted.expectedDraftRevision || draftRevision !== response.draftRevision ||
      studioAppearanceValueKey(submitted.tokenOverrides) !== studioAppearanceValueKey(response.theme.token_overrides) ||
      studioAppearanceValueKey(source.body.theme.base) !== studioAppearanceValueKey(response.theme.base) ||
      studioAppearanceValueKey(source.body.theme.selection) !== studioAppearanceValueKey(response.theme.selection))
    return undefined;
  const candidate = applicationSourceDocumentV2Schema.parse(structuredClone(source));
  candidate.body.theme.token_overrides = structuredClone(response.theme.token_overrides);
  const parsed = applicationSourceDocumentV2Schema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
};
