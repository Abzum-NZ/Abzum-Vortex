import { useEffect, useRef } from "react";
import type {
  ApplicationPageModel,
  ApplicationPagePlacementReadResult,
} from "../../../../../../_lib/application-page";
import { rereadApplicationPlacements } from "../../placement-refresh-action";
import { tablePayloadFor } from "./placement-helpers";
import type { TableContinuationTarget } from "./types";

type Available = Extract<ApplicationPagePlacementReadResult, { kind: "available" }>;
type TableRequest = TableContinuationTarget["request"];

/** How long the browser may stay busy before the idle read starts anyway. */
const IDLE_TIMEOUT_MS = 2_000;

type ReadContext = Readonly<{
  navigationKey: string;
  accessVersion: number;
  application: ApplicationPageModel["invocation"];
  pageKey: string | undefined;
  search: string;
}>;

/** The one next page held for a table, the full state it was read for, and whether it was dropped. */
type Held = { readonly key: string; read: Promise<Available | undefined>; dropped: boolean };

type ConnectionInformation = Readonly<{ saveData?: boolean; effectiveType?: string }>;

/** False in a hidden tab, under data saver or on a slow connection: no background read runs there. */
const backgroundReadsAllowed = (): boolean => {
  if (typeof document === "undefined" || document.visibilityState !== "visible") return false;
  const connection = (navigator as Navigator & { connection?: ConnectionInformation }).connection;
  if (connection?.saveData === true) return false;
  return connection?.effectiveType !== "2g" && connection?.effectiveType !== "slow-2g";
};

/**
 * The full state a next page is read for: the navigation (page, installation, release and the
 * server data it was rendered from), the access version, the whole address (every table's sort,
 * filters, search, columns and page) and the table's sealed continuation token, which itself binds
 * the actor, scope, query, projection and page size.
 */
const keyOf = (context: ReadContext, placementId: string, continuationToken: string): string =>
  JSON.stringify([
    context.navigationKey,
    context.accessVersion,
    context.search,
    placementId.toLowerCase(),
    continuationToken,
  ]);

/** The request a Next click sends for the page after the shown one. */
const nextRequest = (continuationToken: string): TableRequest => ({
  page: 2,
  pageDirection: "forward",
  continuationToken,
});

/**
 * Holds, in memory only, at most one next page per table: read once while the browser is idle
 * after the shown page rendered, and only for the page shown. Next uses it only when the request
 * and the full state still match; any other read of the table, a navigation, or a change of query,
 * view or access drops it, and a dropped read is ignored when it lands. Nothing else is read ahead.
 */
export function useTableNextPage(context: ReadContext) {
  const contextRef = useRef(context);
  contextRef.current = context;
  const heldRef = useRef(new Map<string, Held>());
  // The states already read ahead, so a refused or failed read is not retried for the same page.
  const attemptedRef = useRef(new Set<string>());
  const handleRef = useRef<ReturnType<typeof createHandle> | undefined>(undefined);
  handleRef.current ??= createHandle(contextRef, heldRef, attemptedRef);
  const handle = handleRef.current;
  // A navigation or a change of the address or access drops every held page at once.
  useEffect(
    () => handle.dropAll(),
    [handle, context.navigationKey, context.accessVersion, context.search],
  );
  return handle;
}

function createHandle(
  contextRef: Readonly<{ current: ReadContext }>,
  heldRef: Readonly<{ current: Map<string, Held> }>,
  attemptedRef: Readonly<{ current: Set<string> }>,
) {
  const dropList = (list: string): void => {
    const held = heldRef.current.get(list);
    if (held === undefined) return;
    held.dropped = true;
    heldRef.current.delete(list);
  };
  const drop = (placementIds: readonly string[]): void => {
    for (const placementId of placementIds) dropList(placementId.toLowerCase());
  };

  const read = async (
    context: ReadContext,
    placementId: string,
    held: Held,
    request: TableRequest,
  ): Promise<Available | undefined> => {
    if (context.pageKey === undefined) return undefined;
    let result: ApplicationPagePlacementReadResult;
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
      console.error("[page] table next page read failed", error);
      return undefined;
    }
    // A read dropped while it ran (a navigation, a query change, another read) is ignored.
    if (held.dropped || result.kind !== "available") return undefined;
    const state = Object.entries(result.data).find(
      ([candidate]) => candidate.toLowerCase() === placementId.toLowerCase(),
    )?.[1];
    return state !== undefined && tablePayloadFor(state) !== undefined ? result : undefined;
  };

  return {
    /** Forgets the held next page of each table, so a read still running is ignored when it lands. */
    drop,

    dropAll(): void {
      for (const list of [...heldRef.current.keys()]) dropList(list);
      attemptedRef.current.clear();
    },

    /**
     * The held read of the page a Next click asks for, when it was read for the same full state;
     * it is taken once. Undefined sends the ordinary read.
     */
    take(placementId: string, request: TableRequest): Promise<Available | undefined> | undefined {
      const list = placementId.toLowerCase();
      const held = heldRef.current.get(list);
      heldRef.current.delete(list);
      if (
        held === undefined ||
        request.pageDirection !== "forward" ||
        request.page !== 2 ||
        request.continuationToken === undefined ||
        held.key !== keyOf(contextRef.current, placementId, request.continuationToken)
      )
        return undefined;
      return held.read;
    },

    /** Reads the shown page's next page for each table that has one, once per shown state. */
    readAhead(
      currentData: ApplicationPageModel["data"],
      placementIds: readonly string[],
      pending: (placementId: string) => boolean,
    ): void {
      if (!backgroundReadsAllowed()) return;
      const context = contextRef.current;
      for (const placementId of placementIds) {
        const list = placementId.toLowerCase();
        const table = tablePayloadFor(currentData[placementId]);
        const token = table?.hasNextPage === true ? table.nextContinuationToken : undefined;
        if (token === undefined || pending(placementId)) {
          dropList(list);
          continue;
        }
        const key = keyOf(context, placementId, token);
        if (heldRef.current.get(list)?.key === key) continue;
        dropList(list);
        if (attemptedRef.current.has(key)) continue;
        attemptedRef.current.add(key);
        const held: Held = { key, read: Promise.resolve(undefined), dropped: false };
        heldRef.current.set(list, held);
        held.read = read(context, placementId, held, nextRequest(token));
      }
    },
  };
}

export type TableNextPage = ReturnType<typeof useTableNextPage>;

/**
 * After the shown tables render and the browser is idle, reads each one's next page once. A newer
 * render, a hidden tab or a busy page cancels the scheduled read; the held page's own key drops it
 * when the state it was read for changes.
 */
export function useTableNextPageReadAhead({
  nextPage,
  currentData,
  pagedPlacementIds,
  busy,
  pending,
}: Readonly<{
  nextPage: TableNextPage;
  currentData: ApplicationPageModel["data"];
  pagedPlacementIds: readonly string[];
  busy: boolean;
  pending: (placementId: string) => boolean;
}>): void {
  useEffect(() => {
    if (busy || pagedPlacementIds.length === 0) return;
    let handle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => nextPage.readAhead(currentData, pagedPlacementIds, pending);
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
  }, [busy, currentData, nextPage, pagedPlacementIds, pending]);
}
