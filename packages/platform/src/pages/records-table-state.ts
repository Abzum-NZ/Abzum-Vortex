import type { RecordsTableSortDirection } from "../definition/application-composition/records-display";
import {
  decodeRecordsTableFieldFilter,
  type RecordsTableFilterValue,
} from "./records-table-filters";

export * from "./records-table-filters";

/**
 * The query state of one Records table placement: the one contract the browser writes into the
 * page address and the server reads back from it. It is isomorphic and holds only what a person
 * chose; the server derives every allow-list and the query identity from the installed placement
 * and validates each part of this state against them before anything is read.
 */

/** The most sort keys one table request may order by; the Query engine accepts the same bound. */
export const RECORDS_TABLE_MAXIMUM_SORT_KEYS = 20;
/** The longest search text the Query engine accepts. */
export const RECORDS_TABLE_MAXIMUM_SEARCH_LENGTH = 200;

/** One key of an ordered sort over a field. */
export type RecordsTableSortKey = Readonly<{
  fieldId: string;
  direction: RecordsTableSortDirection;
}>;

/** The order a table page was read in, as the renderer shows it in its headers. */
export type RecordsTableSortState = Readonly<{
  keys: readonly RecordsTableSortKey[];
  /** True when the person chose this order; false when it is the authored default sort. */
  explicit: boolean;
}>;

/**
 * One requested table page. Page one has no token; a later page names the sealed continuation
 * token the table already holds, or no token with a backward direction for the last page.
 */
export type RecordsTablePageRequest = Readonly<{
  page: number;
  pageDirection: "forward" | "backward";
  continuationToken?: string;
}>;

export type RecordsTableQueryState = Readonly<{
  /** The person's ordered sort; empty uses the authored default sort. */
  sort: readonly RecordsTableSortKey[];
  filters: readonly RecordsTableFilterValue[];
  search: string | null;
  /** Undefined requests page one. */
  page: RecordsTablePageRequest | undefined;
}>;

export type RecordsTableQueryStateRead =
  | Readonly<{ kind: "valid"; state: RecordsTableQueryState }>
  | Readonly<{ kind: "malformed"; part: "sort" | "filter" | "search" }>;

const FIELD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_PATTERN = /^[1-9][0-9]{0,4}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,65536}$/;

const sortParameter = (placementId: string): string => `sort.${placementId}`;
const filterPrefix = (placementId: string): string => `filter.${placementId}.`;
const searchParameter = (placementId: string): string => `search.${placementId}`;
const pageParameter = (placementId: string): string => `page.${placementId}`;
const viewParameter = (placementId: string): string => `view.${placementId}`;

// The one codec of every `<kind>.<placement>` address prefix: the query state, and the saved view
// the table was opened with (#3023).
const QUERY_STATE_PREFIXES = ["sort.", "filter.", "search.", "page.", "view."] as const;

/**
 * The placement whose table state an address parameter holds, lower-cased, or undefined for a
 * parameter that is not table state. Placement identities are UUIDs, so they never hold a dot.
 */
export const recordsTableParameterPlacement = (name: string): string | undefined => {
  const prefix = QUERY_STATE_PREFIXES.find((candidate) => name.startsWith(candidate));
  if (prefix === undefined) return undefined;
  const placementId = name.slice(prefix.length).split(".")[0];
  return placementId === undefined || !FIELD_ID_PATTERN.test(placementId)
    ? undefined
    : placementId.toLowerCase();
};

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** The first value of each parameter whose name belongs to the placement, matched without case. */
const placementEntries = (
  placementId: string,
  entries: Iterable<readonly [string, string]>,
): Map<string, string> => {
  const owned = new Map<string, string>();
  for (const [name, value] of entries) {
    const owner = recordsTableParameterPlacement(name);
    if (owner === undefined || !sameId(owner, placementId)) continue;
    const prefix = QUERY_STATE_PREFIXES.find((candidate) => name.startsWith(candidate))!;
    // Names are kept in the canonical spelling of this placement identity.
    const key = `${prefix}${placementId}${name.slice(prefix.length + placementId.length)}`;
    if (!owned.has(key)) owned.set(key, value);
  }
  return owned;
};

/** The address value of a page request, or undefined for the first page. */
export const encodeRecordsTablePagePosition = (
  request: RecordsTablePageRequest,
): string | undefined => {
  if (request.page <= 1) return undefined;
  if (request.continuationToken === undefined) return `${request.page}.last`;
  return `${request.page}.${request.pageDirection}.${request.continuationToken}`;
};

/**
 * The page request an address value names, `<page>.last` or `<page>.<direction>.<token>`, so the
 * table shows the same page number after a reload; a value that is not a position reads page one.
 */
export const parseRecordsTablePagePosition = (
  value: string | undefined,
): RecordsTablePageRequest | undefined => {
  const [pageText, direction, token, ...rest] = value?.split(".") ?? [];
  if (pageText === undefined || !PAGE_PATTERN.test(pageText) || rest.length > 0) return undefined;
  const page = Number(pageText);
  if (page < 2) return undefined;
  if (direction === "last" && token === undefined) return { page, pageDirection: "backward" };
  if (
    (direction !== "forward" && direction !== "backward") ||
    token === undefined ||
    !TOKEN_PATTERN.test(token)
  )
    return undefined;
  return { page, pageDirection: direction, continuationToken: token };
};

const encodeSort = (keys: readonly RecordsTableSortKey[]): string =>
  keys.map((key) => `${key.fieldId}:${key.direction}`).join(",");

const parseSort = (value: string): RecordsTableSortKey[] | undefined => {
  const keys: RecordsTableSortKey[] = [];
  for (const part of value.split(",")) {
    const separator = part.lastIndexOf(":");
    const fieldId = part.slice(0, separator);
    const direction = part.slice(separator + 1);
    if (
      separator < 1 ||
      !FIELD_ID_PATTERN.test(fieldId) ||
      (direction !== "ascending" && direction !== "descending") ||
      keys.some((key) => sameId(key.fieldId, fieldId))
    )
      return undefined;
    keys.push({ fieldId: fieldId.toLowerCase(), direction });
  }
  return keys.length === 0 || keys.length > RECORDS_TABLE_MAXIMUM_SORT_KEYS ? undefined : keys;
};

/**
 * Reads one placement's query state from the page address. A malformed sort, filter or search is
 * reported rather than dropped, so the server refuses the read instead of showing a different order
 * or other rows than the address names. An unreadable page position reads page one. Which columns show is not query state:
 * it is the person's stored grid layout (`GridLayout`).
 */
export const readRecordsTableQueryState = (
  placementId: string,
  entries: Iterable<readonly [string, string]>,
): RecordsTableQueryStateRead => {
  const addressed = [...entries];
  const filtersSeen = new Set<string>();
  for (const [name] of addressed) {
    if (
      !name.startsWith("filter.") ||
      recordsTableParameterPlacement(name) !== placementId.toLowerCase()
    )
      continue;
    const key = name.toLowerCase();
    if (filtersSeen.has(key)) return { kind: "malformed", part: "filter" };
    filtersSeen.add(key);
  }
  const owned = placementEntries(placementId, addressed);
  const sortText = owned.get(sortParameter(placementId));
  const sort = sortText === undefined ? [] : parseSort(sortText);
  if (sort === undefined) return { kind: "malformed", part: "sort" };
  const searchText = owned.get(searchParameter(placementId))?.trim();
  if (searchText !== undefined && searchText.length > RECORDS_TABLE_MAXIMUM_SEARCH_LENGTH)
    return { kind: "malformed", part: "search" };
  const prefix = filterPrefix(placementId);
  const filters: RecordsTableFilterValue[] = [];
  for (const [name, value] of owned) {
    if (!name.startsWith(prefix) || value === "") continue;
    const fieldId = name.slice(prefix.length);
    const filter = decodeRecordsTableFieldFilter(value);
    if (
      !FIELD_ID_PATTERN.test(fieldId) ||
      filter === undefined ||
      filters.some((held) => sameId(held.fieldId, fieldId))
    )
      return { kind: "malformed", part: "filter" };
    filters.push({ fieldId: fieldId.toLowerCase(), filter });
  }
  return {
    kind: "valid",
    state: {
      sort,
      filters,
      search: searchText === undefined || searchText === "" ? null : searchText,
      page: parseRecordsTablePagePosition(owned.get(pageParameter(placementId))),
    },
  };
};

const VIEW_CLEARED_SUFFIX = ".cleared";

/**
 * The saved view a placement's address selects, lower-cased, and whether the person has since
 * cleared the view's own sort, filters and search (`<id>.cleared`): a cleared view no longer
 * brings its query state, so an address that names none really means none. Undefined when the
 * address selects no view.
 */
export const readRecordsTableView = (
  placementId: string,
  entries: Iterable<readonly [string, string]>,
): Readonly<{ viewId: string; cleared: boolean }> | undefined => {
  const value = placementEntries(placementId, entries).get(viewParameter(placementId));
  if (value === undefined) return undefined;
  const cleared = value.toLowerCase().endsWith(VIEW_CLEARED_SUFFIX);
  const viewId = cleared ? value.slice(0, -VIEW_CLEARED_SUFFIX.length) : value;
  return FIELD_ID_PATTERN.test(viewId) ? { viewId: viewId.toLowerCase(), cleared } : undefined;
};

/** The saved view a placement's address selects, lower-cased; undefined when it selects none. */
export const readRecordsTableViewId = (
  placementId: string,
  entries: Iterable<readonly [string, string]>,
): string | undefined => readRecordsTableView(placementId, entries)?.viewId;

/**
 * The sort, filters and search a placement's address holds, with each filter in its address
 * spelling, so a saved view stores exactly what the address names. Undefined when the address
 * names a malformed part, which the server refuses to read.
 */
export const readRecordsTableAddressedQuery = (
  placementId: string,
  entries: Iterable<readonly [string, string]>,
):
  | Readonly<{
      sort: readonly RecordsTableSortKey[];
      filters: readonly Readonly<{ fieldId: string; filter: string }>[];
      search: string | null;
    }>
  | undefined => {
  const addressed = [...entries];
  const read = readRecordsTableQueryState(placementId, addressed);
  if (read.kind !== "valid") return undefined;
  const owned = placementEntries(placementId, addressed);
  const prefix = filterPrefix(placementId);
  return {
    sort: read.state.sort,
    filters: read.state.filters.flatMap(({ fieldId }) => {
      const spelled = [...owned].find(
        ([name]) => name.startsWith(prefix) && sameId(name.slice(prefix.length), fieldId),
      );
      return spelled === undefined ? [] : [{ fieldId, filter: spelled[1] }];
    }),
    search: read.state.search,
  };
};

/** One change a person makes to a table's query state from its controls. */
export type RecordsTableQueryChange =
  | Readonly<{ kind: "sort"; keys: readonly RecordsTableSortKey[] }>
  /** `filter` is the address spelling of the field's typed filter; empty clears the field's filter. */
  | Readonly<{ kind: "filter"; fieldId: string; filter: string }>
  | Readonly<{ kind: "search"; text: string }>
  /** Opens a saved view (null leaves it) without touching the other parts of the query state. */
  | Readonly<{ kind: "view"; viewId: string | null }>
  | Readonly<{ kind: "page"; request: RecordsTablePageRequest }>;

/**
 * Applies one change to the page address in place. Every change other than a page move reshapes
 * the query, so it also drops the table's page position: the next read starts at page one and no
 * cursor issued for the earlier state is reused.
 */
export const applyRecordsTableQueryChange = (
  parameters: URLSearchParams,
  placementId: string,
  change: RecordsTableQueryChange,
): void => {
  const set = (name: string, value: string | undefined): void => {
    for (const held of [...parameters.keys()])
      if (held.toLowerCase() === name.toLowerCase()) parameters.delete(held);
    if (value !== undefined) parameters.set(name, value);
  };
  if (change.kind === "page") {
    set(pageParameter(placementId), encodeRecordsTablePagePosition(change.request));
    return;
  }
  set(pageParameter(placementId), undefined);
  const settleView = (): void => {
    // A selected view brings its own query state only while the address names none: once the
    // person has cleared it all, the address says so explicitly.
    const view = readRecordsTableView(placementId, parameters);
    if (view === undefined) return;
    const queried = [...parameters.keys()].some(
      (name) =>
        recordsTableParameterPlacement(name) === placementId.toLowerCase() &&
        !name.toLowerCase().startsWith("view.") &&
        !name.toLowerCase().startsWith("page."),
    );
    set(viewParameter(placementId), queried ? view.viewId : `${view.viewId}${VIEW_CLEARED_SUFFIX}`);
  };
  switch (change.kind) {
    case "sort":
      set(
        sortParameter(placementId),
        change.keys.length === 0 ? undefined : encodeSort(change.keys),
      );
      settleView();
      return;
    case "filter":
      set(
        `${filterPrefix(placementId)}${change.fieldId}`,
        change.filter === "" ? undefined : change.filter,
      );
      settleView();
      return;
    case "search":
      set(searchParameter(placementId), change.text.trim() === "" ? undefined : change.text);
      settleView();
      return;
    case "view":
      set(viewParameter(placementId), change.viewId ?? undefined);
      return;
  }
};

/**
 * Opens a saved view in the address, or leaves it: every part of the placement's own state is
 * replaced by the view's, so the address alone names what the grid shows and a copied link opens
 * the same view for anyone who may see it. A null view clears the placement's state.
 */
export const applyRecordsTableView = (
  parameters: URLSearchParams,
  placementId: string,
  view: Readonly<{
    viewId: string;
    sort: readonly RecordsTableSortKey[];
    filters: readonly Readonly<{ fieldId: string; filter: string }>[];
    search: string | null;
  }> | null,
): void => {
  for (const name of [...parameters.keys()])
    if (recordsTableParameterPlacement(name) === placementId.toLowerCase()) parameters.delete(name);
  if (view === null) return;
  applyRecordsTableQueryChange(parameters, placementId, { kind: "view", viewId: view.viewId });
  if (view.sort.length > 0)
    applyRecordsTableQueryChange(parameters, placementId, { kind: "sort", keys: view.sort });
  for (const { fieldId, filter } of view.filters)
    applyRecordsTableQueryChange(parameters, placementId, { kind: "filter", fieldId, filter });
  if (view.search !== null)
    applyRecordsTableQueryChange(parameters, placementId, { kind: "search", text: view.search });
};

/**
 * The part of an address one placement's state occupies, in a stable spelling: two addresses with
 * the same key read the same table page, so a client compares keys to decide whether to reread.
 */
export const recordsTableAddressKey = (
  placementId: string,
  entries: Iterable<readonly [string, string]>,
): string =>
  [...placementEntries(placementId, entries)]
    .map(([name, value]) => `${name.toLowerCase()}=${value}`)
    .sort()
    .join("&");

/**
 * The address query without any table query state: what identifies the page itself. A table's
 * sort, filter, search and page change only that table, never the page around it.
 */
export const searchWithoutRecordsTableState = (search: string): string => {
  const parameters = new URLSearchParams(search);
  for (const name of [...parameters.keys()])
    if (recordsTableParameterPlacement(name) !== undefined) parameters.delete(name);
  return parameters.toString();
};

/**
 * The sort a header activation asks for, from the order the shown page was read in. A plain
 * activation replaces the sort with that field: ascending, then descending, then (for a sort the
 * person chose) back to the default order. An additive activation (Shift) keeps every other key
 * and its priority: it appends the field ascending, turns an ascending key descending, and removes a
 * descending key. An empty result asks for the authored default order.
 */
export const nextRecordsTableSort = (
  shown: RecordsTableSortState | undefined,
  fieldId: string,
  additive: boolean,
): readonly RecordsTableSortKey[] => {
  const keys = shown?.keys ?? [];
  const index = keys.findIndex((key) => sameId(key.fieldId, fieldId));
  const held = index < 0 ? undefined : keys[index];
  if (additive) {
    if (held === undefined)
      return keys.length >= RECORDS_TABLE_MAXIMUM_SORT_KEYS
        ? keys
        : [...keys, { fieldId, direction: "ascending" }];
    return held.direction === "ascending"
      ? keys.map((key, position) =>
          position === index ? { fieldId: key.fieldId, direction: "descending" as const } : key,
        )
      : keys.filter((_, position) => position !== index);
  }
  if (index !== 0 || held === undefined) return [{ fieldId, direction: "ascending" }];
  if (held.direction === "ascending") return [{ fieldId: held.fieldId, direction: "descending" }];
  return shown?.explicit === true && keys.length === 1
    ? []
    : [{ fieldId: held.fieldId, direction: "ascending" }];
};
