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
}>;

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
  return {
    read: (target: PageMessageTarget, component?: string) => values.get(keyOf(target, component)),
    key: keyOf,
    clear,
    clearAll: () => {
      for (const message of [...values.values()])
        clear(message.target, message.component, message.id);
    },
    show: (message: PageMessage) => {
      const key = keyOf(message.target, message.component);
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
    dispose: () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      values.clear();
    },
  };
}
