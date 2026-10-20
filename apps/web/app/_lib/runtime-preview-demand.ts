import "server-only";

import { cacheSignal } from "react";
import { runtimePreviewOf, type InstalledRuntimeContext } from "@vortex/platform/server";
import type { IdentitySession, PageDefinition } from "@vortex/platform/schema";
import {
  materializeStudioPreviewDemand,
  readStudioPreviewState,
  studioPreviewRunsDraft,
} from "./studio-application-preview";
import { studioPreviewDemand } from "./studio-preview-demand";
import { collectPlacements } from "./application-page/placement-helpers";

/** A runtime preview uses the same demand path as Studio; ordinary installed reads do no work. */
const demandRuntimePreview = async (
  session: IdentitySession,
  context: InstalledRuntimeContext,
  demand: ReturnType<typeof studioPreviewDemand>,
): Promise<boolean> => {
  const preview = runtimePreviewOf(context);
  if (preview === undefined || demand === undefined) return true;
  const signal = cacheSignal() ?? undefined;
  const state = await readStudioPreviewState(
    session,
    context.organizationId,
    context.applicationRootId,
    preview.draftRevision,
  );
  signal?.throwIfAborted();
  if (
    state.kind !== "read" ||
    state.preview === undefined ||
    state.preview.previewInstallationId !== preview.previewInstallationId ||
    studioPreviewRunsDraft(state.draft, state.preview) !== "ready"
  )
    return false;
  const result = await materializeStudioPreviewDemand(
    session,
    context.organizationId,
    context.applicationRootId,
    state.preview,
    demand,
    signal,
  );
  return result.kind === "ready";
};

export const prepareRuntimePreviewPage = (
  session: IdentitySession,
  context: InstalledRuntimeContext,
  page: PageDefinition,
  readSubject: boolean,
  projected?: Readonly<Record<string, unknown>>,
  selectedPlacementIds?: ReadonlySet<string>,
): Promise<boolean> => {
  if (runtimePreviewOf(context) === undefined) return Promise.resolve(true);
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
): Promise<boolean> => {
  if (runtimePreviewOf(context) === undefined) return Promise.resolve(true);
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
