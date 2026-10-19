import type { readStudioCanvasRecords as canvasRead } from "../../_lib/studio-canvas-records";
import type { readStudioDataRecords as dataRead } from "../../_lib/studio-data-records";
import type { loadStudioApplicationDraft } from "../../_lib/studio-application-draft";
import type { StudioViewRequest } from "./studio-view-request";

const read = async <Result>(
  organizationId: string,
  operation: "canvas" | "data" | "compile",
  candidate: unknown,
  signal?: AbortSignal,
): Promise<Result> => {
  const response = await fetch("/api/studio/read", {
    signal: signal ?? null,
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organizationId, operation, candidate }),
  });
  if (!response.ok) throw new Error(`STUDIO_READ_HTTP_${response.status}`);
  return response.json() as Promise<Result>;
};

export const readStudioCanvasRecords = (
  organizationId: string,
  candidate: unknown,
  signal?: AbortSignal,
) => read<Awaited<ReturnType<typeof canvasRead>>>(organizationId, "canvas", candidate, signal);

export const readStudioDataRecords = (
  organizationId: string,
  candidate: unknown,
  signal?: AbortSignal,
) => read<Awaited<ReturnType<typeof dataRead>>>(organizationId, "data", candidate, signal);

/** The saved draft's views for the requested editors, all projected from one compile of it. */
export const reopenStudioApplication = (
  organizationId: string,
  rootId: string,
  requests: readonly StudioViewRequest[],
  expectedDraftRevision?: number,
) =>
  read<Awaited<ReturnType<typeof loadStudioApplicationDraft>>>(organizationId, "compile", {
    rootId,
    requests,
    ...(expectedDraftRevision === undefined ? {} : { expectedDraftRevision }),
  });
