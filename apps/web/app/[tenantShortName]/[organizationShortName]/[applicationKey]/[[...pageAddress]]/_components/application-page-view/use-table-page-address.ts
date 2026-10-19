import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import {
  applyRecordsTableQueryChange,
  readRecordsTableQueryState,
  recordsTableAddressKey,
  recordsTableParameterPlacement,
  type RecordsTablePageRequest,
  type RecordsTableQueryChange,
} from "@vortex/platform/schema";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
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
  refreshPlacements,
  setSelection,
}: Readonly<{
  model: ApplicationPageModel;
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

  /** Applies a person's sort, filter, search or column change; the address effect rereads the table. */
  const changeTableQuery = useCallback(
    (placementId: string, change: Exclude<RecordsTableQueryChange, { kind: "page" }>) => {
      const parameters = new URLSearchParams(window.location.search);
      const before = recordsTableAddressKey(placementId, [...parameters]);
      applyRecordsTableQueryChange(parameters, placementId, change);
      if (recordsTableAddressKey(placementId, [...parameters]) === before) return;
      pendingRef.current.set(placementId.toLowerCase(), CHANGED);
      clearSelection(placementId);
      push(parameters);
    },
    [clearSelection],
  );

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

  return { commitTablePage, changeTableQuery, tableQueryPending };
}
