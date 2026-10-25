import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";

/** How a change joins the browser history: a new entry (Back returns to it) or in place. */
export type AddressEntry = "push" | "replace";

/**
 * The address of the page on screen, held in memory: the one owner of every table's query state
 * (sort, filters, search, page position, saved view, grouping, open group, pivot) and of the page
 * parameters that controls publish. A gesture changes it at once, so a second gesture made before
 * the first one's read lands builds on the first and never on an older address. `write` is the
 * only code that changes the browser history; the location is read only when a page loads and on
 * Back or Forward (`load`), and listeners registered with `onLoad` hear exactly those reads.
 */
export type PageAddress = Readonly<{
  search: () => string;
  subscribe: (listener: () => void) => () => void;
  write: (change: (parameters: URLSearchParams) => void, entry: AddressEntry) => boolean;
  load: (search: string) => void;
  onLoad: (listener: (previous: string) => void) => () => void;
}>;

const normalized = (search: string): string => new URLSearchParams(search).toString();

const createPageAddress = (initial: string): PageAddress => {
  let current = normalized(initial);
  const listeners = new Set<() => void>();
  const loadListeners = new Set<(previous: string) => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    search: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    write: (change, entry) => {
      const parameters = new URLSearchParams(current);
      change(parameters);
      const next = parameters.toString();
      if (next === current) return false;
      current = next;
      const url = next === "" ? window.location.pathname : `?${next}`;
      if (entry === "push") window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
      notify();
      return true;
    },
    load: (search) => {
      const next = normalized(search);
      if (next === current) return;
      const previous = current;
      current = next;
      notify();
      for (const listener of loadListeners) listener(previous);
    },
    onLoad: (listener) => {
      loadListeners.add(listener);
      return () => loadListeners.delete(listener);
    },
  };
};

/**
 * The page address for one page view. It starts from the address the page was rendered for; a new
 * server model (a navigation or refresh rendered on the server) and Back or Forward read the
 * location again. Returns the store and its current search, which re-renders the page on change.
 */
export function usePageAddress({
  model,
  served,
}: Readonly<{ model: ApplicationPageModel; served: string }>) {
  const [address] = useState(() => createPageAddress(served));
  // A server model was rendered for the location it was requested with.
  useLayoutEffect(() => {
    address.load(window.location.search);
  }, [address, model]);
  useEffect(() => {
    const back = (): void => address.load(window.location.search);
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, [address]);
  const search = useSyncExternalStore(address.subscribe, address.search, address.search);
  return { address, currentSearch: search };
}
