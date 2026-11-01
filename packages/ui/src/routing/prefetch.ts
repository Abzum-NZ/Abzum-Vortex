"use client";

import type { useRouter } from "next/navigation";
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";

type Router = ReturnType<typeof useRouter>;

/** Whether a page was prefetched since the client cache was last emptied. */
let prefetched = false;
/** Whether a write committed after a page was prefetched, so a prefetched page may be out of date. */
let written = false;

/**
 * Prefetches an internal page in full (its data included) when the person shows the intent to open
 * it (pointer, focus or touch), so the page change that follows uses it. The client keeps it for
 * the static stale time (next.config.ts) and only in this tab; signing in or out empties it.
 */
export const prefetchPage = (router: Router, path: string): void => {
  prefetched = true;
  router.prefetch(path, { kind: PrefetchKind.FULL });
};

/** A write committed: a page prefetched before it may show data the write changed. */
export const noteCommittedWrite = (): void => {
  if (prefetched) written = true;
};

/**
 * Runs before every in-place page change: after a write, the client cache is emptied first (the
 * router's own refresh), so no page opens with data from before the write, such as a list that
 * would miss the record just created.
 */
export const forgetPagesWrittenSince = (router: Router): void => {
  if (!written) return;
  written = false;
  prefetched = false;
  router.refresh();
};
