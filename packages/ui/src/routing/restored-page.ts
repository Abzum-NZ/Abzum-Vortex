"use client";

import { useEffect, useRef } from "react";

/** When Back or Forward last moved through history in this document. */
let lastTraversal = Number.NEGATIVE_INFINITY;
if (typeof window !== "undefined")
  window.addEventListener("popstate", () => {
    lastTraversal = performance.now();
  });

/** A page that mounts this soon after Back or Forward is the page they restored. */
const RESTORE_WINDOW_MS = 2_000;

/**
 * Back and Forward restore a page as it was read, and the person's access or the installed release
 * may have changed since. A page that mounts because history restored it calls `reread` once, to
 * read again only what it shows; a change of query within a page that stays mounted is not a
 * restore (the page's own address handling reads that).
 */
export function useRestoredPage(reread: () => void): void {
  const rereadRef = useRef(reread);
  rereadRef.current = reread;
  useEffect(() => {
    if (performance.now() - lastTraversal >= RESTORE_WINDOW_MS) return;
    // Only the page history restored rereads, not one opened soon after it.
    lastTraversal = Number.NEGATIVE_INFINITY;
    rereadRef.current();
  }, []);
}
