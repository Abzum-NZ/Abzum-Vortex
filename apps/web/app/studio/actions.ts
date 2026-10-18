"use server";

import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  sameId,
  saveDefinitionDraftCommandSchema,
  translateDefinitionRuleFailures,
} from "@vortex/platform/schema";
import { createHumanApplicationDraftWriter, fingerprintCanonicalValue, validateDefinitionSource } from "@vortex/platform/server";
import { humanOrganizationRequests } from "../_lib/server-composition";
import { createHumanApplicationDraft, saveHumanApplicationDraft } from "../_lib/definition-draft-write";
import { mapWebError } from "../_lib/web-error-mapper";
import { loadStudioApplicationDraft } from "../_lib/studio-application-draft";
import { readStudioCanvasRecords as readStudioCanvasRecordsWithSession, type StudioCanvasRecordsResult } from "../_lib/studio-canvas-records";
import { readStudioDataRecords as readStudioDataRecordsWithSession, type StudioDataRecordsResult } from "../_lib/studio-data-records";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { prepareHumanDefinitionPublication, publishHumanDefinition } from "../_lib/definition-publication";
import {
  maximumApplicationSourceImportBytes,
  studioApplicationSourceReviewRequestSchema,
  studioApplicationSourceReviewResultSchema,
  type StudioApplicationSourceReviewResult,
} from "./_lib/application-source-import";
import { platformPermissionSource } from "../_lib/platform-permission-source";
import type { StudioStoredApplicationDraft } from "@vortex/ui/studio";
import { readStudioPersonLabel } from "../_lib/studio-person-labels";
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
 * Saves the draft and nothing else: Studio autosaves each batch of edits through this one action.
 * The draft is compiled for the canvas by the separate `reopenStudioApplication` request the
 * workspace sends once its saves are idle, so a save never waits for a compile. A save that no
 * longer extends the saved revision is refused as a conflict that names who wrote the newer
 * revision and carries it, so the workspace can say what changed.
 */
export async function saveStudioApplication(organizationId: string, candidate: unknown): Promise<StudioSaveApplicationResult> {
  const saved = await saveHumanApplicationDraft(organizationId, candidate);
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

/** The saved draft compiled for the canvas: its page slots, frames, choices and compile failure. */
export async function reopenStudioApplication(organizationId: string, applicationRootId: string) {
  return loadStudioApplicationDraft(organizationId, applicationRootId);
}

/** The records the data blocks of one saved draft page area show, read with the builder's own access. */
export async function readStudioCanvasRecords(organizationId: string, candidate: unknown): Promise<StudioCanvasRecordsResult> {
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return resolved.kind === "temporarily_unavailable" ? { kind: "temporarily_unavailable" } : { kind: "refused" };
    return await readStudioCanvasRecordsWithSession(resolved.session, organizationId, candidate);
  } catch (error) {
    return refuse("read-canvas-records", "STUDIO_CANVAS_RECORDS_FAILED", { kind: "temporarily_unavailable" } as const, error);
  }
}

/** One page of the records of a record type or query in the running application, read with the builder's own access. */
export async function readStudioDataRecords(organizationId: string, candidate: unknown): Promise<StudioDataRecordsResult> {
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return resolved.kind === "temporarily_unavailable" ? { kind: "temporarily_unavailable" } : { kind: "refused" };
    return await readStudioDataRecordsWithSession(resolved.session, organizationId, candidate);
  } catch (error) {
    return refuse("read-data-records", "STUDIO_DATA_RECORDS_FAILED", { kind: "temporarily_unavailable" } as const, error);
  }
}

