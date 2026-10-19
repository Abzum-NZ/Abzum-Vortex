"use client";
import { useEffect } from "react";

const idleTimeoutMs = 3000;

/**
 * Loads the code of a deferred editor once the browser is idle after the workspace has painted, so
 * the first switch to its tab does not wait for the download. It never reads data.
 */
export function useIdlePreload(load: () => Promise<unknown>): void {
  useEffect(() => {
    const run = () => {
      load().catch((error: unknown) => {
        console.error("[studio] preloading an editor failed", error);
      });
    };
    if (typeof window.requestIdleCallback !== "function") {
      const timer = setTimeout(run, 1000);
      return () => clearTimeout(timer);
    }
    const handle = window.requestIdleCallback(run, { timeout: idleTimeoutMs });
    return () => window.cancelIdleCallback(handle);
  }, [load]);
}
