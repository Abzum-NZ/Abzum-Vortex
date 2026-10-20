"use client";

import { isRecord } from "@vortex/platform/schema";
import {
  readStudioCanvasRecords as canvas,
  readStudioDataRecords as records,
} from "./studio-reads";

type Lease = { readers: number; controller: AbortController };
// One idle lease per preview revision in this tab, shared by every reader that still shows it.
const leases = new Map<string, Lease>();

/** The pending request is the tab's idle lease; the last of its readers to leave releases it. */
export const fillPreviewAfterRead = (
  organizationId: string,
  candidate: unknown,
  previewInstallationId: string,
  signal: AbortSignal,
): void => {
  if (signal.aborted || !isRecord(candidate)) return;
  const { rootId, draftRevision } = candidate;
  if (typeof rootId !== "string" || typeof draftRevision !== "number") return;
  const key = `${organizationId}|${rootId}|${draftRevision}|${previewInstallationId}`.toLowerCase();
  let lease = leases.get(key);
  if (lease === undefined) {
    const started: Lease = { readers: 0, controller: new AbortController() };
    lease = started;
    leases.set(key, started);
    void fetch("/api/studio/preview-fill", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal: started.controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId, rootId, draftRevision, previewInstallationId }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`STUDIO_PREVIEW_FILL_HTTP_${response.status}`);
        const result: unknown = await response.json();
        const kind = isRecord(result) ? result.kind : undefined;
        if (kind !== "ready") console.warn("[studio] idle preview fill ended", { kind });
      })
      .catch((error: unknown) => {
        if (!started.controller.signal.aborted)
          console.error("[studio] idle preview fill failed", error);
      })
      .finally(() => {
        if (leases.get(key) === started) leases.delete(key);
      });
  }
  const joined = lease;
  joined.readers += 1;
  signal.addEventListener(
    "abort",
    () => {
      joined.readers -= 1;
      if (joined.readers !== 0) return;
      if (leases.get(key) === joined) leases.delete(key);
      joined.controller.abort();
    },
    { once: true },
  );
};

export const readStudioCanvasRecords: typeof canvas = async (organizationId, candidate, signal) => {
  const result = await canvas(organizationId, candidate, signal);
  if (result.kind === "available" && signal !== undefined)
    fillPreviewAfterRead(organizationId, candidate, result.previewInstallationId, signal);
  return result;
};
export const readStudioDataRecords: typeof records = async (organizationId, candidate, signal) => {
  const result = await records(organizationId, candidate, signal);
  if ((result.kind === "available" || result.kind === "summary") && signal !== undefined)
    fillPreviewAfterRead(organizationId, candidate, result.previewInstallationId, signal);
  return result;
};
