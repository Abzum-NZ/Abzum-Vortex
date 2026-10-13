"use server";

import { randomUUID } from "node:crypto";
import {
  applicationSourceDocumentSchema,
  canonicalJson,
  sameId,
  saveDefinitionDraftCommandSchema,
  sourceThemeTokenValueSchema,
  translateDefinitionRuleFailures,
  type ApplicationContent,
} from "@vortex/platform/schema";
import { findPinnedPlatformThemeRelease } from "./_lib/pinned-platform-theme-release";
import { checkPlacementThemeOverrides, fingerprintCanonicalValue, materialiseApplicationTheme, validateDefinitionSource } from "@vortex/platform/server";
import {
  parseStudioAppearanceRequest,
  parseStudioPlacementThemeRequest,
  studioAppearanceFailureCodes,
  type StudioAppearanceFailure,
  type StudioAppearanceResult,
  type StudioPlacementThemeFailure,
  type StudioPlacementThemeResult,
  type StudioThemeTokenValue,
} from "@vortex/ui/studio";
import { createHumanApplicationDraft, saveHumanApplicationDraft } from "../_lib/definition-draft-write";
import { mapWebError } from "../_lib/web-error-mapper";
import { loadStudioApplicationDraft } from "../_lib/studio-application-draft";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { readSavedStudioApplicationConditionContext } from "../_lib/studio-application-condition-context";
import type { StudioApplicationConditionContextResult } from "@vortex/ui/studio";
import { prepareHumanDefinitionPublication, publishHumanDefinition } from "../_lib/definition-publication";
import {
  maximumApplicationSourceImportBytes,
  studioApplicationSourceReviewRequestSchema,
  studioApplicationSourceReviewResultSchema,
  type StudioApplicationSourceReviewResult,
} from "./_lib/application-source-import";
import { platformPermissionSource } from "../_lib/platform-permission-source";

const refuse = <Result>(operation: string, code: string, fallback: Result, cause?: unknown): Result =>
  mapWebError(cause, { route: "studio/actions", operation, code, fallback });

const failureCodes = (validation: {
  readonly failures: readonly { readonly ruleCode: string }[];
}): string =>
  validation.failures.map((failure) => failure.ruleCode).slice(0, 8).join(",");

/** Advisory source review only: the existing Save resolves all write authority afresh. */
export async function reviewStudioApplicationSource(
  organizationId: string, candidate: unknown,
): Promise<StudioApplicationSourceReviewResult> {
  try {
    const request = studioApplicationSourceReviewRequestSchema.safeParse(candidate);
    if (!request.success)
      return refuse("review-application-source", "STUDIO_SOURCE_REVIEW_REQUEST_INVALID",
        { kind: "invalid" } as const, request.error);
    const loaded = await loadStudioApplicationDraft(organizationId, request.data.rootId);
    if (loaded.kind !== "available") return loaded;
    const draft = loaded.draft;
    if (!sameId(draft.rootId, request.data.rootId) || !sameId(loaded.organizationId, organizationId))
      return refuse("review-application-source", "STUDIO_SOURCE_REVIEW_SCOPE_MISMATCH",
        { kind: "refused" } as const);
    if (draft.draftRevision !== request.data.expectedDraftRevision ||
      draft.sourceFingerprint !== request.data.expectedSavedSourceFingerprint)
      return { kind: "conflict" };
    const source = request.data.source;
    if (source.key !== draft.key || source.root_alias !== draft.source.root_alias ||
      new TextEncoder().encode(canonicalJson(source)).byteLength > maximumApplicationSourceImportBytes)
      return refuse("review-application-source", "STUDIO_SOURCE_REVIEW_SOURCE_REJECTED",
        { kind: "invalid" } as const);
    const binding = {
      organizationId: draft.organizationId, rootId: draft.rootId,
      key: draft.key, rootAlias: draft.source.root_alias, draftRevision: draft.draftRevision,
      savedSourceFingerprint: draft.sourceFingerprint,
      candidateSourceFingerprint: fingerprintCanonicalValue(source),
    };
    const validation = validateDefinitionSource(source, platformPermissionSource);
    if (!validation.valid) return studioApplicationSourceReviewResultSchema.parse({
      kind: "validation_failed", ...binding,
      validation: translateDefinitionRuleFailures(validation.failures, {
        correlationId: randomUUID(),
        rootLocation: { documentKind: "application", documentKey: draft.key, segments: [] },
      }),
    });
    return studioApplicationSourceReviewResultSchema.parse({
      kind: "available", ...binding, source,
    });
  } catch (error) {
    return refuse("review-application-source", "STUDIO_SOURCE_REVIEW_FAILED",
      { kind: "temporarily_unavailable" } as const, error);
  }
}

/** Separate explicit requests: preparation never installs or publishes a release. */
export async function prepareStudioApplicationPublication(organizationId: string, candidate: unknown) {
  return prepareHumanDefinitionPublication(organizationId, candidate, "application");
}

export async function publishStudioApplication(organizationId: string, candidate: unknown) {
  return publishHumanDefinition(organizationId, candidate, "application");
}

/** Metadata is resolved only from the server's active human session and exact saved draft. */
export async function resolveStudioApplicationConditionContext(
  organizationId: string, candidate: unknown,
): Promise<StudioApplicationConditionContextResult> {
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return refuse("read-condition-context", `STUDIO_CONDITION_CONTEXT_SESSION_${resolved.kind.toUpperCase()}`,
        resolved.kind === "temporarily_unavailable"
          ? { kind: "temporarily_unavailable" } as const : { kind: "refused" } as const);
    return await readSavedStudioApplicationConditionContext(resolved.session, organizationId, candidate);
  } catch (error) {
    return refuse("read-condition-context", "STUDIO_CONDITION_CONTEXT_FAILED",
      { kind: "temporarily_unavailable" } as const, error);
  }
}

/** A browser document is authored input, never authority or evidence of an installed Module. */
export async function createStudioApplication(organizationId: string, candidate: unknown) {
  const source = applicationSourceDocumentSchema.safeParse(candidate);
  if (!source.success)
    return refuse("create-application", "STUDIO_CREATE_SOURCE_SCHEMA_INVALID",
      { kind: "refused", reason: "source_invalid" } as const, source.error);
  const validation = validateDefinitionSource(source.data, platformPermissionSource);
  if (!validation.valid)
    return refuse("create-application", `STUDIO_CREATE_SOURCE_INVALID:${failureCodes(validation)}`,
      { kind: "refused", reason: "source_invalid" } as const);
  return createHumanApplicationDraft(organizationId, { source: source.data });
}

export async function saveStudioApplication(organizationId: string, candidate: unknown) {
  const command = saveDefinitionDraftCommandSchema.safeParse(candidate);
  if (!command.success)
    return refuse("save-application", "STUDIO_SAVE_COMMAND_SCHEMA_INVALID",
      { kind: "refused", reason: "source_invalid" } as const, command.error);
  if (command.data.source.kind !== "application")
    return refuse("save-application", "STUDIO_SAVE_SOURCE_NOT_APPLICATION",
      { kind: "refused", reason: "source_invalid" } as const);
  const validation = validateDefinitionSource(command.data.source, platformPermissionSource);
  if (!validation.valid)
    return refuse("save-application", `STUDIO_SAVE_SOURCE_INVALID:${failureCodes(validation)}`,
      { kind: "refused", reason: "source_invalid" } as const);
  return saveHumanApplicationDraft(organizationId, command.data);
}

export async function reopenStudioApplication(organizationId: string, applicationRootId: string) {
  return loadStudioApplicationDraft(organizationId, applicationRootId);
}

/** Current protected read precedes all theme-specific descriptors and advisory feedback. */
export async function validateStudioApplicationAppearance(
  organizationId: string,
  candidate: unknown,
): Promise<StudioAppearanceResult> {
  const request = parseStudioAppearanceRequest(candidate);
  if (request === undefined)
    return refuse("validate-appearance", "STUDIO_APPEARANCE_REQUEST_INVALID", { kind: "refused" } as const);
  const loaded = await loadStudioApplicationDraft(organizationId, request.rootId);
  if (loaded.kind !== "available") return loaded;
  const draft = loaded.draft;
  if (draft.rootId !== request.rootId)
    return refuse("validate-appearance", "STUDIO_APPEARANCE_ROOT_MISMATCH", { kind: "refused" } as const);
  if (draft.draftRevision !== request.expectedDraftRevision) return { kind: "conflict" };
  try {
    const authored = draft.source.body.theme;
    const pin = authored.base;
    const release = findPinnedPlatformThemeRelease(pin);
    if (release === undefined)
      return refuse("validate-appearance", "STUDIO_APPEARANCE_RELEASE_UNKNOWN", { kind: "refused" } as const);
    const inherited = materialiseApplicationTheme({ ...authored, token_overrides: {} }, draft.key, release);
    if (!inherited.valid)
      return refuse("validate-appearance", "STUDIO_APPEARANCE_INHERITED_THEME_INVALID", { kind: "refused" } as const);
    const sourceValue = (value: ApplicationContent["theme"]["tokens"][string]): StudioThemeTokenValue => {
      switch (value.kind) {
        case "color_pair": return { kind: value.kind, light: value.light, dark: value.dark };
        case "typography": return { kind: value.kind, family: value.family, size_rem: value.sizeRem,
          line_height: value.lineHeight, weight: value.weight };
        case "border": return { kind: value.kind, width_rem: value.widthRem, style: value.style,
          color_token: value.colorToken };
        case "focus": return { kind: value.kind, width_rem: value.widthRem, color_token: value.colorToken };
        case "asset": return { kind: value.kind, asset_id: value.assetId };
        default: return value;
      }
    };
    const tokens = Object.entries(inherited.theme.tokens).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, inherited: sourceThemeTokenValueSchema.parse(sourceValue(value)) }));
    const keys = new Set(tokens.map((token) => token.key));
    const theme = { ...authored, token_overrides: request.tokenOverrides };
    const result = materialiseApplicationTheme(theme, draft.key, release);
    const failures: StudioAppearanceFailure[] = [];
    if (!result.valid) {
      // The finite registered token set bounds every engine pair and per-token check. Refuse an
      // impossible output instead of dropping contrast failures or claiming a partial success.
      if (result.failures.length > 4 * tokens.length ** 2 + 8 * tokens.length + 64)
        return refuse("validate-appearance", "STUDIO_APPEARANCE_FAILURES_UNBOUNDED",
          { kind: "temporarily_unavailable" } as const);
      for (const failure of result.failures) {
        const code = studioAppearanceFailureCodes.find((item) => item === failure.code) ?? "VALIDATION_FAILED";
        const family = failure.family === "broken_reference" || failure.family === "unsafe_content"
          ? failure.family : "invalid_value";
        failures.push({ code, ruleCode: "vortex.definition.application_block_settings", family,
          ...(failure.tokenKey !== undefined && keys.has(failure.tokenKey) ? { tokenKey: failure.tokenKey } : {}) });
      }
      if (failures.length === 0)
        return refuse("validate-appearance", "STUDIO_APPEARANCE_FAILURES_EMPTY",
          { kind: "temporarily_unavailable" } as const);
    }
    const publicAssetIds = [...new Set(Object.values(release.tokens)
      .flatMap((token) => token.kind === "asset" ? [String(token.assetId)] : []))].sort();
    return { kind: "available", rootId: draft.rootId, draftRevision: draft.draftRevision,
      theme, tokens, publicAssetIds, valid: result.valid, failures };
  } catch (error) {
    return refuse("validate-appearance", "STUDIO_APPEARANCE_FAILED", { kind: "refused" } as const, error);
  }
}

/** Judges placement theme overrides with the checks publication applies, before the person saves. */
export async function validateStudioPlacementThemeOverrides(
  organizationId: string,
  candidate: unknown,
): Promise<StudioPlacementThemeResult> {
  const request = parseStudioPlacementThemeRequest(candidate);
  if (request === undefined) return { kind: "refused" };
  const loaded = await loadStudioApplicationDraft(organizationId, request.rootId);
  if (loaded.kind !== "available") return loaded;
  const draft = loaded.draft;
  if (draft.rootId !== request.rootId) return { kind: "refused" };
  if (draft.draftRevision !== request.expectedDraftRevision) return { kind: "conflict" };
  try {
    const release = findPinnedPlatformThemeRelease(draft.source.body.theme.base);
    if (release === undefined) return { kind: "refused" };
    const failures: StudioPlacementThemeFailure[] = [];
    for (const placement of request.placements)
      for (const failure of checkPlacementThemeOverrides(
        request.theme, placement.themeOverrides, draft.key, release,
      )) {
        const code = studioAppearanceFailureCodes.find((item) => item === failure.code) ?? "VALIDATION_FAILED";
        failures.push({ alias: placement.alias, code,
          ...(failure.tokenKey === undefined ? {} : { tokenKey: failure.tokenKey }) });
      }
    return { kind: "available", failures };
  } catch (error) {
    console.error("STUDIO_PLACEMENT_THEME_CHECK_FAILED", error);
    return { kind: "temporarily_unavailable" };
  }
}
