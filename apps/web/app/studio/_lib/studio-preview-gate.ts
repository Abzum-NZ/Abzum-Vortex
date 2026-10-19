import { describeFailure } from "@vortex/platform/schema";
import type { StudioPreviewReader } from "../../_lib/studio-preview-demand";
import { prepareStudioPreview } from "./studio-reads";

/** Why Studio's readers cannot read the preview's records of a saved revision now. */
export type StudioPreviewGateOutcome = "ready" | "conflict" | "refused" | "temporarily_unavailable";

/**
 * When the builder's preview runs a saved revision's data shape, so Studio's canvas and Data tab
 * read that revision's records once each instead of reading again until the preview has moved.
 * A presentation edit keeps the shape the preview already runs and is ready at once; a data-shape
 * edit waits on one readiness request shared by every visible reader of that revision. The
 * request is cancelled when its last reader leaves.
 */
export type StudioPreviewGate = Readonly<{
  /** `unknown` until a readiness answer or a read of the preview's records says which shape it runs. */
  runs: (previewShape: string, reader: StudioPreviewReader) => "ready" | "other" | "unknown";
  whenReady: (
    draftRevision: number,
    previewShape: string,
    reader: StudioPreviewReader,
    signal?: AbortSignal,
  ) => Promise<StudioPreviewGateOutcome>;
  /** A read found the preview not running a shape the gate took as ready: the next reader asks again. */
  forget: (previewShape: string) => void;
}>;

/** How many readiness answers of `following` one wait takes before it reports the preview unavailable. */
const maximumFollowing = 5;

type Waiting = {
  draftRevision: number;
  controller: AbortController;
  readers: number;
  outcome: Promise<StudioPreviewGateOutcome>;
};

export const createStudioPreviewGate = (
  organizationId: string,
  rootId: string,
): StudioPreviewGate => {
  let readyShape: string | undefined;
  let readyTypes = new Set<string>();
  const demands = new Map<string, readonly string[]>();
  const waiting = new Map<string, Waiting>();
  const keyOf = (reader: StudioPreviewReader) =>
    JSON.stringify(
      reader.kind === "canvas" ? { ...reader, areas: [...new Set(reader.areas)].sort() } : reader,
    );
  const runs = (shape: string, reader: StudioPreviewReader) => {
    const required = demands.get(keyOf(reader));
    return readyShape === undefined || required === undefined
      ? ("unknown" as const)
      : readyShape === shape && required.every((id) => readyTypes.has(id))
        ? ("ready" as const)
        : ("other" as const);
  };

  const ask = async (
    draftRevision: number,
    reader: StudioPreviewReader,
    signal: AbortSignal,
  ): Promise<StudioPreviewGateOutcome> => {
    for (let attempt = 0; attempt < maximumFollowing; attempt += 1) {
      const answer = await prepareStudioPreview(
        organizationId,
        { rootId, draftRevision, reader },
        signal,
      );
      if (answer.kind === "ready") {
        if (readyShape !== answer.previewShape) demands.clear();
        readyShape = answer.previewShape;
        readyTypes = new Set(answer.readyRecordTypeIds);
        demands.set(keyOf(reader), answer.requiredRecordTypeIds);
        return "ready";
      }
      if (answer.kind === "following") continue;
      if (answer.kind === "conflict") return "conflict";
      if (answer.kind === "refused") return "refused";
      console.error(
        `[studio] the preview is not ready: STUDIO_PREVIEW_${answer.kind.toUpperCase()}`,
      );
      return "temporarily_unavailable";
    }
    console.error(
      "[studio] the preview did not reach the saved revision: STUDIO_PREVIEW_FOLLOWING",
    );
    return "temporarily_unavailable";
  };

  const whenReady = async (
    draftRevision: number,
    previewShape: string,
    reader: StudioPreviewReader,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    if (runs(previewShape, reader) === "ready") return "ready" as const;
    const key = `${draftRevision}|${keyOf(reader)}`;
    let current = waiting.get(key);
    if (
      current === undefined ||
      current.draftRevision !== draftRevision ||
      current.controller.signal.aborted
    ) {
      const controller = new AbortController();
      const started: Waiting = {
        draftRevision,
        controller,
        readers: 0,
        outcome: ask(draftRevision, reader, controller.signal)
          .catch((error: unknown) => {
            if (!controller.signal.aborted)
              console.error(
                "[studio] the preview readiness request failed",
                describeFailure(error),
              );
            return "temporarily_unavailable" as const;
          })
          .finally(() => {
            if (waiting.get(key) === started) waiting.delete(key);
          }),
      };
      waiting.set(key, started);
      current = started;
    }
    const joined = current;
    joined.readers += 1;
    let leave: (() => void) | undefined;
    const left = new Promise<never>((_, reject) => {
      leave = () => reject(signal?.reason);
      signal?.addEventListener("abort", leave, { once: true });
    });
    try {
      return await Promise.race([joined.outcome, left]);
    } finally {
      if (leave !== undefined) signal?.removeEventListener("abort", leave);
      joined.readers -= 1;
      // Several visible areas wait on one request; only the last one leaving cancels it.
      if (joined.readers === 0) joined.controller.abort();
    }
  };

  return {
    runs,
    whenReady,
    forget: (previewShape) => {
      if (readyShape === previewShape) readyShape = undefined;
    },
  };
};

/** Read only after this visible demand has been prepared, retrying once if the server invalidates it. */
export const readWhenPreviewReady = async <Result extends Readonly<{ kind: string }>>(
  gate: StudioPreviewGate,
  draftRevision: number,
  previewShape: string,
  reader: StudioPreviewReader,
  signal: AbortSignal | undefined,
  read: () => Promise<Result>,
): Promise<Result | Readonly<{ kind: Exclude<StudioPreviewGateOutcome, "ready"> }>> => {
  const ready = await gate.whenReady(draftRevision, previewShape, reader, signal);
  if (ready !== "ready") return { kind: ready };
  const result = await read();
  if (result.kind !== "following") return result;
  gate.forget(previewShape);
  const again = await gate.whenReady(draftRevision, previewShape, reader, signal);
  return again === "ready" ? read() : { kind: again };
};
