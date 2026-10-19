import "server-only";

import {
  describeFailure,
  unavailableResult,
  gridLayoutVisibleFieldIds,
  readRecordsTableContract,
  type BlockPropertyValueContract,
  type GridLayoutState,
  type IdentitySession,
  type JsonValue,
  type ModuleRootId,
  type OrganizationSelectionCandidate,
  type QueryId,
  type RecordsDisplayFormat,
  type RecordsTableFilterValue,
  type RecordsTableQueryState,
  type RecordsTableSortKey,
  type RecordsTableSortState,
} from "../schema";
import type { HumanOrganizationRequestResult } from "../access/index";
import {
  protectedQueryCommandSchema,
  type ProtectedQueryCommand,
  type ProtectedQueryRefusalReasonCode,
  type ProtectedQueryResult,
  type ProtectedQueryRow,
} from "../queries/index";
import {
  collectRecordLinks,
  projectRecordsTableData,
  type ProjectedComponentData,
  type ProjectedTableValues,
  type RecordLinkResolver,
  type RecordsTableNarrowing,
  type LinkFieldType,
} from "./component-data-projection";
import {
  logRecordsTableRequestRefusal,
  recordsTableRequestRefusal,
  type RecordsTableRequestRefusal,
} from "./records-table-features";

/**
 * The one Query engine entry point a Records table reads through. The composition root supplies
 * the protected query service's `run`, which authorises the viewer's current authority itself, so
 * this module adds no authority and reads no tables.
 */
export type RecordsTableQueryRunner = Readonly<{
  run(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: ProtectedQueryCommand,
  ): Promise<HumanOrganizationRequestResult<ProtectedQueryResult>>;
}>;

/**
 * One Records table read. The module, query and compiled settings come from the installed release
 * the request already resolved; `pageParameters` are the values the current page supplies for
 * parameters the table declares as taken from the page. The Query engine runs installed Module
 * queries, so `moduleRootId` and `queryId` must name the exact query the placement is bound to;
 * a caller never substitutes another query for one it cannot resolve.
 */
export type RecordsTableQueryRequest = Readonly<{
  moduleRootId: ModuleRootId;
  queryId: QueryId;
  settings: Readonly<Record<string, BlockPropertyValueContract>>;
  pageParameters?: Readonly<Record<string, JsonValue>>;
  /**
   * The viewer's query state from the page address: ordered sort, filters, search and the requested
   * page. Every part is validated here against the installed placement's declared contract;
   * nothing in it widens what the placement declares.
   */
  state: RecordsTableQueryState;
  /**
   * The viewer's layout of this grid, already resolved against the declared columns: the read
   * requests exactly the columns it shows, and the page carries it back to the grid.
   */
  layout: GridLayoutState;
  /** Headings from the installed definition for declared columns that set no label (field identity to label). */
  fieldLabels?: Readonly<Record<string, string>>;
  /** Labels of the choices each choice field offers (field identity to options). */
  fieldChoiceLabels?: Readonly<
    Record<string, readonly Readonly<{ value: string; label: string }>[]>
  >;
  /** The date and date-time fields of the installed definition (field identity to field type). */
  fieldDateTypes?: Readonly<Record<string, "date" | "date_time">>;
  /** The web, email and phone fields of the installed definition (field identity to field type). */
  fieldLinkTypes?: Readonly<Record<string, LinkFieldType>>;
  /** Reads the labels of the linked records the page's rows carry, once per page. */
  resolveRecordLinks?: RecordLinkResolver;
}>;

/**
 * A refusal is never an empty page. The Query engine's closed reason code is retained only for
 * server-side diagnostics; the component receives the same neutral refusal for every cause.
 * `unavailable` is a temporary failure the placement may retry.
 */
export type RecordsTableQueryResolution =
  | Readonly<{
      kind: "available";
      /** The visible columns, in declared order, as field identities; rows carry only these values. */
      fieldIds: readonly string[];
      pageSize: number;
      rows: readonly ProtectedQueryRow[];
      /** The display payload projected from the rows and the declared contract; render this, never `rows`. */
      display: ProjectedComponentData<ProjectedTableValues>;
      nextContinuationToken?: string;
      previousContinuationToken?: string;
    }>
  | Readonly<{ kind: "refused"; reasonCode?: ProtectedQueryRefusalReasonCode }>
  | Readonly<{ kind: "unavailable" }>;

const refused = Object.freeze({ kind: "refused" as const });

const lowerUnique = (values: readonly string[]): string[] => [
  ...new Set(values.map((value) => value.toLowerCase())),
];

/**
 * A number filter value as the engine compares it: a safe integer as a JSON number, which matches
 * whole-number and decimal fields alike, and any other plain decimal as canonical decimal text (no
 * exponent, no leading or trailing zeros), which is how the engine carries a decimal field's value.
 * Anything else is undefined, so the command is refused rather than filtered loosely.
 */
const numberFilterValue = (raw: string): number | string | undefined => {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(raw.trim());
  if (match === null) return undefined;
  const sign = match[1] ?? "";
  const whole = (match[2] ?? "").replace(/^0+(?=[0-9])/, "");
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  if (fraction !== "") return `${sign}${whole}.${fraction}`;
  const value = Number(whole);
  if (!Number.isSafeInteger(value)) return undefined;
  return sign === "-" && value !== 0 ? -value : value;
};

const ISO_CALENDAR_DAY = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** The UTC start of a calendar day and of the next one, or undefined for an invalid date. */
const utcDayBounds = (raw: string): readonly [string, string] | undefined => {
  const match = ISO_CALENDAR_DAY.exec(raw);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const start = new Date(Date.UTC(year, month, day));
  if (
    start.getUTCFullYear() !== year ||
    start.getUTCMonth() !== month ||
    start.getUTCDate() !== day
  )
    return undefined;
  const end = new Date(Date.UTC(year, month, day + 1));
  return [start.toISOString(), end.toISOString()];
};

/**
 * One `filter_changed` value as a typed condition over its field, chosen by the column's declared
 * format, which is also what picks the filter control. A text-like field matches a substring; a
 * number, date or yes/no field must equal the value the control reports; a date-and-time field
 * matches the whole reported calendar day, taken in UTC. An unparsable value yields undefined so the
 * command is refused rather than filtered loosely. The condition is plain JSON: the Query command
 * schema parses it into a typed condition, so a malformed one refuses the command.
 */
const filterConditionFor = (
  format: RecordsDisplayFormat,
  fieldId: string,
  raw: string,
): JsonValue | undefined => {
  const left = { source: "field" as const, fieldId: fieldId.toLowerCase() };
  switch (format) {
    case "number":
    case "currency":
    case "percent": {
      const value = numberFilterValue(raw);
      return value === undefined
        ? undefined
        : { kind: "comparison", operator: "equals", left, right: { source: "value", value } };
    }
    case "boolean":
      return raw === "true" || raw === "false"
        ? {
            kind: "comparison",
            operator: "equals",
            left,
            right: { source: "value", value: raw === "true" },
          }
        : undefined;
    case "date":
      return utcDayBounds(raw) === undefined
        ? undefined
        : { kind: "comparison", operator: "equals", left, right: { source: "value", value: raw } };
    case "date_time": {
      const bounds = utcDayBounds(raw);
      return bounds === undefined
        ? undefined
        : {
            kind: "all",
            conditions: [
              {
                kind: "comparison",
                operator: "greater_than_or_equal",
                left,
                right: { source: "value", value: bounds[0] },
              },
              {
                kind: "comparison",
                operator: "less_than",
                left,
                right: { source: "value", value: bounds[1] },
              },
            ],
          };
    }
    default:
      return {
        kind: "comparison",
        operator: "contains",
        left,
        right: { source: "value", value: raw },
      };
  }
};

/** A built Records table read: the Query command, its visible projection and its effective order. */
export type RecordsTableQueryCommand = Readonly<{
  kind: "built";
  command: ProtectedQueryCommand;
  /** The visible columns, in declared order; exactly the fields the command requests. */
  fieldIds: readonly string[];
  /** The explicit or authored default order; undefined when the bound query's own sort applies. */
  sort?: RecordsTableSortState;
  /** The search and filters the command applies. */
  narrowing: RecordsTableNarrowing;
}>;

/**
 * Builds the Query engine command a declared Records table needs: exactly the columns the viewer's
 * layout shows, its declared page size, its declared query inputs, and the viewer's current sort,
 * filters, search and page from the table's query state. The shown columns must be a nonempty
 * subset of the declared columns; a sort key
 * must be a declared sortable field and a filter a declared filterable field, so an unconfigured
 * field can neither sort, filter nor be returned. The effective order is the viewer's sort, else
 * the authored default sort, else the bound query's own sort; the engine appends the record
 * identity tie-breaker once. A sorted or filtered field need not be visible: the engine evaluates
 * it under the current field policy without returning its value. Search and filters are grid
 * features: a search needs the Search feature on and a filter a field the Column filters feature
 * declares, so a request for a feature that is off is refused, whatever the browser sends. Returns
 * a typed refusal (the request part and its cause, logged by the caller) when the placement
 * declares no data contract, a page-supplied input is missing, any part of the state is outside the
 * declared contract, or the command is not one the Query engine accepts.
 */
export const buildRecordsTableQueryCommand = (
  request: RecordsTableQueryRequest,
): RecordsTableQueryCommand | RecordsTableRequestRefusal => {
  const contract = readRecordsTableContract(request.settings);
  if (contract === undefined || contract.columns.length === 0)
    return recordsTableRequestRefusal("contract", "contract_unreadable");
  const { state } = request;
  const declaredFieldIds = [
    ...new Set(contract.columns.map((column) => column.field.toLowerCase())),
  ];
  const requestedVisible = gridLayoutVisibleFieldIds(request.layout.layout);
  const visibleSet = new Set(requestedVisible.map((fieldId) => fieldId.toLowerCase()));
  if (
    visibleSet.size === 0 ||
    visibleSet.size !== requestedVisible.length ||
    [...visibleSet].some((fieldId) => !declaredFieldIds.includes(fieldId))
  )
    return recordsTableRequestRefusal("columns", "visible_columns_not_declared");
  const fieldIds = declaredFieldIds.filter((fieldId) => visibleSet.has(fieldId));
  const inputValues: Record<string, JsonValue> = {};
  for (const parameter of contract.parameters) {
    const value =
      parameter.source === "fixed"
        ? parameter.fixedValue
        : parameter.pageParameter === undefined
          ? undefined
          : request.pageParameters?.[parameter.pageParameter];
    if (value === undefined) return recordsTableRequestRefusal("parameters", "input_missing");
    inputValues[parameter.input] = value;
  }

  const sortableFieldIds = lowerUnique(contract.sortableFields);
  const columnFilters = contract.features.columnFilters;
  const filterableFieldIds = lowerUnique(columnFilters.enabled ? columnFilters.fields : []);
  const explicit = state.sort.length > 0;
  const keys: readonly RecordsTableSortKey[] = explicit
    ? state.sort
    : contract.defaultSort.map((key) => ({ fieldId: key.field, direction: key.direction }));
  const sortFieldIds = lowerUnique(keys.map((key) => key.fieldId));
  if (
    sortFieldIds.length !== keys.length ||
    sortFieldIds.some((fieldId) => !sortableFieldIds.includes(fieldId))
  )
    return recordsTableRequestRefusal("sort", "sort_field_not_sortable");
  const sort = keys.map((key) => ({
    fieldId: key.fieldId.toLowerCase(),
    direction: key.direction,
  }));
  const conditions: JsonValue[] = [];
  const appliedFilters: RecordsTableFilterValue[] = [];
  for (const filter of state.filters) {
    if (filter.value === "") continue;
    const fieldId = filter.fieldId.toLowerCase();
    if (!filterableFieldIds.includes(fieldId))
      return recordsTableRequestRefusal(
        "filter",
        columnFilters.enabled ? "field_not_filterable" : "feature_off",
      );
    const column = contract.columns.find((candidate) => candidate.field.toLowerCase() === fieldId);
    if (column === undefined) return recordsTableRequestRefusal("filter", "field_not_a_column");
    const condition = filterConditionFor(column.format, filter.fieldId, filter.value);
    if (condition === undefined) return recordsTableRequestRefusal("filter", "value_unparsable");
    conditions.push(condition);
    appliedFilters.push({ fieldId, value: filter.value });
  }
  const filter: JsonValue | undefined =
    conditions.length === 0
      ? undefined
      : conditions.length === 1
        ? conditions[0]
        : { kind: "all", conditions };
  if (state.search !== null && !contract.features.search.enabled)
    return recordsTableRequestRefusal("search", "feature_off");
  const search =
    state.search === null || state.search.trim() === "" ? undefined : state.search.trim();

  const command = protectedQueryCommandSchema.safeParse({
    moduleRootId: request.moduleRootId,
    queryId: request.queryId,
    inputValues,
    requestedFieldIds: fieldIds,
    requestedSystemFieldKeys: [],
    sort,
    ...(filter === undefined ? {} : { filter }),
    ...(search === undefined ? {} : { search }),
    sortableFieldIds,
    filterableFieldIds,
    // The table contract declares only a search box, not a searchable field list, so an empty
    // declared set tells the engine to search every field the record type marks searchable.
    searchableFieldIds: [],
    pageSize: contract.pageSize,
    ...(state.page === undefined ? {} : { pageDirection: state.page.pageDirection }),
    ...(state.page?.continuationToken === undefined
      ? {}
      : { continuationToken: state.page.continuationToken }),
  });
  return command.success
    ? {
        kind: "built",
        fieldIds,
        command: command.data,
        ...(sort.length === 0 ? {} : { sort: { keys: sort, explicit } }),
        narrowing: { search: search ?? null, filters: appliedFilters },
      }
    : recordsTableRequestRefusal("command", "query_command_invalid");
};

/**
 * Runs a Records table's query directly through the Query engine. The component never fetches
 * data itself, and no data flow is involved unless a builder adds transform or write steps.
 */
export const createRecordsTableQueryResolver = (runner: RecordsTableQueryRunner) => ({
  async resolve(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    request: RecordsTableQueryRequest,
  ): Promise<RecordsTableQueryResolution> {
    const built = buildRecordsTableQueryCommand(request);
    if (built.kind === "refused") {
      logRecordsTableRequestRefusal(built, "table_read");
      return refused;
    }
    try {
      const result = await runner.run(session, selection, built.command);
      if (result.kind === "temporarily_unavailable") return unavailableResult;
      if (result.kind !== "available") return refused;
      if (result.value.outcome === "refused")
        return { kind: "refused", reasonCode: result.value.reasonCode };
      const links = collectRecordLinks(result.value.rows);
      const recordLinks =
        links.length === 0 || request.resolveRecordLinks === undefined
          ? undefined
          : await request.resolveRecordLinks(links);
      const page = request.state.page?.page ?? 1;
      const projected = projectRecordsTableData(
        request.layout,
        {
          settings: request.settings,
          ...(recordLinks === undefined ? {} : { recordLinks }),
          ...(request.fieldLabels === undefined ? {} : { fieldLabels: request.fieldLabels }),
          ...(request.fieldChoiceLabels === undefined
            ? {}
            : { fieldChoiceLabels: request.fieldChoiceLabels }),
          ...(request.fieldDateTypes === undefined
            ? {}
            : { fieldDateTypes: request.fieldDateTypes }),
          ...(request.fieldLinkTypes === undefined
            ? {}
            : { fieldLinkTypes: request.fieldLinkTypes }),
        },
        result.value.rows,
        // A later page, or a narrowed first page, keeps its columns when nothing matched, so the
        // viewer can page back or change the search and filters that matched nothing.
        page > 1 || built.narrowing.search !== null || built.narrowing.filters.length > 0,
      );
      if (projected === undefined) return refused;
      const nextContinuationToken = result.value.nextContinuationToken;
      const previousContinuationToken = result.value.previousContinuationToken;
      const display: ProjectedComponentData<ProjectedTableValues> =
        projected.status === "empty"
          ? projected
          : {
              status: "ready",
              values: {
                ...projected.values,
                ...(built.sort === undefined ? {} : { sort: built.sort }),
                narrowing: built.narrowing,
                page,
                hasNextPage: nextContinuationToken !== undefined,
                hasPreviousPage: previousContinuationToken !== undefined,
                ...(nextContinuationToken === undefined ? {} : { nextContinuationToken }),
                ...(previousContinuationToken === undefined ? {} : { previousContinuationToken }),
              },
            };
      return {
        kind: "available",
        fieldIds: built.fieldIds,
        display,
        pageSize: built.command.pageSize,
        rows: result.value.rows,
        ...(nextContinuationToken === undefined ? {} : { nextContinuationToken }),
        ...(previousContinuationToken === undefined ? {} : { previousContinuationToken }),
      };
    } catch (error) {
      console.error(
        `[records-table] query unavailable code=PROTECTED_QUERY_FAILED cause=${describeFailure(error)}`,
      );
      return unavailableResult;
    }
  },
});
