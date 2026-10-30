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
  const waiting: { scope: Scope; job: object }[] = [];
  const overlaps = (held: Scope, next: Scope) =>
    held.exclusive === "page" ||
    next.exclusive === "page" ||
    (held.formId !== undefined &&
      next.formId !== undefined &&
      held.formId.toLowerCase() === next.formId.toLowerCase());
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const conflicts = (next: Scope, job?: object) =>
    [...active].find(
      (held) => !(job !== undefined && held.allowed?.has(job)) && overlaps(held, next),
    );
  return {
    conflict: conflicts,
    enqueue: (scope: Scope, job: object) => {
      const ticket = { scope, job };
      waiting.push(ticket);
      return {
        turn: () => {
          const index = waiting.indexOf(ticket);
          return (
            index >= 0 && !waiting.slice(0, index).some((earlier) => overlaps(earlier.scope, scope))
          );
        },
        remove: () => {
          const index = waiting.indexOf(ticket);
          if (index < 0) return;
          waiting.splice(index, 1);
          notify();
        },
      };
    },
    acquire: (scope: Scope) => {
      if (scope.exclusive === "none") return () => {};
      active.add(scope);
      return () => {
        if (!active.delete(scope)) return;
        notify();
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
