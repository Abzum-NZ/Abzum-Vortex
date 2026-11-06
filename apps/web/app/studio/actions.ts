"use server";

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { z } from "zod";
import {
  applicationRootIdSchema,
  canonicalApplicationThemeSelection,
  canonicalJson,
  organizationIdSchema,
  organizationSelectionCandidateSchema,
  organizationThemeDelta,
  sameId,
  saveDefinitionDraftCommandSchema,
  sourceApplicationThemeSchema,
  translateDefinitionRuleFailures,
  type StudioStoredApplicationDraft,
  type StudioApplicationConditionContextResult,
} from "@vortex/platform/schema";
import { findPinnedPlatformThemeRelease } from "./_lib/pinned-platform-theme-release";
import {
  resolveApplicationTheme,
  changeCurrentOrganizationThemeAfterAuthorization,
  createHumanApplicationDraftWriter,
  DEFAULT_PLATFORM_THEME_RELEASE,
  fingerprintCanonicalValue,
  materialiseApplicationTheme,
  readOrganizationThemeChangePermittedAfterAuthorization,
  resolveThemeSelection,
  validateDefinitionSource,
} from "@vortex/platform/server";
import { humanOrganizationRequests } from "../_lib/server-composition";
import { loadOrganizationTheme } from "../_lib/organization-theme";
import { saveHumanApplicationDraft } from "../_lib/definition-draft-write";
import { mapWebError } from "../_lib/web-error-mapper";
import {
  compileStudioApplicationSource,
  loadStudioApplicationDraft,
} from "../_lib/studio-application-draft";
import { describeStudioCompileFailure } from "./_lib/studio-compile-failure";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { readSavedStudioApplicationConditionContext } from "../_lib/studio-application-condition-context";
import {
  studioApplicationSourceReviewRequestSchema,
  studioApplicationSourceReviewResultSchema,
  type StudioApplicationSourceReviewResult,
} from "./_lib/application-source-import";
import { platformPermissionSource } from "../_lib/platform-permission-source";
import { definitionLimits, tokenName } from "@vortex/platform/schema";
import type {
  StudioOrganizationThemeSave,
  StudioThemeResolution,
} from "./_lib/studio-theme-options";
import { readStudioPersonLabel } from "../_lib/studio-person-labels";
import { scheduleStudioPreviewMove } from "../_lib/studio-application-preview";
import type { StudioPersonLabel } from "../_lib/studio-application-restore-contracts";

const refuse = <Result>(
  operation: string,
  code: string,
  fallback: Result,
  cause?: unknown,
): Result => mapWebError(cause, { route: "studio/actions", operation, code, fallback });

/**
 * Advisory source review only (the file import dialog and the agent tools): the existing Save
 * resolves all write authority afresh.
 */
export async function reviewStudioApplicationSource(
  organizationId: string,
  candidate: unknown,
): Promise<StudioApplicationSourceReviewResult> {
  try {
    const request = studioApplicationSourceReviewRequestSchema.safeParse(candidate);
    if (!request.success)
      return refuse(
        "review-application-source",
        "STUDIO_SOURCE_REVIEW_REQUEST_INVALID",
        { kind: "invalid" } as const,
        request.error,
      );
    const loaded = await loadStudioApplicationDraft(organizationId, request.data.rootId);
    if (loaded.kind !== "available")
      return loaded.kind === "validation_failed" ? { kind: "refused" } : loaded;
    const draft = loaded.draft;
    if (
      !sameId(draft.rootId, request.data.rootId) ||
      !sameId(loaded.organizationId, organizationId)
    )
      return refuse("review-application-source", "STUDIO_SOURCE_REVIEW_SCOPE_MISMATCH", {
        kind: "refused",
      } as const);
    if (
      draft.draftRevision !== request.data.expectedDraftRevision ||
      draft.sourceFingerprint !== request.data.expectedSavedSourceFingerprint
    )
      return { kind: "conflict" };
    const source = request.data.source;
    if (
      source.key !== draft.key ||
      source.root_alias !== draft.source.root_alias ||
      new TextEncoder().encode(canonicalJson(source)).byteLength >
        definitionLimits.sourceImportBytes
    )
      return refuse("review-application-source", "STUDIO_SOURCE_REVIEW_SOURCE_REJECTED", {
        kind: "invalid",
      } as const);
    const binding = {
      organizationId: draft.organizationId,
      rootId: draft.rootId,
      key: draft.key,
      rootAlias: draft.source.root_alias,
      draftRevision: draft.draftRevision,
      savedSourceFingerprint: draft.sourceFingerprint,
      candidateSourceFingerprint: fingerprintCanonicalValue(source),
    };
    const validation = validateDefinitionSource(source, platformPermissionSource);
    if (!validation.valid)
      return studioApplicationSourceReviewResultSchema.parse({
        kind: "validation_failed",
        ...binding,
        validation: translateDefinitionRuleFailures(validation.failures, {
          correlationId: randomUUID(),
          rootLocation: {
            documentKind: "application",
            documentKey: draft.key,
            segments: [],
          },
        }),
      });
    const session = await resolveIdentitySession();
    if (session.kind !== "active") return { kind: "refused" };
    const identities = await createHumanApplicationDraftWriter({
      requests: humanOrganizationRequests(),
      permissions: platformPermissionSource,
    }).reviewSource(session.session, organizationId, {
      rootId: draft.rootId,
      expectedDraftRevision: draft.draftRevision,
      source,
    });
    if (identities.kind !== "available") return identities;
    if (identities.conflicts.length > 0)
      return studioApplicationSourceReviewResultSchema.parse({
        kind: "identity_conflict",
        ...binding,
        conflicts: identities.conflicts,
      });
    // The cheaper identity check came first. A file the compiler refuses would leave an application
    // that draws nothing: say why before the draft is replaced.
    const compiled = await compileStudioApplicationSource(
      organizationId,
      draft.rootId,
      draft.draftRevision,
      source,
    );
    if (compiled.kind === "compile_refused")
      return studioApplicationSourceReviewResultSchema.parse({
        kind: "compile_refused",
        ...binding,
        message: describeStudioCompileFailure(compiled.failure, source).message,
      });
    if (compiled.kind !== "compiles") return compiled;
    return studioApplicationSourceReviewResultSchema.parse({
      kind: "available",
      ...binding,
      source,
    });
  } catch (error) {
    return refuse(
      "review-application-source",
      "STUDIO_SOURCE_REVIEW_FAILED",
      { kind: "temporarily_unavailable" } as const,
      error,
    );
  }
}

/** Metadata is resolved only from the server's active human session and exact saved draft. */
export async function resolveStudioApplicationConditionContext(
  organizationId: string,
  candidate: unknown,
): Promise<StudioApplicationConditionContextResult> {
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return refuse(
        "read-condition-context",
        `STUDIO_CONDITION_CONTEXT_SESSION_${resolved.kind.toUpperCase()}`,
        resolved.kind === "temporarily_unavailable"
          ? ({ kind: "temporarily_unavailable" } as const)
          : ({ kind: "refused" } as const),
      );
    return await readSavedStudioApplicationConditionContext(
      resolved.session,
      organizationId,
      candidate,
    );
  } catch (error) {
    return refuse(
      "read-condition-context",
      "STUDIO_CONDITION_CONTEXT_FAILED",
      { kind: "temporarily_unavailable" } as const,
      error,
    );
  }
}

/** What one autosave came to: the platform's answer, or a conflict that names the newer saved draft. */
type StudioSaveApplicationResult =
  | Awaited<ReturnType<typeof saveHumanApplicationDraft>>
  | Readonly<{
      kind: "conflict";
      reason: "draft_changed";
      elsewhere: StudioDraftChangedElsewhere;
    }>;

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
export async function saveStudioApplication(
  organizationId: string,
  candidate: unknown,
): Promise<StudioSaveApplicationResult> {
  const saved = await saveHumanApplicationDraft(organizationId, candidate);
  if (saved.kind === "available") {
    const { draft } = saved;
    after(async () => {
      const resolved = await resolveIdentitySession();
      if (resolved.kind !== "active") {
        console.error(
          `[studio] preview move skipped: STUDIO_PREVIEW_MOVE_SESSION_NOT_ACTIVE ${resolved.kind} revision=${draft.draftRevision}`,
        );
        return;
      }
      await scheduleStudioPreviewMove(
        resolved.session,
        organizationIdSchema.parse(draft.organizationId),
        applicationRootIdSchema.parse(draft.rootId),
        draft.draftRevision,
      );
    });
    return saved;
  }
  if (saved.kind !== "conflict" || saved.reason !== "draft_changed") return saved;
  const command = saveDefinitionDraftCommandSchema.pick({ rootId: true }).strip().parse(candidate);
  const latest = await loadStudioApplicationDraft(organizationId, command.rootId);
  if (latest.kind !== "available") {
    console.error(
      `[studio] the newer saved draft could not be read after a conflict: STUDIO_SAVE_CONFLICT_READ_${latest.kind.toUpperCase()}`,
    );
    return saved;
  }
  const changedBy = await readStudioPersonLabel(organizationId, latest.draft.updatedBy);
  return {
    kind: "conflict",
    reason: "draft_changed",
    elsewhere: { draft: latest.draft, changedBy },
  };
}

const themeFailureWords: Readonly<Record<string, string>> = {
  INSUFFICIENT_CONTRAST: "does not have enough contrast to be read",
  HIDDEN_FOCUS: "would hide the focus outline",
  TRANSLUCENT_BACKGROUND: "is see-through where a solid colour is needed",
  UNKNOWN_THEME_OPTION: "is not an option of the pinned shadcn catalogue",
  REFUSED_THEME_OPTION: "is refused by the platform's readability check",
};
const themeDimensionWords: Readonly<Record<string, string>> = {
  style: "The style",
  baseColor: "The base colour",
  theme: "The theme colour",
  chartColor: "The chart colour",
  radius: "The radius",
  menuColor: "The menu colour",
  menuAccent: "The menu accent",
  iconLibrary: "The icon library",
  bodyFont: "The font",
  headingFont: "The heading font",
};
const describeThemeFailure = (
  failure: Readonly<{ code: string; tokenKey?: string | undefined }>,
): string => {
  const words =
    themeFailureWords[failure.code] ??
    `is refused (${failure.code.toLowerCase().replaceAll("_", " ")})`;
  if (failure.tokenKey === undefined) return `This combination ${words}.`;
  const subject =
    themeDimensionWords[failure.tokenKey] ?? `The colour “${tokenName(failure.tokenKey)}”`;
  return `${subject} ${words} with these settings.`;
};

/** The failure codes of a refused theme for its one log line. */
const themeFailureCodes = (
  failures: readonly Readonly<{ code: string; tokenKey?: string | undefined }>[],
): string =>
  failures
    .map((failure) => `${failure.code}:${failure.tokenKey ?? ""}`)
    .slice(0, 8)
    .join(",");

const themeRequestSchema = z
  .object({
    rootId: z.string().min(1).max(200),
    theme: sourceApplicationThemeSchema,
  })
  .strict();

/**
 * Resolves a candidate application theme with the producer publication uses, for the Theme tab's
 * check before an edit and for the canvas, which draws the draft's theme as it is edited. The
 * candidate's base may be any registered platform theme release: choosing one of the platform's
 * themes in the Theme tab changes the pin as well as the selection.
 */
export async function resolveStudioApplicationTheme(
  organizationId: string,
  candidate: unknown,
): Promise<StudioThemeResolution> {
  const request = themeRequestSchema.safeParse(candidate);
  if (!request.success)
    return refuse(
      "resolve-theme",
      "STUDIO_THEME_REQUEST_INVALID",
      { kind: "refused" } as const,
      request.error,
    );
  const loaded = await loadStudioApplicationDraft(organizationId, request.data.rootId);
  if (loaded.kind !== "available")
    return { kind: loaded.kind === "validation_failed" ? "refused" : loaded.kind };
  const draft = loaded.draft;
  if (draft.rootId !== request.data.rootId)
    return refuse("resolve-theme", "STUDIO_THEME_ROOT_MISMATCH", {
      kind: "refused",
    } as const);
  try {
    const release = findPinnedPlatformThemeRelease(request.data.theme.base);
    if (release === undefined)
      return refuse("resolve-theme", "STUDIO_THEME_RELEASE_UNKNOWN", {
        kind: "refused",
      } as const);
    const result = materialiseApplicationTheme(request.data.theme, draft.key, release);
    if (result.valid) {
      // The canvas draws the application as it runs: its theme through the organisation's.
      const identity = await resolveIdentitySession();
      if (identity.kind !== "active") return { kind: "refused" };
      const organization = await loadOrganizationTheme(identity.session, organizationId);
      if (organization.kind !== "available")
        return { kind: organization.kind === "unavailable" ? "refused" : organization.kind };
      return {
        kind: "available",
        valid: true,
        theme: resolveApplicationTheme(result.theme, organization.theme.selection),
      };
    }
    // The person chose a combination the readability checks refuse: an expected refusal.
    console.info(`[studio] theme resolution refused: ${themeFailureCodes(result.failures)}`);
    return {
      kind: "available",
      valid: false,
      problems: [...new Set(result.failures.map(describeThemeFailure))].slice(0, 6),
    };
  } catch (error) {
    return refuse(
      "resolve-theme",
      "STUDIO_THEME_RESOLUTION_FAILED",
      { kind: "temporarily_unavailable" } as const,
      error,
    );
  }
}

const organizationThemeRequestSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    selection: sourceApplicationThemeSchema.shape.selection,
  })
  .strict();

/**
 * Saves the organisation theme: the dimensions of the chosen selection that differ from the
 * platform default. The selection is resolved over the platform default theme with the checks
 * publication runs, so a combination the readability checks refuse is never stored. The database
 * decides who may change it (the organisation settings manage permission) and the revision; the
 * permission is read first so a member without it is refused cleanly.
 */
export async function saveStudioOrganizationTheme(
  organizationId: string,
  candidate: unknown,
): Promise<StudioOrganizationThemeSave> {
  const request = organizationThemeRequestSchema.safeParse(candidate);
  const organization = organizationIdSchema.safeParse(organizationId);
  if (!request.success || !organization.success)
    return refuse(
      "save-organization-theme",
      "STUDIO_ORGANIZATION_THEME_REQUEST_INVALID",
      { kind: "refused" } as const,
      request.success ? organization.error : request.error,
    );
  const selection = canonicalApplicationThemeSelection(request.data.selection);
  const resolution = resolveThemeSelection({
    base: DEFAULT_PLATFORM_THEME_RELEASE,
    baseTokens: DEFAULT_PLATFORM_THEME_RELEASE.tokens,
    selection,
  });
  if (!resolution.valid) {
    console.info(`[studio] organisation theme refused: ${themeFailureCodes(resolution.failures)}`);
    return {
      kind: "invalid",
      problems: [...new Set(resolution.failures.map(describeThemeFailure))].slice(0, 6),
    };
  }
  try {
    const identity = await resolveIdentitySession();
    if (identity.kind !== "active") return { kind: "refused" };
    const result = await humanOrganizationRequests().run(
      identity.session,
      organizationSelectionCandidateSchema.parse({ organizationId: organization.data }),
      async (transaction) =>
        (await readOrganizationThemeChangePermittedAfterAuthorization(transaction))
          ? changeCurrentOrganizationThemeAfterAuthorization(
              transaction,
              request.data.expectedRevision,
              organizationThemeDelta(selection),
            )
          : undefined,
    );
    if (result.kind === "temporarily_unavailable")
      return refuse(
        "save-organization-theme",
        "STUDIO_ORGANIZATION_THEME_UNAVAILABLE",
        { kind: "temporarily_unavailable" } as const,
        new Error(result.databaseCode ?? result.cause ?? "unavailable"),
      );
    if (result.kind !== "available" || result.value === undefined) {
      console.info("[studio] the organisation theme change was refused for this person");
      return { kind: "refused" };
    }
    return { kind: result.value.outcome, revision: result.value.revision };
  } catch (error) {
    return refuse(
      "save-organization-theme",
      "STUDIO_ORGANIZATION_THEME_SAVE_FAILED",
      { kind: "temporarily_unavailable" } as const,
      error,
    );
  }
}
