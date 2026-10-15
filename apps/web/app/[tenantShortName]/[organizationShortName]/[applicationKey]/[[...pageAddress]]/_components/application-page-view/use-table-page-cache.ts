import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type {
  ApplicationPageModel,
  ApplicationPagePlacementReadResult,
  PageDataState,
} from "../../../../../../_lib/application-page";
import { rereadApplicationPlacements } from "../../placement-refresh-action";
import { tablePayloadFor } from "./placement-helpers";
import type { TableContinuationTarget } from "./types";

const MAX_PAGES_PER_LIST = 5;
const PAGE_LIFETIME_MS = 60_000;
const IDLE_TIMEOUT_MS = 2_000;

type Available = Extract<ApplicationPagePlacementReadResult, { kind: "available" }>;
type TableRequest = TableContinuationTarget["request"];
type TablePayload = NonNullable<ReturnType<typeof tablePayloadFor>>;

/** The request a click on First sends. */
const FIRST_REQUEST: TableRequest = { page: 1, pageDirection: "forward" };
/** The request a click on Last sends. */
const LAST_REQUEST: TableRequest = { page: 2, pageDirection: "backward" };

const requestKeyOf = (request: TableRequest): string =>
  `${request.pageDirection}\u0000${request.page}\u0000${request.continuationToken ?? ""}`;

type CachedPage = Readonly<{ result: Available; at: number }>;

type PageScope = {
  key: string;
  startedAt: number;
  /** Pages read, by list then by the request that fetches them. */
  pages: Map<string, Map<string, CachedPage>>;
  /** One background read at a time per list; a click on the same page waits for it. */
  inFlight: Map<string, Readonly<{ requestKey: string; read: Promise<CachedPage | undefined> }>>;
  /** Bumped by every invalidation of a list, so an older read is dropped when it lands. */
  epochs: Map<string, number>;
  /** The page each list shows and when it was read; the page left is kept under its reverse request. */
  shown: Map<string, number>;
  leaving: Map<string, Readonly<{ requestKey: string; state: PageDataState; table: TablePayload }>>;
  /** Next-page reads already tried for the page shown, so a refusal is not retried in a loop. */
  attempted: Set<string>;
};

type CacheContext = Readonly<{
  navigationKey: string;
  application: ApplicationPageModel["invocation"];
  pageKey: string | undefined;
  search: string;
}>;

type ConnectionInformation = Readonly<{ saveData?: boolean; effectiveType?: string }>;

/** True when the browser, the connection or the tab says background reads should not run. */
const backgroundReadsAllowed = (): boolean => {
  if (typeof document === "undefined" || document.visibilityState !== "visible") return false;
  const connection = (navigator as Navigator & { connection?: ConnectionInformation }).connection;
  if (connection?.saveData === true) return false;
  return connection?.effectiveType !== "2g" && connection?.effectiveType !== "slow-2g";
};

const newScope = (key: string): PageScope => ({
  key,
  startedAt: Date.now(),
  pages: new Map(),
  inFlight: new Map(),
  epochs: new Map(),
  shown: new Map(),
  leaving: new Map(),
  attempted: new Set(),
});

const listKeyOf = (placementId: string): string => placementId.toLowerCase();

/**
 * Keeps the pages of each table the person has seen or is about to ask for, in memory only. A page
 * is the answer to one request (direction and sealed continuation token), so a page served from
 * here is the page the same click would fetch. Nothing is kept across a navigation, a sort, filter
 * or search change, a release change, or a reread of the list's own records.
 */
export function useTablePageCache({ navigationKey, application, pageKey, search }: CacheContext) {
  const contextRef = useRef<CacheContext>({ navigationKey, application, pageKey, search });
  contextRef.current = { navigationKey, application, pageKey, search };
  const scopeRef = useRef<PageScope>(newScope(navigationKey));
  const cacheRef = useRef<ReturnType<typeof createCache> | undefined>(undefined);
  cacheRef.current ??= createCache(contextRef, scopeRef);
  return cacheRef.current;
}

function createCache(contextRef: RefObject<CacheContext>, scopeRef: RefObject<PageScope>) {
  const scope = (): PageScope => {
    const key = contextRef.current.navigationKey;
    if (scopeRef.current.key !== key) scopeRef.current = newScope(key);
    return scopeRef.current;
  };

  const fresh = (entry: CachedPage): boolean => Date.now() - entry.at < PAGE_LIFETIME_MS;

  const store = (
    current: PageScope,
    placementId: string,
    request: TableRequest,
    entry: CachedPage,
  ): void => {
    const list = listKeyOf(placementId);
    const held = current.pages.get(list) ?? new Map<string, CachedPage>();
    current.pages.set(list, held);
    const key = requestKeyOf(request);
    held.delete(key);
    held.set(key, entry);
    for (const [heldKey, heldEntry] of held) if (!fresh(heldEntry)) held.delete(heldKey);
    while (held.size > MAX_PAGES_PER_LIST) {
      const oldest = held.keys().next();
      if (oldest.done === true) break;
      held.delete(oldest.value);
    }
  };

  const stateOf = (result: Available, placementId: string): PageDataState | undefined =>
    Object.entries(result.data).find(
      ([candidate]) => candidate.toLowerCase() === placementId.toLowerCase(),
    )?.[1];

  const fetchPage = async (
    current: PageScope,
    placementId: string,
    request: TableRequest,
  ): Promise<CachedPage | undefined> => {
    const context = contextRef.current;
    if (context.pageKey === undefined) return undefined;
    const list = listKeyOf(placementId);
    const epoch = current.epochs.get(list) ?? 0;
    const startedAt = Date.now();
    let result: Awaited<ReturnType<typeof rereadApplicationPlacements>>;
    try {
      result = await rereadApplicationPlacements(
        {
          tenantShortName: context.application.tenantShortName,
          organizationShortName: context.application.organizationShortName,
          applicationKey: context.application.applicationKey,
          pageKey: context.pageKey,
          installationRevision: context.application.installationRevision,
          search: context.search,
        },
        [placementId],
        undefined,
        { placementId, request },
      );
    } catch (error) {
      console.error("[page] table page prefetch failed", error);
      return undefined;
    }
    if (
      scopeRef.current !== current ||
      (current.epochs.get(list) ?? 0) !== epoch ||
      result.kind !== "available"
    )
      return undefined;
    const state = stateOf(result, placementId);
    if (state === undefined || tablePayloadFor(state) === undefined) return undefined;
    const entry = { result, at: startedAt };
    store(current, placementId, request, entry);
    return entry;
  };

  /** Reads one page in the background; at most one at a time per list. True when it started. */
  const prefetch = (placementId: string, request: TableRequest): boolean => {
    if (!backgroundReadsAllowed()) return false;
    const current = scope();
    const list = listKeyOf(placementId);
    const key = requestKeyOf(request);
    const held = current.pages.get(list)?.get(key);
    if ((held !== undefined && fresh(held)) || current.inFlight.has(list)) return false;
    const read: Promise<CachedPage | undefined> = fetchPage(current, placementId, request).finally(
      () => {
        if (current.inFlight.get(list)?.read === read) current.inFlight.delete(list);
      },
    );
    current.inFlight.set(list, { requestKey: key, read });
    return true;
  };

  return {
    /**
     * The page the request names when it is held and fresh, or when a background read of that very
     * page is already running (the click joins it instead of sending a second request).
     */
    async take(placementId: string, request: TableRequest): Promise<CachedPage | undefined> {
      const current = scope();
      const list = listKeyOf(placementId);
      const key = requestKeyOf(request);
      const held = current.pages.get(list)?.get(key);
      if (held !== undefined && fresh(held)) return held;
      if (held !== undefined) current.pages.get(list)?.delete(key);
      const running = current.inFlight.get(list);
      if (running?.requestKey !== key) return undefined;
      const landed = await running.read;
      return landed !== undefined && fresh(landed) && scopeRef.current === current
        ? landed
        : undefined;
    },

    prefetch,

    /** Reads the table's next page once per page shown, so a refused read is not retried in a loop. */
    prefetchNext(placementId: string, table: TablePayload): void {
      if (table.hasNextPage !== true || table.nextContinuationToken === undefined) return;
      const request: TableRequest = {
        page: 2,
        pageDirection: "forward",
        continuationToken: table.nextContinuationToken,
      };
      const claim = `${listKeyOf(placementId)}\u0000${requestKeyOf(request)}`;
      const current = scope();
      if (current.attempted.has(claim)) return;
      if (prefetch(placementId, request)) current.attempted.add(claim);
    },

    /** Remembers the page a click is about to leave, to serve the matching Previous or Next. */
    leave(placementId: string, request: TableRequest, state: PageDataState): void {
      const table = tablePayloadFor(state);
      if (table === undefined) return;
      scope().leaving.set(listKeyOf(placementId), {
        requestKey: requestKeyOf(request),
        state,
        table,
      });
    },

    /**
     * Records a page the list now shows. A page read for a click is kept under its own request, a
     * page one is kept as First, and the page left is kept under the request that leads back to it.
     */
    settle(target: TableContinuationTarget, result: Available, servedFrom: CachedPage | undefined) {
      const current = scope();
      const list = listKeyOf(target.placementId);
      const state = stateOf(result, target.placementId);
      const table = state === undefined ? undefined : tablePayloadFor(state);
      const leaving = current.leaving.get(list);
      current.leaving.delete(list);
      if (state === undefined || table === undefined) return;
      const readAt = servedFrom?.at ?? Date.now();
      const shownAt = current.shown.get(list) ?? current.startedAt;
      current.shown.set(list, readAt);
      if (servedFrom === undefined)
        store(current, target.placementId, target.request, { result, at: readAt });
      if (table.page === 1)
        store(current, target.placementId, FIRST_REQUEST, { result, at: readAt });
      if (leaving === undefined || leaving.requestKey !== requestKeyOf(target.request)) return;
      const leftResult: Available = {
        ...result,
        data: Object.fromEntries(
          Object.entries(result.data).map(([key, value]) => [
            key,
            key.toLowerCase() === list ? leaving.state : value,
          ]),
        ),
      };
      const left = { result: leftResult, at: shownAt };
      if (leaving.table.page === 1) store(current, target.placementId, FIRST_REQUEST, left);
      if (target.request.pageDirection === "forward" && target.request.page > 1) {
        if (table.previousContinuationToken !== undefined)
          store(
            current,
            target.placementId,
            {
              page: 2,
              pageDirection: "backward",
              continuationToken: table.previousContinuationToken,
            },
            left,
          );
      } else if (target.request.continuationToken !== undefined) {
        if (table.nextContinuationToken !== undefined)
          store(
            current,
            target.placementId,
            {
              page: 2,
              pageDirection: "forward",
              continuationToken: table.nextContinuationToken,
            },
            left,
          );
      }
    },

    /** Forgets every page of the lists and ignores a read of theirs still running. */
    invalidate(placementIds: readonly string[]): void {
      const current = scope();
      for (const placementId of placementIds) {
        const list = listKeyOf(placementId);
        current.pages.delete(list);
        current.leaving.delete(list);
        current.shown.delete(list);
        current.inFlight.delete(list);
        current.epochs.set(list, (current.epochs.get(list) ?? 0) + 1);
        for (const claim of [...current.attempted])
          if (claim.startsWith(`${list}\u0000`)) current.attempted.delete(claim);
      }
    },

    /** The page-one and last-page requests a hover or focus on First or Last asks for. */
    intentRequest(direction: "first" | "last"): TableRequest {
      return direction === "first" ? FIRST_REQUEST : LAST_REQUEST;
    },
  };
}

export type TablePageCache = ReturnType<typeof useTablePageCache>;

/**
 * After a table renders and the browser is idle, reads only its next page, so Next shows rows
 * without a request. Nothing is read in a hidden tab, under data saver or on a slow connection.
 */
export function useTablePagePrefetch({
  cache,
  currentData,
  pagedPlacementIds,
  busy,
}: Readonly<{
  cache: TablePageCache;
  currentData: ApplicationPageModel["data"];
  pagedPlacementIds: ReadonlySet<string>;
  busy: boolean;
}>) {
  useEffect(() => {
    if (busy) return;
    const run = () => {
      if (!backgroundReadsAllowed()) return;
      for (const placementId of pagedPlacementIds) {
        const table = tablePayloadFor(currentData[placementId]);
        if (table === undefined) continue;
        cache.prefetchNext(placementId, table);
      }
    };
    let handle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!backgroundReadsAllowed()) return;
      if (typeof window.requestIdleCallback === "function")
        handle = window.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
      else timer = setTimeout(run, 200);
    };
    schedule();
    // A tab that was hidden while the table rendered reads once it is shown.
    const onVisible = () => {
      if (document.visibilityState === "visible") schedule();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (handle !== undefined) window.cancelIdleCallback(handle);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [busy, cache, currentData, pagedPlacementIds]);
}
