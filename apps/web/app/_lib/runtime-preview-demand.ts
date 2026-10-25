import "server-only";

import { cacheSignal } from "react";
import { runtimePreviewOf, type InstalledRuntimeContext } from "@vortex/platform/server";
import {
  logRefusal,
  sameId,
  type IdentitySession,
  type PageDefinition,
} from "@vortex/platform/schema";
import {
  materializeStudioPreviewDemand,
  readStudioPreviewState,
  studioPreviewRunsDraft,
} from "./studio-application-preview";
import { studioPreviewDemand } from "./studio-preview-demand";
import { beginStudioPreviewRead } from "./studio-preview-work";
import { collectPlacements } from "./application-page/placement-helpers";

export type RuntimePreviewDemandResult = Readonly<{
  kind: "ready" | "refused" | "conflict" | "temporarily_unavailable";
}>;

/**
 * A runtime preview uses the same demand path as Studio; ordinary installed reads do no work. Every
 * runtime demand is an on-screen read, so it holds the visible-read lease that pauses idle fill.
 */
const demandRuntimePreview = async (
  session: IdentitySession,
  context: InstalledRuntimeContext,
  demand: ReturnType<typeof studioPreviewDemand>,
): Promise<RuntimePreviewDemandResult> => {
  const preview = runtimePreviewOf(context);
  if (preview === undefined || demand === undefined) return { kind: "ready" };
  const signal = cacheSignal() ?? undefined;
  const release = beginStudioPreviewRead(
    session,
    context.organizationId,
    context.applicationRootId,
  );
  const conflict = (actual: string): RuntimePreviewDemandResult => {
    // A superseded preview or revision is a stale read the client recovers from; record which.
    logRefusal(
      "runtime-preview",
      `demand organization=${context.organizationId} root=${context.applicationRootId} expected=${preview.previewInstallationId}@${preview.draftRevision} actual=${actual}`,
      "PREVIEW_RUNTIME_DEMAND_CONFLICT",
    );
    return { kind: "conflict" };
  };
  try {
    const state = await readStudioPreviewState(
      session,
      context.organizationId,
      context.applicationRootId,
      preview.draftRevision,
    );
    signal?.throwIfAborted();
    if (state.kind === "conflict") return conflict("draft_revision_stale");
    if (state.kind === "not_runnable") return { kind: "temporarily_unavailable" };
    if (state.kind !== "read") return state;
    if (state.preview === undefined) return conflict("none");
    if (
      !sameId(state.preview.previewInstallationId, preview.previewInstallationId) ||
      studioPreviewRunsDraft(state.draft, state.preview) !== "ready"
    )
      return conflict(`${state.preview.previewInstallationId}@${state.preview.draftRevision}`);
    const result = await materializeStudioPreviewDemand(
      session,
      context.organizationId,
      context.applicationRootId,
      state.preview,
      demand,
      signal,
    );
    if (result.kind === "not_runnable") return { kind: "temporarily_unavailable" };
    return result.kind === "conflict" ? conflict("materialize_superseded") : result;
  } finally {
    release();
  }
};

export const prepareRuntimePreviewPage = (
  session: IdentitySession,
  context: InstalledRuntimeContext,
  page: PageDefinition,
  readSubject: boolean,
  projected?: Readonly<Record<string, unknown>>,
  selectedPlacementIds?: ReadonlySet<string>,
): Promise<RuntimePreviewDemandResult> => {
  if (runtimePreviewOf(context) === undefined) return Promise.resolve({ kind: "ready" });
  return demandRuntimePreview(
    session,
    context,
    studioPreviewDemand(
      context.releaseSet.application.content,
      context.releaseSet.modules.map((module) => ({
        key: module.definitionKey,
        content: module.content,
      })),
      {
        kind: "placements",
        page,
        readSubject,
        placements:
          projected === undefined
            ? []
            : collectPlacements(projected).filter(
                (placement) =>
                  selectedPlacementIds === undefined ||
                  selectedPlacementIds.has(placement.placementId.toLowerCase()),
              ),
      },
    ),
  );
};

export const prepareRuntimePreviewChoices = (
  session: IdentitySession,
  context: InstalledRuntimeContext,
  recordTypeIds: readonly string[],
): Promise<RuntimePreviewDemandResult> => {
  if (runtimePreviewOf(context) === undefined) return Promise.resolve({ kind: "ready" });
  return demandRuntimePreview(
    session,
    context,
    studioPreviewDemand(
      context.releaseSet.application.content,
      context.releaseSet.modules.map((module) => ({
        key: module.definitionKey,
        content: module.content,
      })),
      { kind: "choices", recordTypeIds },
    ),
  );
};
