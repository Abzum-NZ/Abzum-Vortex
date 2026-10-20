"use client";
import { useEffect } from "react";

const idleTimeoutMs = 3000;

/**
 * Loads a deferred editor on pointer or keyboard intent, when the browser is idle. Leaving the
 * target or workspace cancels queued work. A visible editor still owns its normal dynamic import;
 * this only brings forward the next likely action's code, never its data.
 */
export function useIdlePreload(load: () => Promise<unknown>, selector: string): void {
  useEffect(() => {
    let idle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let target: Element | null = null;
    let requested = false;
    const cancel = () => {
      if (idle !== undefined) window.cancelIdleCallback(idle);
      if (timer !== undefined) clearTimeout(timer);
      idle = undefined;
      timer = undefined;
      target = null;
    };
    const run = () => {
      idle = undefined;
      timer = undefined;
      const intended = target;
      target = null;
      if (intended === null || !intended.isConnected) return;
      requested = true;
      load().catch((error: unknown) => {
        requested = false;
        console.error("[studio] preloading an editor failed", error);
      });
    };
    const enter = (event: Event) => {
      if (requested || !(event.target instanceof Element)) return;
      const intended = event.target.closest(selector);
      if (intended === null || intended === target) return;
      cancel();
      target = intended;
      if (typeof window.requestIdleCallback === "function")
        idle = window.requestIdleCallback(run, { timeout: idleTimeoutMs });
      else timer = setTimeout(run, 1000);
    };
    const leave = (event: FocusEvent | PointerEvent) => {
      if (target === null || !(event.target instanceof Node) || !target.contains(event.target))
        return;
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
      cancel();
    };
    document.addEventListener("pointerover", enter, true);
    document.addEventListener("focusin", enter, true);
    document.addEventListener("pointerout", leave, true);
    document.addEventListener("focusout", leave, true);
    return () => {
      cancel();
      document.removeEventListener("pointerover", enter, true);
      document.removeEventListener("focusin", enter, true);
      document.removeEventListener("pointerout", leave, true);
      document.removeEventListener("focusout", leave, true);
    };
  }, [load, selector]);
}
