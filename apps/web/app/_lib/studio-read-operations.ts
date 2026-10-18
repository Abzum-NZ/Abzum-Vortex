import "server-only";
import { z } from "zod";
import { canonicalJson, sourceApplicationThemeSchema } from "@vortex/platform/schema";
import { materialiseApplicationTheme } from "@vortex/platform/server";
import { tokenName, type StudioApplicationConditionContextResult } from "@vortex/ui/studio";
import { findPinnedPlatformThemeRelease } from "../studio/_lib/pinned-platform-theme-release";
import type { StudioThemeResolution } from "../studio/_lib/studio-theme-options";
import { loadStudioApplicationDraft } from "./studio-application-draft";
import {
  readStudioCanvasRecords as readStudioCanvasRecordsWithSession,
  type StudioCanvasRecordsResult,
} from "./studio-canvas-records";
import {
  readStudioDataRecords as readStudioDataRecordsWithSession,
  type StudioDataRecordsResult,
} from "./studio-data-records";
import { readSavedStudioApplicationConditionContext } from "./studio-application-condition-context";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { mapWebError } from "./web-error-mapper";

const refuse = <Result>(
  operation: string,
  code: string,
  fallback: Result,
  cause?: unknown,
): Result => mapWebError(cause, { route: "studio/read", operation, code, fallback });

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

/** The saved draft compiled for the canvas: its page slots, frames, choices and compile failure. */
export async function reopenStudioApplication(organizationId: string, applicationRootId: string) {
  return loadStudioApplicationDraft(organizationId, applicationRootId);
}

/** The records the data blocks of one saved draft page area show, read with the builder's own access. */
export async function readStudioCanvasRecords(
  organizationId: string,
  candidate: unknown,
): Promise<StudioCanvasRecordsResult> {
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return resolved.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable" }
        : { kind: "refused" };
    return await readStudioCanvasRecordsWithSession(resolved.session, organizationId, candidate);
  } catch (error) {
    return refuse(
      "read-canvas-records",
      "STUDIO_CANVAS_RECORDS_FAILED",
      { kind: "temporarily_unavailable" } as const,
      error,
    );
  }
}

/** One page of the records of a record type or query in the running application, read with the builder's own access. */
export async function readStudioDataRecords(
  organizationId: string,
  candidate: unknown,
): Promise<StudioDataRecordsResult> {
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return resolved.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable" }
        : { kind: "refused" };
    return await readStudioDataRecordsWithSession(resolved.session, organizationId, candidate);
  } catch (error) {
    return refuse(
      "read-data-records",
      "STUDIO_DATA_RECORDS_FAILED",
      { kind: "temporarily_unavailable" } as const,
      error,
    );
  }
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

const themeRequestSchema = z
  .object({ rootId: z.string().min(1).max(200), theme: sourceApplicationThemeSchema })
  .strict();

/**
 * Resolves a candidate application theme with the producer publication uses, for the Theme tab's
 * check before an edit and for the canvas, which draws the draft's theme as it is edited. The
 * theme must keep the draft's pinned base release; only its selection and overrides change.
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
  const loaded = await loadStudioApplicationDraft(organizationId, request.data.rootId, {
    compile: false,
  });
  if (loaded.kind !== "available") return { kind: loaded.kind };
  const draft = loaded.draft;
  if (
    draft.rootId !== request.data.rootId ||
    canonicalJson(draft.source.body.theme.base) !== canonicalJson(request.data.theme.base)
  )
    return refuse("resolve-theme", "STUDIO_THEME_BASE_MISMATCH", { kind: "refused" } as const);
  try {
    const release = findPinnedPlatformThemeRelease(request.data.theme.base);
    if (release === undefined)
      return refuse("resolve-theme", "STUDIO_THEME_RELEASE_UNKNOWN", { kind: "refused" } as const);
    const result = materialiseApplicationTheme(request.data.theme, draft.key, release);
    if (result.valid) return { kind: "available", valid: true, theme: result.theme };
    console.error(
      `[studio] theme resolution refused: ${result.failures
        .map((failure) => `${failure.code}:${failure.tokenKey ?? ""}`)
        .slice(0, 8)
        .join(",")}`,
    );
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
