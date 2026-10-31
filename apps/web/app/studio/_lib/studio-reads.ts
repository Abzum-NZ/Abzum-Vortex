import { isRecord } from "@vortex/platform/schema";
import type { readStudioCanvasRecords as canvasRead } from "../../_lib/studio-canvas-records";
import type { readStudioDataRecords as dataRead } from "../../_lib/studio-data-records";
import type { loadStudioApplicationDraft } from "../../_lib/studio-application-draft";
import type { prepareStudioPreview as previewRead } from "../../_lib/studio-application-preview";
import { postJson } from "../../_lib/post-json";
import type { StudioViewRequest } from "./studio-view-request";

const read = async <Result>(
  organizationId: string,
  operation: "canvas" | "data" | "compile" | "preview",
  candidate: unknown,
  signal?: AbortSignal,
): Promise<Result> => {
  const response = await postJson<Result>(
    "/api/studio/read",
    { organizationId, operation, candidate },
    signal === undefined ? undefined : { signal },
  );
  if (response.ok) return response.body;
  const kind =
    isRecord(response.body) && typeof response.body.kind === "string"
      ? response.body.kind
      : "unreadable";
  throw new Error(`STUDIO_READ_HTTP_${response.status}_${kind}`);
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

/** Waits until the builder's preview runs a saved revision's data shape, preparing it when nothing else does. */
export const prepareStudioPreview = (
  organizationId: string,
  candidate: Readonly<{ rootId: string; draftRevision: number }>,
  signal?: AbortSignal,
) => read<Awaited<ReturnType<typeof previewRead>>>(organizationId, "preview", candidate, signal);

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
