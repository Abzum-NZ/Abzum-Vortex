import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import {
  applyRecordsTablePivotView,
  applyRecordsTableQueryChange,
  applyRecordsTableView,
  readRecordsTableQueryState,
  readRecordsTableView,
  recordsTableAddressKey,
  isRecordsTableParameterOf,
  type RecordsTablePageRequest,
  type RecordsTablePivotView,
  type GridViewDocument,
  type RecordsTableQueryChange,
  type RecordsTableSortKey,
  isRecord,
} from "@vortex/platform/schema";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import type { PageAddress } from "./page-address";
import { tablePayloadFor } from "./placement-helpers";
import type { PageSelection, TableContinuationTarget } from "./types";

const entriesOf = (search: string) => [...new URLSearchParams(search)];

const sortText = (keys: readonly RecordsTableSortKey[]): string =>
  keys.map((key) => `${key.fieldId.toLowerCase()}:${key.direction}`).join(",");

/** The address key of one table: the sorted query parameters it was or will be read for. */
const keyOf = (search: string, placement: string): string =>
  recordsTableAddressKey(placement, entriesOf(search));

/**
 * One table's read state: the address key its shown data was read for, and the read in flight.
 * The table is pending while its address key differs from the shown key: the page it still shows
 * was read for an earlier state, so its continuation tokens must not start a read.
 */
type TableRead = { shown: string; reading: symbol | undefined };

const tableIn = (tables: Map<string, TableRead>, placement: string): TableRead => {
  let table = tables.get(placement);
  if (table === undefined) {
    table = { shown: "", reading: undefined };
    tables.set(placement, table);
  }
  return table;
};

/**
 * Each table's query state lives in the page address (see `PageAddress`). A gesture writes the
 * address once (a history entry for the query, in place for a display part) and starts the one
 * read of that table under the viewer's current access; Back, Forward and a page load read the
 * address and reread every table whose state differs from what it shows. A change that reshapes
 * the query starts the table at page one and clears its selection; the placement reread's request
 * generation discards any response for an earlier state.
 */
export function useTablePageAddress({
  model,
  address,
  currentSearch,
  currentData,
  refreshPlacements,
  setSelection,
}: Readonly<{
  model: ApplicationPageModel;
  address: PageAddress;
  /** The address as rendered; it changes with every write, load, Back and Forward. */
  currentSearch: string;
  currentData: ApplicationPageModel["data"];
  refreshPlacements: (
    placementIds: readonly string[],
    tableContinuation?: TableContinuationTarget,
  ) => Promise<void>;
  setSelection: Dispatch<SetStateAction<PageSelection>>;
}>) {
  // Every table of a new server model shows what the server read for the model's own address.
  const reads = useRef<{ owner: ApplicationPageModel; tables: Map<string, TableRead> }>(
    undefined as never,
  );
  if (reads.current?.owner !== model) {
    const tables = new Map<string, TableRead>();
    const served = Object.entries(model.tableAddress);
    for (const placementId of model.pageParameters.tableIds)
      tables.set(placementId.toLowerCase(), {
        shown: recordsTableAddressKey(placementId, served),
        reading: undefined,
      });
    reads.current = { owner: model, tables };
  }
  const tableQueryPending = useCallback(
    (placementId: string): boolean => {
      const placement = placementId.toLowerCase();
      return keyOf(address.search(), placement) !== tableIn(reads.current.tables, placement).shown;
    },
    [address],
  );

  /** Only the shown page is held, so a table that shows another page or state selects nothing. */
  const clearSelection = useCallback(
    (placementId: string) =>
      setSelection((current) => {
        const held = Object.keys(current).find(
          (candidate) => candidate.toLowerCase() === placementId.toLowerCase(),
        );
        if (held === undefined) return current;
        const next = { ...current };
        delete next[held];
        return next;
      }),
    [setSelection],
  );

  /**
   * The one read of a table for its current address state. `fromAddress` reads a position named
   * by the address (a load, Back, a reshaped query), which reopens at page one when its cursor no
   * longer fits; a page move reads exactly the requested page.
   */
  const readTable = useCallback(
    async (placementId: string, request: RecordsTablePageRequest, fromAddress: boolean) => {
      const placement = placementId.toLowerCase();
      const table = tableIn(reads.current.tables, placement);
      const key = keyOf(address.search(), placement);
      const read = Symbol(placement);
      table.reading = read;
      clearSelection(placementId);
      try {
        await refreshPlacements([placementId], {
          placementId,
          request,
          ...(fromAddress ? { fromAddress: true as const } : {}),
        });
      } finally {
        if (table.reading === read) {
          table.reading = undefined;
          table.shown = key;
        }
      }
    },
    [address, clearSelection, refreshPlacements],
  );

  /** Reads every listed table again at the position its address names (or page one). */
  const rereadTables = useCallback(
    (placementIds: readonly string[]) => {
      const entries = entriesOf(address.search());
      for (const placementId of placementIds) {
        const state = readRecordsTableQueryState(placementId, entries);
        void readTable(
          placementId,
          (state.kind === "valid" ? state.state.page : undefined) ?? {
            page: 1,
            pageDirection: "forward",
          },
          true,
        );
      }
    },
    [address, readTable],
  );

  // Back, Forward and a page load: every table whose address state differs from what it shows is
  // read again. A new server model already shows its own address, so nothing is read for it.
  useEffect(
    () =>
      address.onLoad((previous) => {
        const entries = entriesOf(address.search());
        // A table that reads a page parameter Back or Forward changed is read again too.
        const before = new URLSearchParams(previous);
        const after = new URLSearchParams(address.search());
        const rebound = new Set(
          Object.entries(model.pageParameters.dependents).flatMap(([name, ids]) =>
            before.get(name) === after.get(name)
              ? []
              : ids
                  .filter((id) => model.pageParameters.tableIds.includes(id))
                  .map((id) => id.toLowerCase()),
          ),
        );
        const placements = new Set(
          Object.keys(model.data)
            .filter((placementId) =>
              entries.some(([name]) => isRecordsTableParameterOf(placementId, name)),
            )
            .map((placementId) => placementId.toLowerCase()),
        );
        for (const placement of [...reads.current.tables.keys(), ...rebound])
          placements.add(placement);
        const changed = [...placements].flatMap((placement) => {
          if (
            !rebound.has(placement) &&
            keyOf(address.search(), placement) === tableIn(reads.current.tables, placement).shown
          )
            return [];
          const placementId = Object.keys(model.data).find(
            (candidate) => candidate.toLowerCase() === placement,
          );
          return placementId === undefined ? [] : [placementId];
        });
        rereadTables(changed);
      }),
    [address, model, rereadTables],
  );

  /** Moves a table to another page: one history entry and one read of exactly that page. */
  const commitTablePage = useCallback(
    async (placementId: string, request: RecordsTablePageRequest) => {
      address.write(
        (parameters) =>
          applyRecordsTableQueryChange(parameters, placementId, { kind: "page", request }),
        "push",
      );
      await readTable(placementId, request, false);
    },
    [address, readTable],
  );

  /**
   * Keeps the pivot view (open or closed, and its row position) in the address without a history
   * entry and without reading the table again: the pivot is a view of the same query state.
   */
  const commitPivotView = useCallback(
    (placementId: string, view: RecordsTablePivotView | undefined) => {
      address.write(
        (parameters) => applyRecordsTablePivotView(parameters, placementId, view),
        "replace",
      );
    },
    [address],
  );

  /** Applies a person's sort, filter, search, grouping or drill: one history entry, one read. */
  const changeTableQuery = useCallback(
    (placementId: string, change: Exclude<RecordsTableQueryChange, { kind: "page" }>) => {
      const changed = address.write((parameters) => {
        // An automatic default can supply the shown query without naming it in the address.
        // Adopt it before editing, so clearing one part preserves the rest and clearing every
        // part uses the codec's explicit cleared-view form instead of reapplying the default.
        if (recordsTableAddressKey(placementId, [...parameters]) === "") {
          const held = Object.keys(currentData).find(
            (candidate) => candidate.toLowerCase() === placementId.toLowerCase(),
          );
          const selected =
            held === undefined
              ? undefined
              : tablePayloadFor(currentData[held])?.layout.views?.selected;
          if (selected?.scope === "default") {
            const { sort, filters, search } = selected.document;
            applyRecordsTableView(parameters, placementId, {
              viewId: selected.viewId,
              sort: sort ?? [],
              filters: filters ?? [],
              search: search ?? null,
            });
          }
        }
        applyRecordsTableQueryChange(parameters, placementId, change);
      }, "push");
      if (changed) void readTable(placementId, { page: 1, pageDirection: "forward" }, true);
    },
    [address, currentData, readTable],
  );

  /**
   * Opens a saved view (null leaves it): the placement's own address state is replaced by the
   * view, and the table reads once. The view brings its own sort, filters and search from the
   * server; they join the address when that read lands.
   */
  const openTableView = useCallback(
    (placementId: string, viewId: string | null) => {
      const changed = address.write(
        (parameters) =>
          applyRecordsTableView(
            parameters,
            placementId,
            viewId === null ? null : { viewId, sort: [], filters: [], search: null },
          ),
        "push",
      );
      if (changed) void readTable(placementId, { page: 1, pageDirection: "forward" }, true);
    },
    [address, readTable],
  );

  /**
   * Selects a view the table already shows (the person just saved the grid as it): the address
   * names it without a read, because the rows on screen are exactly the view's.
   */
  const selectTableViewInPlace = useCallback(
    (placementId: string, viewId: string | null, document?: GridViewDocument) => {
      address.write((parameters) => {
        const current = readRecordsTableQueryState(placementId, parameters);
        if (document === undefined)
          applyRecordsTableQueryChange(parameters, placementId, { kind: "view", viewId });
        else
          applyRecordsTableView(parameters, placementId, {
            viewId,
            sort: document.sort,
            filters: document.filters,
            search: document.search,
          });
        // Saving, deleting or applying a layout-only view keeps the rows already shown. Keep
        // their page position too, so reloading the address opens that same page.
        if (current.kind === "valid" && current.state.page !== undefined)
          applyRecordsTableQueryChange(parameters, placementId, {
            kind: "page",
            request: current.state.page,
          });
      }, "push");
      const placement = placementId.toLowerCase();
      tableIn(reads.current.tables, placement).shown = keyOf(address.search(), placement);
    },
    [address],
  );

  // A view opened by its address alone (a shared link, or a view just chosen) shows its own sort,
  // filters and search from the server. Once the page lands they are written into the address in
  // place, so every control, a copied link and Back agree with what is shown. The table is not
  // read again: the address now names exactly what was read.
  useEffect(() => {
    for (const placementId of model.pageParameters.tableIds) {
      const placement = placementId.toLowerCase();
      const entries = entriesOf(address.search());
      const view = readRecordsTableView(placementId, entries);
      if (view === undefined || view.cleared) continue;
      const queried = entries.some(
        ([name]) => isRecordsTableParameterOf(placementId, name) && !/^(view|page)./i.test(name),
      );
      if (queried) continue;
      const held = Object.keys(currentData).find(
        (candidate) => candidate.toLowerCase() === placement,
      );
      if (
        held === undefined ||
        keyOf(address.search(), placement) !== tableIn(reads.current.tables, placement).shown
      )
        continue;
      const selected = tablePayloadFor(currentData[held])?.layout.views?.selected;
      if (selected === null || selected === undefined || selected.viewId !== view.viewId) continue;
      const { sort, filters, search } = selected.document;
      if (sort === undefined && filters === undefined && search === undefined) continue;
      address.write(
        (parameters) =>
          applyRecordsTableView(parameters, placementId, {
            viewId: view.viewId,
            sort: sort ?? [],
            filters: filters ?? [],
            search: search ?? null,
          }),
        "replace",
      );
      tableIn(reads.current.tables, placement).shown = keyOf(address.search(), placement);
    }
  }, [address, currentData, model]);

  // While a table's read is on its way it still shows the rows read for its earlier state, but its
  // sort control shows the order the address now asks for (`requestedSort`): a second sort gesture
  // (Shift+click right after a click) builds on the first, and no copy of the sort lives in the grid.
  // `sort` keeps naming the order the shown rows were read in until the read lands.
  const tableData = useMemo(() => {
    const entries = entriesOf(currentSearch);
    let patched: Record<string, unknown> | undefined;
    for (const [placementId, data] of Object.entries(currentData)) {
      const placement = placementId.toLowerCase();
      if (!model.pageParameters.tableIds.some((id) => id.toLowerCase() === placement)) continue;
      if (keyOf(currentSearch, placement) === tableIn(reads.current.tables, placement).shown)
        continue;
      const state = readRecordsTableQueryState(placementId, entries);
      if (state.kind !== "valid" || state.state.sort.length === 0) continue;
      if (!isRecord(data) || data.status !== "ready" || !isRecord(data.values)) continue;
      const shown = data.values.sort;
      if (
        isRecord(shown) &&
        Array.isArray(shown.keys) &&
        sortText(shown.keys as RecordsTableSortKey[]) === sortText(state.state.sort)
      )
        continue;
      patched ??= { ...currentData };
      patched[placementId] = {
        ...data,
        values: { ...data.values, requestedSort: { keys: state.state.sort, explicit: true } },
      };
    }
    return (patched ?? currentData) as ApplicationPageModel["data"];
  }, [currentData, currentSearch, model]);

  return {
    tableData,
    commitTablePage,
    changeTableQuery,
    commitPivotView,
    openTableView,
    selectTableViewInPlace,
    tableQueryPending,
    rereadTables,
  };
}
