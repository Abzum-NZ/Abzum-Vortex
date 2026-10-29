"use client";

import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactElement,
  type RefObject,
  type ReactNode,
} from "react";
import type { LinkNavigationEnvironment } from "../launcher/link-navigation";
import { performNavigateTask } from "../launcher/link-navigation";
import type { ReferenceChoiceSelectionEvidenceMap } from "@vortex/platform/schema";
import type {
  FlowConfirmAnswer,
  FlowConfirmIntent,
  FlowFormAnswer,
  FlowFormIntent,
  FlowIntentHost,
  FlowMessageIntent,
} from "./intents";
import { surfaceCancellationError } from "./intents";

export type Surface =
  | Readonly<{ id: number; kind: "message"; message: FlowMessageIntent; settle: () => void }>
  | Readonly<{
      id: number;
      kind: "confirm";
      confirmation: FlowConfirmIntent;
      settle: (answer: FlowConfirmAnswer) => void;
    }>
  | Readonly<{
      id: number;
      kind: "form";
      form: FlowFormIntent;
      settle: (answer: FlowFormAnswer) => void;
    }>;

export type FlowIntentHostOptions = Readonly<{
  /**
   * Renders the form a Show form task names. Forms are Application data the shell resolves, so the
   * shell supplies its title and body and calls `submit` with the typed values or `cancel` when dismissed.
   */
  renderForm: (
    form: FlowFormIntent,
    controls: Readonly<{
      submit: (
        values: Extract<FlowFormAnswer, { kind: "submit" }>["values"],
        choiceEvidence?: ReferenceChoiceSelectionEvidenceMap,
      ) => void;
      cancel: () => void;
    }>,
  ) => Readonly<{ title: string; body: ReactNode }>;
  navigation: LinkNavigationEnvironment;
  refresh?: FlowIntentHost["refresh"];
  setPanel?: FlowIntentHost["setPanel"];
  setFilter?: FlowIntentHost["setFilter"];
}>;

/** The modal queue notifies only its own surface, keeping the page renderer independent. */
function createSurfaceQueue() {
  let surfaces: readonly Surface[] = [];
  let nextId = 0;
  const listeners = new Set<() => void>();
  const pending = new Map<number, () => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const remove = (id: number): void => {
    const before = surfaces[0];
    surfaces = surfaces.filter((entry) => entry.id !== id);
    if (before !== surfaces[0]) notify();
  };
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => surfaces[0] ?? null,
    abandon: () => {
      for (const cancel of [...pending.values()]) cancel();
      pending.clear();
    },
    enqueue: <Result,>(
      build: (id: number, settle: (result: Result) => void) => Surface,
      signal?: AbortSignal,
    ): Promise<Result> =>
      new Promise<Result>((resolve, reject) => {
        const id = (nextId += 1);
        const cancel = (reason: unknown): void => {
          if (!pending.delete(id)) return;
          signal?.removeEventListener("abort", abort);
          remove(id);
          reject(reason);
        };
        const abort = (): void => cancel(signal?.reason ?? surfaceCancellationError());
        if (signal?.aborted) {
          reject(signal.reason ?? surfaceCancellationError());
          return;
        }
        pending.set(id, () => cancel(surfaceCancellationError()));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
          return;
        }
        const surface = build(id, (result) => {
          if (!pending.delete(id)) return;
          signal?.removeEventListener("abort", abort);
          remove(id);
          resolve(result);
        });
        if (pending.has(id)) {
          const wasEmpty = surfaces.length === 0;
          surfaces = [...surfaces, surface];
          if (wasEmpty) notify();
        }
      }),
  };
}

type SurfaceQueue = ReturnType<typeof createSurfaceQueue>;

const LazyFlowSurfaceView = lazy(() => import("./flow-surface-view"));

/** Only this subtree re-renders when a flow opens or closes a surface. */
function FlowSurfaceHost({
  queue,
  optionsRef,
}: Readonly<{
  queue: SurfaceQueue;
  optionsRef: RefObject<FlowIntentHostOptions>;
}>): ReactElement | null {
  const current = useSyncExternalStore(queue.subscribe, queue.snapshot, () => null);
  return current === null ? null : (
    <Suspense fallback={null}>
      <LazyFlowSurfaceView current={current} optionsRef={optionsRef} />
    </Suspense>
  );
}

/** Presents flow intents without re-rendering the page when a surface changes. */
export function useFlowIntentHost(
  options: FlowIntentHostOptions,
): Readonly<{ host: FlowIntentHost; element: ReactElement }> {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const queue = useMemo(() => createSurfaceQueue(), []);
  useEffect(() => () => queue.abandon(), [queue]);
  const host = useMemo<FlowIntentHost>(
    () => ({
      showMessage: (message, signal) =>
        queue.enqueue<void>((id, settle) => ({ id, kind: "message", message, settle }), signal),
      showForm: (form, signal) =>
        queue.enqueue<FlowFormAnswer>((id, settle) => ({ id, kind: "form", form, settle }), signal),
      confirm: (confirmation, signal) =>
        queue.enqueue<FlowConfirmAnswer>(
          (id, settle) => ({ id, kind: "confirm", confirmation, settle }),
          signal,
        ),
      navigate: (intent) => performNavigateTask(intent, optionsRef.current.navigation),
      refresh: (component) => optionsRef.current.refresh?.(component),
      setPanel: (panel, state) => optionsRef.current.setPanel?.(panel, state),
      setFilter: (component, field, value) =>
        optionsRef.current.setFilter?.(component, field, value),
    }),
    [queue],
  );
  const element = useMemo(() => <FlowSurfaceHost queue={queue} optionsRef={optionsRef} />, [queue]);
  return { host, element };
}
