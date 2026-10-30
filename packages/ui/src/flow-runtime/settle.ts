type Change = Readonly<{
  formId: string;
  job: object;
  fieldName: string;
  finished: Promise<unknown>;
  flush: () => void;
  cancel: () => void;
}>;

/** Tracks pending and running field work so a submit sees even a debounced change. */
export function createFormSettler() {
  const changes = new Set<Change>();
  return {
    pending: (formId: string) =>
      [...changes].filter((change) => change.formId.toLowerCase() === formId.toLowerCase()),
    track: (change: Change) => {
      changes.add(change);
      void change.finished.then(
        () => changes.delete(change),
        () => changes.delete(change),
      );
    },
    settle: async (
      pending: readonly Change[],
      signal: AbortSignal,
    ): Promise<string | undefined> => {
      const deadline = Date.now() + 2_000;
      while (!signal.aborted) {
        const current = pending.filter((change) => changes.has(change));
        if (current.length === 0) return undefined;
        for (const change of current) change.flush();
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          for (const change of current) change.cancel();
          return current[0]?.fieldName;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        await Promise.race([
          Promise.allSettled(current.map((change) => change.finished)),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, remaining);
            onAbort = () => resolve();
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      }
      return undefined;
    },
  };
}
