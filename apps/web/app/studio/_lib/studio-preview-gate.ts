import { describeFailure } from "@vortex/platform/schema";
import type { StudioPreviewNotRunnable } from "@vortex/ui/studio";
import { prepareStudioPreview } from "./studio-reads";

/** Why Studio's readers cannot read the preview's records of a saved revision now. */
type StudioPreviewGateOutcome = Readonly<{ kind: "ready" }> | StudioPreviewNotReady;

/** Why a reader cannot read the preview's records now. */
type StudioPreviewNotReady =
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>
  /** The saved draft has a problem to fix before its preview can run. */
  | StudioPreviewNotRunnable;

/**
 * When the builder's preview runs a saved revision's data shape, so Studio's canvas and Data tab
 * read that revision's records once each instead of reading again until the preview has moved.
 * A presentation edit keeps the shape the preview already runs and is ready at once; a data-shape
 * edit waits on one readiness request shared by every visible reader of that revision. The
 * request is cancelled when its last reader leaves.
 */
export type StudioPreviewGate = Readonly<{
  /** `unknown` until a readiness answer or a read of the preview's records says which shape it runs. */
  runs: (previewShape: string) => "ready" | "other" | "unknown";
  whenReady: (
    draftRevision: number,
    previewShape: string,
    signal?: AbortSignal,
  ) => Promise<StudioPreviewGateOutcome>;
  /** A read of the preview's records at this shape succeeded, so the preview runs it. */
  learn: (previewShape: string) => void;
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
  let waiting: Waiting | undefined;

  const ask = async (
    draftRevision: number,
    signal: AbortSignal,
  ): Promise<StudioPreviewGateOutcome> => {
    for (let attempt = 0; attempt < maximumFollowing; attempt += 1) {
      const answer = await prepareStudioPreview(organizationId, { rootId, draftRevision }, signal);
      if (answer.kind === "ready") {
        readyShape = answer.previewShape;
        return { kind: "ready" };
      }
      if (answer.kind === "following") continue;
      if (answer.kind === "conflict") return { kind: "conflict" };
      if (answer.kind === "refused") return { kind: "refused" };
      if (answer.kind === "not_runnable") return answer;
      console.error(
        `[studio] the preview is not ready: STUDIO_PREVIEW_${answer.kind.toUpperCase()}`,
      );
      return { kind: "temporarily_unavailable" };
    }
    console.error(
      "[studio] the preview did not reach the saved revision: STUDIO_PREVIEW_FOLLOWING",
    );
    return { kind: "temporarily_unavailable" };
  };

  const whenReady = async (draftRevision: number, previewShape: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (readyShape === previewShape) return { kind: "ready" } as const;
    let current = waiting;
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
        outcome: ask(draftRevision, controller.signal)
          .catch((error: unknown) => {
            if (!controller.signal.aborted)
              console.error(
                "[studio] the preview readiness request failed",
                describeFailure(error),
              );
            return { kind: "temporarily_unavailable" } as const;
          })
          .finally(() => {
            if (waiting === started) waiting = undefined;
          }),
      };
      waiting = started;
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
    runs: (previewShape) =>
      readyShape === undefined ? "unknown" : readyShape === previewShape ? "ready" : "other",
    whenReady,
    learn: (previewShape) => {
      readyShape = previewShape;
    },
    forget: (previewShape) => {
      if (readyShape === previewShape) readyShape = undefined;
    },
  };
};

/** Read outcomes that say nothing about which shape the preview runs. */
const uninformative: ReadonlySet<string> = new Set([
  "following",
  "conflict",
  "refused",
  "temporarily_unavailable",
  "not_runnable",
]);

/**
 * One read of the preview's records of a saved revision, sent once the preview runs its data
 * shape: at once when it does or when the gate does not know yet, after the one shared readiness
 * request when it runs another shape. A read that finds the preview not running the shape waits
 * for it once and reads again; it is never re-sent on a timer.
 */
export const readWhenPreviewReady = async <Result extends Readonly<{ kind: string }>>(
  gate: StudioPreviewGate,
  draftRevision: number,
  previewShape: string,
  signal: AbortSignal | undefined,
  read: () => Promise<Result>,
): Promise<Result | StudioPreviewNotReady> => {
  const readAndLearn = async () => {
    const result = await read();
    if (!uninformative.has(result.kind)) gate.learn(previewShape);
    return result;
  };
  if (gate.runs(previewShape) !== "other") {
    const result = await readAndLearn();
    if (result.kind !== "following") return result;
    gate.forget(previewShape);
  }
  const ready = await gate.whenReady(draftRevision, previewShape, signal);
  return ready.kind === "ready" ? readAndLearn() : ready;
};
