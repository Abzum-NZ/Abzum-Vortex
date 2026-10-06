"use server";

import {
  applicationSourceDocumentV2Schema,
  canonicalJson,
  sameId,
  saveDefinitionDraftCommandSchema,
  PLATFORM_THEME_RELEASE_2_0_0,
  PLATFORM_THEME_RELEASE_3_0_0,
  sourceThemeTokenValueV2Schema,
  type ApplicationContentV2,
} from "@vortex/contracts";
import { fingerprintCanonicalValue, materialiseApplicationThemeV2, validateDefinitionSource } from "@vortex/definition";
import {
  parseStudioAppearanceRequest,
  studioAppearanceFailureCodes,
  type StudioAppearanceFailure,
  type StudioAppearanceResult,
  type StudioThemeTokenValue,
} from "@vortex/studio";
import { createHumanApplicationDraft, saveHumanApplicationDraft } from "../_lib/definition-draft-write";
import { loadStudioApplicationDraft } from "../_lib/studio-application-draft";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { readSavedStudioApplicationConditionContext } from "../_lib/studio-application-condition-context";
import type { StudioApplicationConditionContextResult } from "@vortex/studio";
import { prepareHumanApplicationPublication, publishHumanApplication } from "../_lib/definition-publication";
import {
  maximumApplicationSourceImportBytes,
  studioApplicationSourceReviewRequestSchema,
  studioApplicationSourceReviewResultSchema,
  type StudioApplicationSourceReviewResult,
} from "./_lib/application-source-import";

/** Advisory source review only: the existing Save resolves all write authority afresh. */
export async function reviewStudioApplicationSource(
  organizationId: string, candidate: unknown,
): Promise<StudioApplicationSourceReviewResult> {
  try {
    const request = studioApplicationSourceReviewRequestSchema.safeParse(candidate);
    if (!request.success) return { kind: "invalid" };
    const loaded = await loadStudioApplicationDraft(organizationId, request.data.rootId);
    if (loaded.kind !== "available") return loaded;
    const draft = loaded.draft;
    if (!sameId(draft.rootId, request.data.rootId) || !sameId(loaded.organizationId, organizationId))
      return { kind: "refused" };
    if (draft.draftRevision !== request.data.expectedDraftRevision ||
      draft.sourceFingerprint !== request.data.expectedSavedSourceFingerprint)
      return { kind: "conflict" };
    const source = request.data.source;
    if (source.key !== draft.key || source.root_alias !== draft.source.root_alias ||
      new TextEncoder().encode(canonicalJson(source)).byteLength > maximumApplicationSourceImportBytes ||
      !validateDefinitionSource(source).valid) return { kind: "invalid" };
    return studioApplicationSourceReviewResultSchema.parse({
      kind: "available", organizationId: draft.organizationId, rootId: draft.rootId,
      key: draft.key, rootAlias: draft.source.root_alias, draftRevision: draft.draftRevision,
      savedSourceFingerprint: draft.sourceFingerprint,
      candidateSourceFingerprint: fingerprintCanonicalValue(source), source,
    });
  } catch { return { kind: "temporarily_unavailable" }; }
}

/** Separate explicit requests: preparation never installs or publishes a release. */
export async function prepareStudioApplicationPublication(organizationId: string, candidate: unknown) {
  return prepareHumanApplicationPublication(organizationId, candidate);
}

export async function publishStudioApplication(organizationId: string, candidate: unknown) {
  return publishHumanApplication(organizationId, candidate);
}

/** Metadata is resolved only from the server's active human session and exact saved draft. */
export async function resolveStudioApplicationConditionContext(
  organizationId: string, candidate: unknown,
): Promise<StudioApplicationConditionContextResult> {
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active") return resolved.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" } : { kind: "refused" };
    return await readSavedStudioApplicationConditionContext(resolved.session, organizationId, candidate);
  } catch { return { kind: "temporarily_unavailable" }; }
}

/** A browser document is authored input, never authority or evidence of an installed Module. */
export async function createStudioApplication(organizationId: string, candidate: unknown) {
  const source = applicationSourceDocumentV2Schema.safeParse(candidate);
  if (!source.success || !validateDefinitionSource(source.data).valid)
    return { kind: "refused" } as const;
  return createHumanApplicationDraft(organizationId, { source: source.data });
}

export async function saveStudioApplication(organizationId: string, candidate: unknown) {
  const command = saveDefinitionDraftCommandSchema.safeParse(candidate);
  if (!command.success || command.data.source.kind !== "application" ||
    !validateDefinitionSource(command.data.source).valid)
    return { kind: "refused" } as const;
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
  if (request === undefined) return { kind: "refused" };
  const loaded = await loadStudioApplicationDraft(organizationId, request.rootId);
  if (loaded.kind !== "available") return loaded;
  const draft = loaded.draft;
  if (draft.rootId !== request.rootId) return { kind: "refused" };
  if (draft.draftRevision !== request.expectedDraftRevision) return { kind: "conflict" };
  try {
    const authored = draft.source.body.theme;
    const pin = authored.base;
    const release = [PLATFORM_THEME_RELEASE_2_0_0, PLATFORM_THEME_RELEASE_3_0_0].find((item) =>
      item.catalogueThemeId === pin.catalogue_theme_id && item.releaseVersion === pin.release_version &&
      item.contentFingerprint === pin.content_fingerprint && item.catalogueFingerprint === pin.catalogue_fingerprint);
    if (release === undefined) return { kind: "refused" };
    const inherited = materialiseApplicationThemeV2({ ...authored, token_overrides: {} }, draft.key, release);
    if (!inherited.valid) return { kind: "refused" };
    const sourceValue = (value: ApplicationContentV2["theme"]["tokens"][string]): StudioThemeTokenValue => {
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
      .map(([key, value]) => ({ key, inherited: sourceThemeTokenValueV2Schema.parse(sourceValue(value)) }));
    const keys = new Set(tokens.map((token) => token.key));
    const theme = { ...authored, token_overrides: request.tokenOverrides };
    const result = materialiseApplicationThemeV2(theme, draft.key, release);
    const failures: StudioAppearanceFailure[] = [];
    if (!result.valid) {
      // The finite registered token set bounds every engine pair and per-token check. Refuse an
      // impossible output instead of dropping contrast failures or claiming a partial success.
      if (result.failures.length > 4 * tokens.length ** 2 + 8 * tokens.length + 64)
        return { kind: "temporarily_unavailable" };
      for (const failure of result.failures) {
        const code = studioAppearanceFailureCodes.find((item) => item === failure.code) ?? "VALIDATION_FAILED";
        const family = failure.family === "broken_reference" || failure.family === "unsafe_content"
          ? failure.family : "invalid_value";
        failures.push({ code, ruleCode: "vortex.definition.application_block_settings", family,
          ...(failure.tokenKey !== undefined && keys.has(failure.tokenKey) ? { tokenKey: failure.tokenKey } : {}) });
      }
      if (failures.length === 0) return { kind: "temporarily_unavailable" };
    }
    const publicAssetIds = [...new Set(Object.values(release.tokens)
      .flatMap((token) => token.kind === "asset" ? [String(token.assetId)] : []))].sort();
    return { kind: "available", rootId: draft.rootId, draftRevision: draft.draftRevision,
      theme, tokens, publicAssetIds, valid: result.valid, failures };
  } catch {
    return { kind: "refused" };
  }
}
