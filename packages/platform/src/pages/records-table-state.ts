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

/**
 * The pivot view a table is opened in: absent shows the ordinary grid. `cursor` is the opaque
 * keyset position of the first pivot row on the page; absent starts at the first row.
 */
export type RecordsTablePivotView = Readonly<{ cursor?: string | undefined }>;

/**
 * The grouping a table is read in: the field its records are grouped by, the position of the page
 * of groups (`after`, the opaque keyset position of the last group of the page before, or null for
 * the first page) and the one group that is open, as its group key, or null while every group is
 * collapsed. A group key is the canonical JSON text of the group's value (a choice value, a date
 * bucket start, a linked record's `{ recordTypeId, recordId }`, the text `not_available` for the
 * links the viewer cannot read, or `null` for the records with none), so it never holds a label.
 */
export type RecordsTableGroupState = Readonly<{
  fieldId: string;
  after: string | null;
  expanded: string | null;
}>;

/** The value one group stands for: see `RecordsTableGroupState`. */
export type RecordsTableGroupValue =
  string | null | Readonly<{ recordTypeId: string; recordId: string }>;

/** The longest text value a group key can carry; the Query engine accepts the same bound. */
const GROUP_VALUE_MAXIMUM_LENGTH = 120;
/** The longest position of a page of groups: a link group's title is part of its position. */
const GROUP_AFTER_MAXIMUM_LENGTH = 4096;

/** The group key of a group's value: its canonical JSON text. */
export const recordsTableGroupKey = (value: RecordsTableGroupValue): string =>
  JSON.stringify(
    typeof value === "object" && value !== null
      ? { recordTypeId: value.recordTypeId, recordId: value.recordId }
      : value,
  );

/** The value a group key names; undefined for text that is not a key this codec writes. */
export const parseRecordsTableGroupKey = (key: string): RecordsTableGroupValue | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    return undefined;
  }
  if (parsed === null) return null;
  if (typeof parsed === "string")
    return parsed.length >= 1 &&
      parsed.length <= GROUP_VALUE_MAXIMUM_LENGTH &&
      recordsTableGroupKey(parsed) === key
      ? parsed
      : undefined;
  if (typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const { recordTypeId, recordId, ...rest } = parsed as Record<string, unknown>;
  if (
    Object.keys(rest).length > 0 ||
    typeof recordTypeId !== "string" ||
    typeof recordId !== "string" ||
    !FIELD_ID_PATTERN.test(recordTypeId) ||
    !FIELD_ID_PATTERN.test(recordId)
  )
    return undefined;
  const value = { recordTypeId, recordId };
  return recordsTableGroupKey(value) === key ? value : undefined;
};

export type RecordsTableQueryState = Readonly<{
  /** The person's ordered sort; empty uses the authored default sort. */
  sort: readonly RecordsTableSortKey[];
  filters: readonly RecordsTableFilterValue[];
  search: string | null;
  /** Undefined requests page one. */
  page: RecordsTablePageRequest | undefined;
  /** Present when the table is shown as a pivot. It is a view, not a query change. */
  pivot?: RecordsTablePivotView | undefined;
  /** Present when the table is grouped by a field; it carries the open group. */
  group?: RecordsTableGroupState | undefined;
}>;

export type RecordsTableQueryStateRead =
  | Readonly<{ kind: "valid"; state: RecordsTableQueryState }>
  | Readonly<{ kind: "malformed"; part: "sort" | "filter" | "search" | "group" }>;

const FIELD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_PATTERN = /^[1-9][0-9]{0,4}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,65536}$/;

/**
 * The one codec table of every `<prefix><placement>` address parameter a data block keeps in the
 * page address, and what each belongs to. `query` is a table's query state and its saved view: a
 * change rereads only that table. `display` is a view of the same query state (the pivot, the open
 * group): changing it reads no rows. `calendar` is a calendar's period: a change reads the page
 * again. A placement is named by its address token (see `placementAddressToken`), which never
 * holds a dot.
 */
const ADDRESS_PARAMETERS = {
  sort: { prefix: "sort.", part: "query" },
  filter: { prefix: "filter.", part: "query" },
  search: { prefix: "search.", part: "query" },
  page: { prefix: "page.", part: "query" },
  view: { prefix: "view.", part: "query" },
  group: { prefix: "group.", part: "query" },
  pivot: { prefix: "pivot.", part: "display" },
  expand: { prefix: "expand.", part: "display" },
  calendar: { prefix: "calendar.", part: "calendar" },
  date: { prefix: "date.", part: "calendar" },
} as const;
type AddressParameterKind = keyof typeof ADDRESS_PARAMETERS;

const ADDRESS_TOKEN_PATTERN = /^[0-9a-f]{8}$/i;

/**
 * The short name a placement's parameters carry in the page address: the first eight hexadecimal
 * digits of its identity, so an address reads `search.bdad601d=port` instead of repeating the
 * whole identity. It needs no page context, so the server read and every client writer derive the
 * same name. A per-page position would not: the projection hides placements a role cannot see, so
 * the same position would name another table for another person. Placement identities are
 * random or hashed, so two tables of one page share a token only by a one-in-four-billion chance.
 */
export const placementAddressToken = (placementId: string): string =>
  placementId.slice(0, 8).toLowerCase();

/** The address parameter of one kind for a placement, in the spelling this codec writes. */
export const addressParameter = (kind: AddressParameterKind, placementId: string): string =>
  `${ADDRESS_PARAMETERS[kind].prefix}${placementAddressToken(placementId)}`;

/** The kind and placement token (lower-cased) an address parameter holds, or undefined. */
const addressParameterOwner = (
  name: string,
): Readonly<{ kind: AddressParameterKind; token: string }> | undefined => {
  for (const [kind, { prefix }] of Object.entries(ADDRESS_PARAMETERS)) {
    if (!name.startsWith(prefix)) continue;
    const token = name.slice(prefix.length).split(".")[0];
    return token === undefined || !ADDRESS_TOKEN_PATTERN.test(token)
      ? undefined
      : { kind: kind as AddressParameterKind, token: token.toLowerCase() };
  }
  return undefined;
};

const sortParameter = (placementId: string): string => addressParameter("sort", placementId);
const filterPrefix = (placementId: string): string => `${addressParameter("filter", placementId)}.`;
const searchParameter = (placementId: string): string => addressParameter("search", placementId);
const pageParameter = (placementId: string): string => addressParameter("page", placementId);
const pivotParameter = (placementId: string): string => addressParameter("pivot", placementId);
const viewParameter = (placementId: string): string => addressParameter("view", placementId);
const groupParameter = (placementId: string): string => addressParameter("group", placementId);
const expandParameter = (placementId: string): string => addressParameter("expand", placementId);

/**
 * The placement token whose table state an address parameter holds, lower-cased, or undefined for
 * a parameter that is not table state.
 */
export const recordsTableParameterPlacement = (name: string): string | undefined => {
  const owner = addressParameterOwner(name);
  return owner !== undefined && ADDRESS_PARAMETERS[owner.kind].part === "query"
    ? owner.token
    : undefined;
};

/** Whether an address parameter holds table state of this placement. */
export const isRecordsTableParameterOf = (placementId: string, name: string): boolean =>
  recordsTableParameterPlacement(name) === placementAddressToken(placementId);

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** The first value of each parameter whose name belongs to the placement, matched without case. */
const placementEntries = (
  placementId: string,
  entries: Iterable<readonly [string, string]>,
): Map<string, string> => {
  const owned = new Map<string, string>();
  for (const [name, value] of entries) {
    if (!isRecordsTableParameterOf(placementId, name)) continue;
    const prefix = ADDRESS_PARAMETERS[addressParameterOwner(name)!.kind].prefix;
    const token = placementAddressToken(placementId);
    // Names are kept in the canonical spelling of this placement's token.
    const key = `${prefix}${token}${name.slice(prefix.length + token.length)}`;
    if (!owned.has(key)) owned.set(key, value);
  }
  return owned;
};

/**
 * The address value of a pivot view, `on` or `on.<cursor>`. The pivot is a view of the same query
 * state, so it is not part of the query-state prefixes: opening it, paging its rows or closing it
 * never reads the table's rows again.
 */
export const encodeRecordsTablePivotView = (view: RecordsTablePivotView): string =>
  view.cursor === undefined ? "on" : `on.${view.cursor}`;

/** The pivot view an address value names; undefined for anything that is not a pivot view. */
export const parseRecordsTablePivotView = (
  value: string | undefined,
): RecordsTablePivotView | undefined => {
  if (value === "on") return {};
  if (value === undefined || !value.startsWith("on.")) return undefined;
  const cursor = value.slice(3);
  return TOKEN_PATTERN.test(cursor) ? { cursor } : undefined;
};

/** Sets or clears one placement's pivot view in the page address, in place. */
export const applyRecordsTablePivotView = (
  parameters: URLSearchParams,
  placementId: string,
  view: RecordsTablePivotView | undefined,
): void => {
  for (const held of [...parameters.keys()])
    if (held.toLowerCase() === pivotParameter(placementId).toLowerCase()) parameters.delete(held);
  if (view !== undefined)
    parameters.set(pivotParameter(placementId), encodeRecordsTablePivotView(view));
};

const toBase64Url = (text: string): string => {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (value: string): string | undefined => {
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    return undefined;
  }
};

/**
 * Opens one group of a grouped table in the address, or closes it (null). The open group is a view
 * of the same query state, so it is not part of the query-state prefixes: opening, closing or
 * paging a group never reads the groups again.
 */
export const applyRecordsTableGroupExpansion = (
  parameters: URLSearchParams,
  placementId: string,
  expanded: string | null,
): void => {
  for (const held of [...parameters.keys()])
    if (held.toLowerCase() === expandParameter(placementId).toLowerCase()) parameters.delete(held);
  if (expanded !== null) parameters.set(expandParameter(placementId), toBase64Url(expanded));
};

/**
 * The address value that opens a table flat although it is authored to open grouped. A field
 * identity is a UUID, so it never collides with this word.
 */
const GROUP_FLAT_VALUE = "flat";

/**
 * The grouping an address value names: `<field>` for the first page of groups, `<field>.<position>`
 * for a later page, the position being the base64url text of the last group's key, or `flat` for
 * the ungrouped table. A value that is not one of these is malformed.
 */
const decodeGroupParameter = (
  value: string | undefined,
): Readonly<{ fieldId: string; after: string | null }> | undefined | "flat" | "malformed" => {
  if (value === undefined) return undefined;
  if (value === GROUP_FLAT_VALUE) return "flat";
  const dot = value.indexOf(".");
  const fieldId = dot < 0 ? value : value.slice(0, dot);
  if (!FIELD_ID_PATTERN.test(fieldId)) return "malformed";
  if (dot < 0) return { fieldId: fieldId.toLowerCase(), after: null };
  const encoded = value.slice(dot + 1);
  const after = /^[A-Za-z0-9_-]{1,6000}$/.test(encoded) ? fromBase64Url(encoded) : undefined;
  return after === undefined || after.length > GROUP_AFTER_MAXIMUM_LENGTH
    ? "malformed"
    : { fieldId: fieldId.toLowerCase(), after };
};

const decodeGroupExpansion = (value: string | undefined): string | null | undefined => {
  if (value === undefined) return null;
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(value)) return undefined;
  const key = fromBase64Url(value);
  return key === undefined || parseRecordsTableGroupKey(key) === undefined ? undefined : key;
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
  /**
   * The field a table authored to open grouped (`opens_grouped`; always, for a grouped query) is
   * grouped by when the address names none: its authored grouping field, never one the address
   * chose. The address overrides the authored opening state both ways: a field groups, `flat`
   * ungroups.
   */
  opensGroupedField?: string,
  /** The table reads a grouped query, which has no flat read: `flat` is malformed for it. */
  groupedQuery = false,
): RecordsTableQueryStateRead => {
  const addressed = [...entries];
  const filtersSeen = new Set<string>();
  for (const [name] of addressed) {
    if (!name.startsWith("filter.") || !isRecordsTableParameterOf(placementId, name)) continue;
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
  const addressedGroup = decodeGroupParameter(owned.get(groupParameter(placementId)));
  if (addressedGroup === "malformed" || (addressedGroup === "flat" && groupedQuery))
    return { kind: "malformed", part: "group" };
  const group =
    addressedGroup === "flat"
      ? undefined
      : (addressedGroup ??
        (opensGroupedField === undefined
          ? undefined
          : { fieldId: opensGroupedField.toLowerCase(), after: null }));
  const expanded = decodeGroupExpansion(
    addressed.find(
      ([name]) => name.toLowerCase() === expandParameter(placementId).toLowerCase(),
    )?.[1],
  );
  if (expanded === undefined) return { kind: "malformed", part: "group" };
  return {
    kind: "valid",
    state: {
      sort,
      filters,
      search: searchText === undefined || searchText === "" ? null : searchText,
      page: parseRecordsTablePagePosition(owned.get(pageParameter(placementId))),
      pivot: parseRecordsTablePivotView(
        addressed.find(
          ([name]) => name.toLowerCase() === pivotParameter(placementId).toLowerCase(),
        )?.[1],
      ),
      group: group === undefined ? undefined : { ...group, expanded },
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

/** The page position a placement's address holds; undefined on the first page. */
export const readRecordsTablePagePosition = (
  placementId: string,
  entries: Iterable<readonly [string, string]>,
): ReturnType<typeof parseRecordsTablePagePosition> =>
  parseRecordsTablePagePosition(
    placementEntries(placementId, entries).get(pageParameter(placementId)),
  );

/** One change a person makes to a table's query state from its controls. */
export type RecordsTableQueryChange =
  | Readonly<{ kind: "sort"; keys: readonly RecordsTableSortKey[] }>
  /** `filter` is the address spelling of the field's typed filter; empty clears the field's filter. */
  | Readonly<{ kind: "filter"; fieldId: string; filter: string }>
  | Readonly<{ kind: "search"; text: string }>
  /**
   * Groups the table by a field (null leaves the grouping); every group starts closed.
   * `opensGrouped` is whether the table is authored to open grouped: the address then holds only
   * the difference from that opening state.
   */
  | Readonly<{ kind: "group"; fieldId: string | null; opensGrouped: boolean }>
  /** Shows another page of the groups (null `after` is the first page); every group is closed. */
  | Readonly<{
      kind: "groupPage";
      fieldId: string;
      after: string | null;
      opensGrouped: boolean;
    }>
  /**
   * A pivot cell opens the ordinary grid on the records it counts: every filter is set at once and
   * the pivot view is closed, so the one address change reads one bounded page.
   */
  | Readonly<{
      kind: "drill";
      filters: readonly Readonly<{ fieldId: string; filter: string }>[];
    }>
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
  // The pivot's row position belongs to the query state it was read for.
  const pivotValue = [...parameters].find(
    ([name]) => name.toLowerCase() === pivotParameter(placementId).toLowerCase(),
  )?.[1];
  if (change.kind === "drill") set(pivotParameter(placementId), undefined);
  else if (parseRecordsTablePivotView(pivotValue) !== undefined)
    set(pivotParameter(placementId), "on");
  const settleView = (): void => {
    // A selected view brings its own sort, filters and search only while the address names none:
    // once the person has cleared them all, the address says so explicitly. Grouping is not part
    // of a view's query state, so a grouped or flat address neither keeps nor clears the view's.
    const view = readRecordsTableView(placementId, parameters);
    if (view === undefined) return;
    const queried = [...parameters.keys()].some(
      (name) =>
        isRecordsTableParameterOf(placementId, name) &&
        ["sort.", "filter.", "search."].some((prefix) => name.toLowerCase().startsWith(prefix)),
    );
    set(viewParameter(placementId), queried ? view.viewId : `${view.viewId}${VIEW_CLEARED_SUFFIX}`);
  };
  switch (change.kind) {
    case "drill":
      for (const { fieldId, filter } of change.filters)
        set(`${filterPrefix(placementId)}${fieldId}`, filter === "" ? undefined : filter);
      settleView();
      return;
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
    case "group":
      // Back in the authored opening state, the parameter goes; otherwise it names the difference.
      set(
        groupParameter(placementId),
        change.opensGrouped
          ? change.fieldId === null
            ? GROUP_FLAT_VALUE
            : undefined
          : (change.fieldId ?? undefined),
      );
      applyRecordsTableGroupExpansion(parameters, placementId, null);
      return;
    case "groupPage":
      set(
        groupParameter(placementId),
        change.after === null
          ? change.opensGrouped
            ? undefined
            : change.fieldId
          : `${change.fieldId}.${toBase64Url(change.after)}`,
      );
      applyRecordsTableGroupExpansion(parameters, placementId, null);
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
    viewId: string | null;
    sort: readonly RecordsTableSortKey[];
    filters: readonly Readonly<{ fieldId: string; filter: string }>[];
    search: string | null;
  }> | null,
): void => {
  for (const name of [...parameters.keys()])
    if (isRecordsTableParameterOf(placementId, name)) parameters.delete(name);
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
  for (const name of [...parameters.keys()]) {
    const owner = addressParameterOwner(name);
    if (owner !== undefined && ADDRESS_PARAMETERS[owner.kind].part !== "calendar")
      parameters.delete(name);
  }
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
