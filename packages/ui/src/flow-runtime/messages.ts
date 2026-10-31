import type { NoticeSeverity } from "../components/notice";
import type { FormFlowFeedback } from "@vortex/platform/schema";

export type PageMessageTarget = "toast" | "banner" | "dialog" | "inline" | "slot";
export type PageMessage = Readonly<{
  id: string;
  target: PageMessageTarget;
  component?: string;
  severity: NoticeSeverity;
  text: string;
  title?: string;
  action?:
    | Readonly<{ kind: "flow"; label: string; run: () => void }>
    | Readonly<{ kind: "link"; label: string; href: string }>;
  dismissAfterMs?: number;
  refusal?: Extract<FormFlowFeedback, { kind: "refusal" }>;
  /** Optional located details for a message presented next to a grid. */
  details?: readonly string[];
  locations?: readonly Readonly<{ row: number; field?: string | undefined }>[];
}>;
export type PageMessageDraft = Omit<PageMessage, "id">;

/**
 * The toasts a page change carries to the next page: a flow that shows "Saved" or "Deleted. Undo"
 * and then opens another page must still be seen, and its Undo must still work, there.
 */
let carried: Readonly<{ at: number; toasts: readonly PageMessage[] }> | undefined;
/** A carry belongs to the page change that made it: one that has not opened by now is dropped. */
const carryLifetimeMs = 15_000;

/** Messages are slots of the page's runtime state, keyed by their presentation target. */
export function createPageMessages(notify: (key: string) => void) {
  const values = new Map<string, PageMessage>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const keyOf = (target: PageMessageTarget, component?: string) =>
    `${target}:${component?.toLowerCase() ?? ""}`;
  const clear = (target: PageMessageTarget, component?: string, id?: string) => {
    const key = keyOf(target, component);
    if (id !== undefined && values.get(key)?.id !== id) return;
    const timer = timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(key);
    if (values.delete(key)) notify(key);
  };
  const createdAt = Date.now();
  let lastToastId: string | undefined;
  let adopted: Readonly<{ at: number; toasts: readonly PageMessage[] }> | undefined;
  const api = {
    read: (target: PageMessageTarget, component?: string) => values.get(keyOf(target, component)),
    /** Every message the page shows now. */
    list: (): readonly PageMessage[] => [...values.values()],
    key: keyOf,
    clear,
    clearAll: () => {
      for (const message of [...values.values()])
        clear(message.target, message.component, message.id);
    },
    show: (message: PageMessage) => {
      const key = keyOf(message.target, message.component);
      if (message.target === "toast") lastToastId = message.id;
      const timer = timers.get(key);
      if (timer !== undefined) clearTimeout(timer);
      timers.delete(key);
      values.set(key, message);
      if (message.dismissAfterMs !== undefined)
        timers.set(
          key,
          setTimeout(
            () => clear(message.target, message.component, message.id),
            message.dismissAfterMs,
          ),
        );
      notify(key);
    },
    /**
     * Shows the toasts the page change that opened this page carried. They are taken once. The
     * address of a page settles in a moment (the record joins it), and each settling clears the
     * page's messages, so the same toasts are shown again while nothing newer has taken their place.
     */
    adoptCarried: () => {
      const now = Date.now();
      // Only the page made after the carry (by that flow's navigate step) takes it: the page the
      // flow ran on is still mounted while the address changes and must not.
      if (
        carried !== undefined &&
        carried.at <= createdAt &&
        (adopted === undefined || carried.at > adopted.at)
      ) {
        adopted = {
          at: carried.at,
          toasts: now - carried.at <= carryLifetimeMs ? carried.toasts : [],
        };
        carried = undefined;
      } else if (adopted === undefined) adopted = { at: now, toasts: [] };
      else if (adopted.toasts.at(-1)?.id !== lastToastId) return;
      for (const message of adopted.toasts) api.show(message);
    },
    /** Keeps this page's toasts for the page about to open. */
    carryToasts: () => {
      carried = {
        at: Date.now(),
        toasts: [...values.values()].filter((message) => message.target === "toast"),
      };
    },
    dispose: () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      values.clear();
    },
  };
  return api;
}
