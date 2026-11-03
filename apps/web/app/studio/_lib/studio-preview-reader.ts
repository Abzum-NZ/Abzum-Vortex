"use client";

import { isRecord } from "@vortex/platform/schema";
import { postJson } from "../../_lib/post-json";
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
    void postJson(
      "/api/studio/preview-fill",
      { organizationId, rootId, draftRevision, previewInstallationId },
      { signal: started.controller.signal },
    )
      .then((response) => {
        // A session that ended (401) is an expected refusal. A 403 is the route's own-site check
        // (the site address does not match the configured one): a platform fault, logged below.
        if (response.status === 401) {
          console.info("[studio] idle preview fill refused", { status: 401 });
          return;
        }
        if (!response.ok) throw new Error(`STUDIO_PREVIEW_FILL_HTTP_${response.status}`);
        const kind = isRecord(response.body) ? response.body.kind : undefined;
        // `ready` is success and says nothing. A refusal (the builder's role changed), the preview
        // following a newer revision, a save that superseded the fill and a draft that cannot run
        // yet (its own problem is already shown to the person) are expected: each logs once at
        // info. Any other outcome is a platform fault, logged once at error for the one lease.
        if (kind === "ready") return;
        if (
          kind === "refused" ||
          kind === "following" ||
          kind === "conflict" ||
          kind === "not_runnable"
        )
          console.info("[studio] idle preview fill ended", { kind });
        else console.error("[studio] idle preview fill ended unexpectedly", { kind });
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
