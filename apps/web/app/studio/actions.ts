"use server";

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { z } from "zod";
import {
  applicationRootIdSchema,
  canonicalJson,
  organizationIdSchema,
  sameId,
  saveDefinitionDraftCommandSchema,
  sourceApplicationThemeSchema,
  translateDefinitionRuleFailures,
} from "@vortex/platform/schema";
import { findPinnedPlatformThemeRelease } from "./_lib/pinned-platform-theme-release";
import { createHumanApplicationDraftWriter, fingerprintCanonicalValue, materialiseApplicationTheme, validateDefinitionSource } from "@vortex/platform/server";
import { humanOrganizationRequests } from "../_lib/server-composition";
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
import { tokenName } from "@vortex/ui/studio";
import type { StudioThemeResolution } from "./_lib/studio-theme-options";
import type { StudioStoredApplicationDraft } from "@vortex/ui/studio";
import { readStudioPersonLabel } from "../_lib/studio-person-labels";
import { scheduleStudioPreviewMove } from "../_lib/studio-application-preview";
import type { StudioPersonLabel } from "../_lib/studio-application-restore-contracts";

const refuse = <Result>(operation: string, code: string, fallback: Result, cause?: unknown): Result =>
  mapWebError(cause, { route: "studio/actions", operation, code, fallback });

/** Advisory source review only: the existing Save resolves all write authority afresh. */
export async function reviewStudioApplicationSource(
  organizationId: string, candidate: unknown,
): Promise<StudioApplicationSourceReviewResult> {
  try {
    const request = studioApplicationSourceReviewRequestSchema.safeParse(candidate);
    if (!request.success)
      return refuse("review-application-source", "STUDIO_SOURCE_REVIEW_REQUEST_INVALID",
        { kind: "invalid" } as const, request.error);
    const loaded = await loadStudioApplicationDraft(organizationId, request.data.rootId, { compile: false });
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
    const session = await resolveIdentitySession();
    if (session.kind !== "active") return { kind: "refused" };
    const identities = await createHumanApplicationDraftWriter({
      requests: humanOrganizationRequests(), permissions: platformPermissionSource,
    }).reviewSource(session.session, organizationId, {
      rootId: draft.rootId, expectedDraftRevision: draft.draftRevision, source,
    });
    if (identities.kind !== "available") return identities;
    if (identities.conflicts.length > 0) return studioApplicationSourceReviewResultSchema.parse({
      kind: "identity_conflict", ...binding, conflicts: identities.conflicts,
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
  return prepareHumanDefinitionPublication(organizationId, candidate);
}

export async function publishStudioApplication(organizationId: string, candidate: unknown) {
  return publishHumanDefinition(organizationId, candidate);
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
  return createHumanApplicationDraft(organizationId, { source: candidate });
}

/** What one autosave came to: the platform's answer, or a conflict that names the newer saved draft. */
export type StudioSaveApplicationResult =
  | Awaited<ReturnType<typeof saveHumanApplicationDraft>>
  | Readonly<{ kind: "conflict"; reason: "draft_changed"; elsewhere: StudioDraftChangedElsewhere }>;

/** The saved draft another window or person wrote, which a save from this workspace no longer extends. */
export type StudioDraftChangedElsewhere = Readonly<{
  draft: StudioStoredApplicationDraft;
  /** Who wrote it, as the saving person may see them. */
  changedBy: StudioPersonLabel;
}>;

/**
 * Studio autosaves each batch through this one action. The draft is compiled for the canvas by the
 * separate `reopenStudioApplication` request the workspace sends once its saves are idle, so a save
 * never waits for a compile. Once a save has answered, the server moves the builder's existing
 * preview to the saved data shape when the save changed it, so the canvas and the Data tab read
 * the new revision's records without moving the preview themselves. A save that no longer extends
 * the saved revision is refused as a conflict that names who wrote the newer revision and carries
 * it, so the workspace can say what changed.
 */
export async function saveStudioApplication(organizationId: string, candidate: unknown): Promise<StudioSaveApplicationResult> {
  const saved = await saveHumanApplicationDraft(organizationId, candidate);
  if (saved.kind === "available") {
    const { draft } = saved;
    after(async () => {
      const resolved = await resolveIdentitySession();
      if (resolved.kind !== "active") return;
      await scheduleStudioPreviewMove(resolved.session, organizationIdSchema.parse(draft.organizationId),
        applicationRootIdSchema.parse(draft.rootId), draft.draftRevision);
    });
    return saved;
  }
  if (saved.kind !== "conflict" || saved.reason !== "draft_changed") return saved;
  const command = saveDefinitionDraftCommandSchema.pick({ rootId: true }).strip().parse(candidate);
  const latest = await loadStudioApplicationDraft(organizationId, command.rootId, { compile: false });
  if (latest.kind !== "available") {
    console.error(`[studio] the newer saved draft could not be read after a conflict: STUDIO_SAVE_CONFLICT_READ_${latest.kind.toUpperCase()}`);
    return saved;
  }
  const changedBy = await readStudioPersonLabel(organizationId, latest.draft.updatedBy);
  return { kind: "conflict", reason: "draft_changed", elsewhere: { draft: latest.draft, changedBy } };
}

const themeFailureWords: Readonly<Record<string, string>> = {
  INSUFFICIENT_CONTRAST: "does not have enough contrast to be read",
  HIDDEN_FOCUS: "would hide the focus outline",
  TRANSLUCENT_BACKGROUND: "is see-through where a solid colour is needed",
  UNKNOWN_THEME_OPTION: "is not an option of the pinned shadcn catalogue",
  REFUSED_THEME_OPTION: "is refused by the platform's readability check",
};
const themeDimensionWords: Readonly<Record<string, string>> = {
  style: "The style", baseColor: "The base colour", theme: "The theme colour", chartColor: "The chart colour",
  radius: "The radius", menuColor: "The menu colour", menuAccent: "The menu accent", iconLibrary: "The icon library",
  bodyFont: "The font", headingFont: "The heading font",
};
const describeThemeFailure = (failure: Readonly<{ code: string; tokenKey?: string | undefined }>): string => {
  const words = themeFailureWords[failure.code] ?? `is refused (${failure.code.toLowerCase().replaceAll("_", " ")})`;
  if (failure.tokenKey === undefined) return `This combination ${words}.`;
  const subject = themeDimensionWords[failure.tokenKey] ?? `The colour “${tokenName(failure.tokenKey)}”`;
  return `${subject} ${words} with these settings.`;
};

const themeRequestSchema = z.object({ rootId: z.string().min(1).max(200), theme: sourceApplicationThemeSchema }).strict();

/**
 * Resolves a candidate application theme with the producer publication uses, for the Theme tab's
 * check before an edit and for the canvas, which draws the draft's theme as it is edited. The
 * theme must keep the draft's pinned base release; only its selection and overrides change.
 */
export async function resolveStudioApplicationTheme(organizationId: string, candidate: unknown): Promise<StudioThemeResolution> {
  const request = themeRequestSchema.safeParse(candidate);
  if (!request.success) return refuse("resolve-theme", "STUDIO_THEME_REQUEST_INVALID", { kind: "refused" } as const, request.error);
  const loaded = await loadStudioApplicationDraft(organizationId, request.data.rootId, { compile: false });
  if (loaded.kind !== "available") return { kind: loaded.kind };
  const draft = loaded.draft;
  if (draft.rootId !== request.data.rootId ||
    canonicalJson(draft.source.body.theme.base) !== canonicalJson(request.data.theme.base))
    return refuse("resolve-theme", "STUDIO_THEME_BASE_MISMATCH", { kind: "refused" } as const);
  try {
    const release = findPinnedPlatformThemeRelease(request.data.theme.base);
    if (release === undefined) return refuse("resolve-theme", "STUDIO_THEME_RELEASE_UNKNOWN", { kind: "refused" } as const);
    const result = materialiseApplicationTheme(request.data.theme, draft.key, release);
    if (result.valid) return { kind: "available", valid: true, theme: result.theme };
    console.error(`[studio] theme resolution refused: ${result.failures.map((failure) => `${failure.code}:${failure.tokenKey ?? ""}`).slice(0, 8).join(",")}`);
    return { kind: "available", valid: false, problems: [...new Set(result.failures.map(describeThemeFailure))].slice(0, 6) };
  } catch (error) {
    return refuse("resolve-theme", "STUDIO_THEME_RESOLUTION_FAILED", { kind: "temporarily_unavailable" } as const, error);
  }
}
