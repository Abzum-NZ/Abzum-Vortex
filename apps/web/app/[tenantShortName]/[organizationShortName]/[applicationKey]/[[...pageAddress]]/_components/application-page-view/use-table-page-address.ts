import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import {
  applyRecordsTablePivotView,
  applyRecordsTableQueryChange,
  applyRecordsTableView,
  readRecordsTableQueryState,
  readRecordsTableView,
  recordsTableAddressKey,
  recordsTableParameterPlacement,
  type RecordsTablePageRequest,
  type RecordsTablePivotView,
  type GridViewDocument,
  type RecordsTableQueryChange,
} from "@vortex/platform/schema";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import { tablePayloadFor } from "./placement-helpers";
import type { TableContinuationTarget } from "./types";

type Entries = readonly (readonly [string, string])[];

/** The address key of every table placement the entries hold state for, by lower-cased placement. */
const addressKeys = (entries: Entries): Map<string, string> => {
  const keys = new Map<string, string>();
  for (const [name] of entries) {
    const placement = recordsTableParameterPlacement(name);
    if (placement !== undefined && !keys.has(placement))
      keys.set(placement, recordsTableAddressKey(placement, entries));
  }
  return keys;
};

const searchEntries = (search: string): Entries => [...new URLSearchParams(search)];

/** A query change the address effect has not yet turned into a read. */
const CHANGED = Symbol("changed");

/**
 * Keeps each table's query state (sort, filters, search, visible columns and page) in the address
 * without a server render. A person's change adds a history entry (shallow), and an address whose
 * state for a table differs from the state the shown data was read for (the change itself, Back,
 * Forward) rereads only that table once, under the viewer's current access. A change that reshapes
 * the query also starts the table at page one and clears its selection; the placement reread's own
 * request generation discards any response that lands for an earlier state. From the change until
 * its read lands the table is pending: the page it still shows was read for the earlier state, so
 * its continuation tokens must not start a read.
 */
export function useTablePageAddress({
  model,
  currentSearch,
  currentData,
  refreshPlacements,
  setSelection,
}: Readonly<{
  model: ApplicationPageModel;
  currentData: ApplicationPageModel["data"];
  currentSearch: string;
  refreshPlacements: (
    placementIds: readonly string[],
    tableContinuation?: TableContinuationTarget,
  ) => Promise<void>;
  setSelection: Dispatch<SetStateAction<Readonly<Record<string, readonly string[]>>>>;
}>) {
  // The table state the shown data was read for; a new server model starts from its own.
  const shownRef = useRef<{ owner: ApplicationPageModel; keys: Map<string, string> }>({
    owner: model,
    keys: addressKeys(Object.entries(model.tableAddress)),
  });
  if (shownRef.current.owner !== model)
    shownRef.current = { owner: model, keys: addressKeys(Object.entries(model.tableAddress)) };
  // Tables whose shown page no longer matches the address, by lower-cased placement.
  const pendingRef = useRef(new Map<string, symbol>());
  const tableQueryPending = useCallback(
    (placementId: string): boolean => pendingRef.current.has(placementId.toLowerCase()),
    [],
  );

  const push = (parameters: URLSearchParams): void => {
    const query = parameters.toString();
    window.history.pushState(null, "", query === "" ? window.location.pathname : `?${query}`);
  };

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

  /** Records a page the table is about to show and adds it to the address. */
  const commitTablePage = useCallback(
    (placementId: string, request: RecordsTablePageRequest) => {
      const parameters = new URLSearchParams(window.location.search);
      applyRecordsTableQueryChange(parameters, placementId, { kind: "page", request });
      const key = recordsTableAddressKey(placementId, [...parameters]);
      const shown = shownRef.current.keys;
      const placement = placementId.toLowerCase();
      if ((shown.get(placement) ?? "") === key) return;
      // The caller reads this page itself, so the address change must not read it again.
      if (key === "") shown.delete(placement);
      else shown.set(placement, key);
      clearSelection(placementId);
      push(parameters);
    },
    [clearSelection],
  );

  /**
   * Keeps the pivot view (open or closed, and its row position) in the address without a history
   * entry and without reading the table again: the pivot is a view of the same query state.
   */
  const commitPivotView = useCallback(
    (placementId: string, view: RecordsTablePivotView | undefined) => {
      const parameters = new URLSearchParams(window.location.search);
      applyRecordsTablePivotView(parameters, placementId, view);
      const query = parameters.toString();
      window.history.replaceState(null, "", query === "" ? window.location.pathname : `?${query}`);
    },
    [],
  );

  /** Applies a person's sort, filter, search or column change; the address effect rereads the table. */
  const changeTableQuery = useCallback(
    (placementId: string, change: Exclude<RecordsTableQueryChange, { kind: "page" }>) => {
      const parameters = new URLSearchParams(window.location.search);
      const before = recordsTableAddressKey(placementId, [...parameters]);
      // An automatic default can supply the shown query without naming it in the address.
      // Adopt it before editing, so clearing one part preserves the rest and clearing every
      // part uses the codec's explicit cleared-view form instead of reapplying the default.
      if (before === "") {
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
      if (recordsTableAddressKey(placementId, [...parameters]) === before) return;
      pendingRef.current.set(placementId.toLowerCase(), CHANGED);
      clearSelection(placementId);
      push(parameters);
    },
    [clearSelection, currentData],
  );

  /**
   * Opens a saved view (null leaves it): the placement's own address state is replaced by the
   * view, and the table rereads once. The view brings its own sort, filters and search from the
   * server; they join the address when that read lands.
   */
  const openTableView = useCallback(
    (placementId: string, viewId: string | null) => {
      const parameters = new URLSearchParams(window.location.search);
      const before = recordsTableAddressKey(placementId, [...parameters]);
      applyRecordsTableView(
        parameters,
        placementId,
        viewId === null ? null : { viewId, sort: [], filters: [], search: null },
      );
      if (recordsTableAddressKey(placementId, [...parameters]) === before) return;
      pendingRef.current.set(placementId.toLowerCase(), CHANGED);
      clearSelection(placementId);
      push(parameters);
    },
    [clearSelection],
  );

  /**
   * Selects a view the table already shows (the person just saved the grid as it): the address
   * names it without a reread, because the rows on screen are exactly the view's.
   */
  const selectTableViewInPlace = useCallback(
    (placementId: string, viewId: string | null, document?: GridViewDocument) => {
      const parameters = new URLSearchParams(window.location.search);
      const current = readRecordsTableQueryState(placementId, parameters);
      if (document === undefined)
        applyRecordsTableQueryChange(parameters, placementId, { kind: "view", viewId });
      else
        applyRecordsTableView(parameters, placementId, {
          viewId,
          sort: document.sort ?? [],
          filters: document.filters ?? [],
          search: document.search ?? null,
        });
      // Saving, deleting or applying a layout-only view keeps the rows already shown. Keep their
      // page position too, so reloading the address opens that same page.
      if (current.kind === "valid" && current.state.page !== undefined)
        applyRecordsTableQueryChange(parameters, placementId, {
          kind: "page",
          request: current.state.page,
        });
      shownRef.current.keys.set(
        placementId.toLowerCase(),
        recordsTableAddressKey(placementId, [...parameters]),
      );
      push(parameters);
    },
    [],
  );

  // A view opened by its address alone (a shared link, or a view just chosen) shows its own sort,
  // filters and search from the server. Once the page lands they are written into the address,
  // replacing the entry, so every control, a copied link and Back agree with what is shown. The
  // table is not read again: the address now names exactly what was read.
  useEffect(() => {
    const parameters = new URLSearchParams(currentSearch);
    const entries = [...parameters];
    let changed = false;
    for (const placementId of model.pageParameters.tableIds) {
      const view = readRecordsTableView(placementId, entries);
      if (view === undefined || view.cleared) continue;
      const key = recordsTableAddressKey(placementId, entries);
      const queried = entries.some(
        ([name]) =>
          recordsTableParameterPlacement(name) === placementId.toLowerCase() &&
          !/^(view|page)./i.test(name),
      );
      if (queried) continue;
      const held = Object.keys(currentData).find(
        (candidate) => candidate.toLowerCase() === placementId.toLowerCase(),
      );
      if (
        held === undefined ||
        (shownRef.current.keys.get(placementId.toLowerCase()) ?? "") !== key
      )
        continue;
      const selected = tablePayloadFor(currentData[held])?.layout.views?.selected;
      if (selected === null || selected === undefined || selected.viewId !== view.viewId) continue;
      const { sort, filters, search } = selected.document;
      if (sort === undefined && filters === undefined && search === undefined) continue;
      applyRecordsTableView(parameters, placementId, {
        viewId: view.viewId,
        sort: sort ?? [],
        filters: filters ?? [],
        search: search ?? null,
      });
      shownRef.current.keys.set(
        placementId.toLowerCase(),
        recordsTableAddressKey(placementId, [...parameters]),
      );
      changed = true;
    }
    if (changed) window.history.replaceState(null, "", `?${parameters.toString()}`);
  }, [currentData, currentSearch, model]);

  // The address the shown page parameters were read for; a new server model read its own address.
  const parameterSearch = useRef({ owner: model, search: currentSearch });
  useEffect(() => {
    const previousParameters = new URLSearchParams(
      parameterSearch.current.owner === model ? parameterSearch.current.search : currentSearch,
    );
    const parameters = new URLSearchParams(currentSearch);
    parameterSearch.current = { owner: model, search: currentSearch };
    const rebound = new Set(
      Object.entries(model.pageParameters.dependents).flatMap(([name, ids]) =>
        previousParameters.get(name) === parameters.get(name)
          ? []
          : ids
              .filter((id) => model.pageParameters.tableIds.includes(id))
              .map((id) => id.toLowerCase()),
      ),
    );
    const shown = shownRef.current.keys;
    const entries = searchEntries(currentSearch);
    const current = addressKeys(entries);
    for (const placement of new Set([...current.keys(), ...shown.keys(), ...rebound])) {
      const key = current.get(placement);
      const pending = pendingRef.current;
      if ((shown.get(placement) ?? "") === (key ?? "") && !rebound.has(placement)) {
        if (pending.get(placement) === CHANGED) pending.delete(placement);
        continue;
      }
      if (key === undefined) shown.delete(placement);
      else shown.set(placement, key);
      const placementId = Object.keys(model.data).find(
        (candidate) => candidate.toLowerCase() === placement,
      );
      if (placementId === undefined) {
        pending.delete(placement);
        continue;
      }
      clearSelection(placementId);
      const state = readRecordsTableQueryState(placementId, entries);
      const read = Symbol(placement);
      pending.set(placement, read);
      void refreshPlacements([placementId], {
        placementId,
        fromAddress: true,
        request: (state.kind === "valid" ? state.state.page : undefined) ?? {
          page: 1,
          pageDirection: "forward",
        },
      }).finally(() => {
        if (pending.get(placement) === read) pending.delete(placement);
      });
    }
  }, [clearSelection, currentSearch, model, refreshPlacements]);

  return {
    commitTablePage,
    changeTableQuery,
    commitPivotView,
    openTableView,
    selectTableViewInPlace,
    tableQueryPending,
  };
}
