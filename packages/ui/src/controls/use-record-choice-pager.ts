"use client";

import { useEffect, useRef, useState } from "react";

/** One page of pickable records or options, as the page runtime answered its request. */
export type RecordChoicePagerPage<Item> = Readonly<{
  items: readonly Item[];
  next?: string;
}>;

/** One page read; undefined means the read failed and the picker says so. */
export type RecordChoicePagerReader<Item> = (
  search: string,
  continuationToken?: string,
) => Promise<RecordChoicePagerPage<Item> | undefined>;

export type RecordChoicePager<Item> = Readonly<{
  items: readonly Item[];
  next: string | undefined;
  loading: boolean;
  failed: boolean;
  /** Reads the next page and appends it; nothing happens while a read runs or at the last page. */
  loadMore: () => void;
  /** Forgets every page and drops an answer still on its way. */
  reset: () => void;
}>;

/** Typing rests this long before the records are searched, so a word costs one read, not one per key. */
export const RECORD_CHOICE_SEARCH_DELAY_MS = 250;

/** The server refuses longer searches; every picker bounds its request to the same count. */
export const RECORD_CHOICE_SEARCH_LIMIT = 100;

/**
 * The one paged record-choice reader shared by the link input, the choice input and the Records
 * table's link picker. It owns the debounce, the generation guard, the append-or-replace rule and
 * the loading and failure states. A read that finishes after the picker closed or the search moved
 * on is dropped. `read` is read through a ref, so a caller may pass a new closure on every render.
 */
export function useRecordChoicePager<Item>(
  options: Readonly<{
    open: boolean;
    search: string;
    read: RecordChoicePagerReader<Item>;
    disabled?: boolean;
  }>,
): RecordChoicePager<Item> {
  const { open, search, disabled = false } = options;
  const [items, setItems] = useState<readonly Item[]>([]);
  const [next, setNext] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const reader = useRef(options.read);
  reader.current = options.read;
  const bounded = search.trim().slice(0, RECORD_CHOICE_SEARCH_LIMIT);

  const readPage = (continuationToken: string | undefined, append: boolean): void => {
    const request = ++generation.current;
    setLoading(true);
    setFailed(false);
    void reader
      .current(bounded, continuationToken)
      .then((page) => {
        if (generation.current !== request) return;
        if (page === undefined) {
          setFailed(true);
          return;
        }
        setItems((held) => (append ? [...held, ...page.items] : page.items));
        setNext(page.next);
      })
      .catch((cause: unknown) => {
        if (generation.current !== request) return;
        console.error("[record-choice-pager] page unavailable", cause);
        setFailed(true);
      })
      .finally(() => {
        if (generation.current === request) setLoading(false);
      });
  };

  useEffect(() => {
    if (!open || disabled) {
      generation.current += 1;
      return;
    }
    const timeout = window.setTimeout(
      () => readPage(undefined, false),
      bounded === "" ? 0 : RECORD_CHOICE_SEARCH_DELAY_MS,
    );
    return () => {
      window.clearTimeout(timeout);
      generation.current += 1;
    };
  }, [open, disabled, bounded]);

  return {
    items,
    next,
    loading,
    failed,
    loadMore: () => {
      if (next !== undefined && !loading && !disabled) readPage(next, true);
    },
    reset: () => {
      generation.current += 1;
      setItems([]);
      setNext(undefined);
      setLoading(false);
      setFailed(false);
    },
  };
}
