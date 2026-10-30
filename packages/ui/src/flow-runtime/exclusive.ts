import type { ComponentFlowBinding } from "@vortex/platform/schema";

type Scope = Readonly<{
  exclusive: ComponentFlowBinding["settings"]["exclusive"];
  formId?: string;
  name: string;
  allowed?: ReadonlySet<object>;
}>;

/** The active exclusive runs on a page, shared by page and agent dispatches. */
export function createExclusiveScopes() {
  const active = new Set<Scope>();
  const listeners = new Set<() => void>();
  const conflicts = (next: Scope, job?: object) =>
    [...active].find(
      (held) =>
        !held.allowed?.has(job ?? {}) &&
        (held.exclusive === "page" ||
          next.exclusive === "page" ||
          (held.formId !== undefined &&
            next.formId !== undefined &&
            held.formId.toLowerCase() === next.formId.toLowerCase())),
    );
  return {
    conflict: conflicts,
    acquire: (scope: Scope) => {
      if (scope.exclusive === "none") return () => {};
      active.add(scope);
      return () => {
        if (!active.delete(scope)) return;
        for (const notify of [...listeners]) notify();
      };
    },
    wait: (signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const done = () => {
          listeners.delete(done);
          signal.removeEventListener("abort", done);
          resolve();
        };
        if (signal.aborted) return done();
        listeners.add(done);
        signal.addEventListener("abort", done, { once: true });
      }),
  };
}
