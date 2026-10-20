"use client";

import { isRecord } from "@vortex/platform/schema";
import {
  readStudioCanvasRecords as canvas,
  readStudioDataRecords as records,
} from "./studio-reads";

/** The pending request is its reader's idle lease; aborting that reader releases it server-side. */
export const fillPreviewAfterRead = (
  organizationId: string,
  candidate: unknown,
  signal: AbortSignal,
): void => {
  if (signal.aborted || !isRecord(candidate)) return;
  void fetch("/api/studio/preview-fill", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      organizationId,
      rootId: candidate.rootId,
      draftRevision: candidate.draftRevision,
    }),
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(`STUDIO_PREVIEW_FILL_HTTP_${response.status}`);
      await response.json();
    })
    .catch((error: unknown) => {
      if (!signal.aborted) console.error("[studio] idle preview fill failed", error);
    });
};

export const readStudioCanvasRecords: typeof canvas = async (organizationId, candidate, signal) => {
  const result = await canvas(organizationId, candidate, signal);
  if (result.kind === "available" && signal !== undefined)
    fillPreviewAfterRead(organizationId, candidate, signal);
  return result;
};
export const readStudioDataRecords: typeof records = async (organizationId, candidate, signal) => {
  const result = await records(organizationId, candidate, signal);
  if ((result.kind === "available" || result.kind === "summary") && signal !== undefined)
    fillPreviewAfterRead(organizationId, candidate, signal);
  return result;
};
