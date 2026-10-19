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
  readRecordsTableFieldFilter,
  recordsTableFilterKindOf,
  type RecordsTableFieldFilter,
  type RecordsTableFilterField,
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
import { calendarAddDays, calendarStartOfDay } from "./calendar-query";
import { recordLinkLabelKey } from "../definition/app-index";

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
 * the request already resolved; `inputValues` are the query inputs the table's bindings resolved
 * on the server for this request (see `resolveQueryBindings`). The Query engine runs installed Module
 * queries, so `moduleRootId` and `queryId` must name the exact query the placement is bound to;
 * a caller never substitutes another query for one it cannot resolve.
 */
export type RecordsTableQueryRequest = Readonly<{
  moduleRootId: ModuleRootId;
  queryId: QueryId;
  settings: Readonly<Record<string, BlockPropertyValueContract>>;
  inputValues: Readonly<Record<string, JsonValue>>;
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
  /**
   * The installed facts of every field of the bound record type a filter may name (field identity
   * to type, options, currency and link target); a filter on a field without one is refused.
   */
  filterTargets?: Readonly<Record<string, RecordsTableFilterTarget>>;
  /**
   * The organisation's time zone, read only when a date-and-time field is filterable: its days
   * are taken in this zone. A date-and-time filter without it is refused.
   */
  timeZone?: string;
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
 * What the installed definition says about one field a filter may name: its canonical type, its
 * business name, a choice field's options, a money field's fixed currency and a link field's
 * target record type. The server builds every condition from this, never from the browser.
 */
export type RecordsTableFilterTarget = Readonly<{
  type: string;
  label: string;
  options?: readonly Readonly<{ value: string; label: string }>[];
  currency?: string;
  recordTypeId?: string;
}>;

/**
 * A number bound as the engine compares it: a safe integer as a JSON number, which matches
 * whole-number and decimal fields alike, and any other exact decimal as its canonical text, which is
 * how the engine carries a decimal value. The bound is already canonical, so nothing is rounded.
 */
const exactNumberOperand = (bound: string): number | string => {
  if (bound.includes(".")) return bound;
  const value = Number(bound);
  return Number.isSafeInteger(value) ? value : bound;
};

const comparison = (
  operator:
    "contains" | "equals" | "in" | "greater_than_or_equal" | "less_than_or_equal" | "less_than",
  fieldId: string,
  value: JsonValue,
): JsonValue => ({
  kind: "comparison",
  operator,
  left: { source: "field", fieldId },
  right: { source: "value", value },
});

const allOf = (conditions: readonly JsonValue[]): JsonValue =>
  conditions.length === 1 ? conditions[0]! : { kind: "all", conditions: [...conditions] };

/**
 * One typed filter as a Query condition over its field, chosen by the field's canonical type. The
 * filter's kind must be the one that type takes; a choice must name the field's own options, a
 * money range the field's fixed currency, and a link filter records of the field's target type. A
 * date-and-time range takes whole days in the organisation's time zone: from the first instant of
 * its start day (inclusive) to the first instant after its end day (exclusive). Returns undefined
 * for anything else, so the request is refused rather than filtered loosely.
 */
const typedFilterCondition = (
  target: RecordsTableFilterTarget,
  fieldId: string,
  filter: RecordsTableFieldFilter,
  timeZone: string | undefined,
): JsonValue | undefined => {
  if (recordsTableFilterKindOf(target.type) !== filter.kind) return undefined;
  switch (filter.kind) {
    case "text":
      return comparison("contains", fieldId, filter.text);
    case "choice": {
      const offered = target.options ?? [];
      if (!filter.values.every((value) => offered.some((option) => option.value === value)))
        return undefined;
      return target.type === "several_choices"
        ? {
            kind: "any",
            conditions: filter.values.map((value) => comparison("contains", fieldId, value)),
          }
        : comparison("in", fieldId, [...filter.values]);
    }
    case "number":
      return allOf([
        ...(filter.from === undefined
          ? []
          : [comparison("greater_than_or_equal", fieldId, exactNumberOperand(filter.from))]),
        ...(filter.to === undefined
          ? []
          : [comparison("less_than_or_equal", fieldId, exactNumberOperand(filter.to))]),
      ]);
    case "money": {
      if (target.currency !== undefined && target.currency !== filter.currency) return undefined;
      const money = (amount: string): JsonValue => ({ amount, currency: filter.currency });
      return allOf([
        ...(filter.from === undefined
          ? []
          : [comparison("greater_than_or_equal", fieldId, money(filter.from))]),
        ...(filter.to === undefined
          ? []
          : [comparison("less_than_or_equal", fieldId, money(filter.to))]),
      ]);
    }
    case "date": {
      if (target.type === "date")
        return allOf([
          ...(filter.from === undefined
            ? []
            : [comparison("greater_than_or_equal", fieldId, filter.from)]),
          ...(filter.to === undefined
            ? []
            : [comparison("less_than_or_equal", fieldId, filter.to)]),
        ]);
      if (timeZone === undefined) return undefined;
      return allOf([
        ...(filter.from === undefined
          ? []
          : [
              comparison(
                "greater_than_or_equal",
                fieldId,
                calendarStartOfDay(filter.from, timeZone),
              ),
            ]),
        ...(filter.to === undefined
          ? []
          : [
              comparison(
                "less_than",
                fieldId,
                calendarStartOfDay(calendarAddDays(filter.to, 1), timeZone),
              ),
            ]),
      ]);
    }
    case "link":
      return target.recordTypeId === undefined
        ? undefined
        : comparison(
            "in",
            fieldId,
            filter.recordIds.map((recordId) => ({
              recordTypeId: target.recordTypeId!.toLowerCase(),
              recordId,
            })),
          );
    case "yes_no":
      return comparison("equals", fieldId, filter.value);
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
  /** The declared filter fields the installed definition describes, for their filter controls. */
  filterFields: Readonly<Record<string, RecordsTableFilterField>>;
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
 * declares no data contract, any part of the state is outside the
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
  const inputValues = request.inputValues;

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
  const filterFields = Object.fromEntries(
    filterableFieldIds.flatMap((fieldId): [string, RecordsTableFilterField][] => {
      const target = request.filterTargets?.[fieldId];
      const kind = target === undefined ? undefined : recordsTableFilterKindOf(target.type);
      if (target === undefined || kind === undefined) return [];
      if (target.type === "date_time" && request.timeZone === undefined) return [];
      return [
        [
          fieldId,
          {
            fieldId,
            label: request.fieldLabels?.[fieldId] ?? target.label,
            type: target.type,
            kind,
            ...(target.options === undefined ? {} : { options: target.options }),
            ...(target.currency === undefined ? {} : { currency: target.currency }),
            ...(target.type === "date_time" && request.timeZone !== undefined
              ? { timeZone: request.timeZone }
              : {}),
          },
        ],
      ];
    }),
  );
  const conditions: JsonValue[] = [];
  const appliedFilters: RecordsTableFilterValue[] = [];
  for (const requested of state.filters) {
    const fieldId = requested.fieldId.toLowerCase();
    if (!filterableFieldIds.includes(fieldId))
      return recordsTableRequestRefusal(
        "filter",
        columnFilters.enabled ? "field_not_filterable" : "feature_off",
      );
    if (appliedFilters.some((held) => held.fieldId === fieldId))
      return recordsTableRequestRefusal("filter", "field_filtered_twice");
    // The address is never trusted: the filter is validated again and built from the installed field.
    const filter = readRecordsTableFieldFilter(requested.filter);
    const target = request.filterTargets?.[fieldId];
    if (filter === undefined) return recordsTableRequestRefusal("filter", "value_malformed");
    if (target === undefined) return recordsTableRequestRefusal("filter", "field_not_installed");
    const condition = typedFilterCondition(target, fieldId, filter, request.timeZone);
    if (condition === undefined) return recordsTableRequestRefusal("filter", "value_not_for_field");
    conditions.push(condition);
    appliedFilters.push({ fieldId, filter });
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
        filterFields,
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
      // The records a link filter names are titled in the same batched read as the page's links.
      const filterLinks = built.narrowing.filters.flatMap(({ fieldId, filter }) => {
        const recordTypeId = request.filterTargets?.[fieldId]?.recordTypeId;
        return filter.kind !== "link" || recordTypeId === undefined
          ? []
          : filter.recordIds.map((recordId) => ({ recordTypeId, recordId }));
      });
      const links = [...collectRecordLinks(result.value.rows), ...filterLinks];
      const recordLinks =
        links.length === 0 || request.resolveRecordLinks === undefined
          ? undefined
          : await request.resolveRecordLinks(links);
      const narrowing: RecordsTableNarrowing =
        filterLinks.length === 0
          ? built.narrowing
          : {
              ...built.narrowing,
              recordTitles: Object.fromEntries(
                filterLinks.map((link) => {
                  const label = recordLinks?.get(recordLinkLabelKey(link));
                  return [
                    link.recordId,
                    label?.kind === "record_link" ? label.label : "Restricted record",
                  ];
                }),
              ),
            };
      const page = request.state.page?.page ?? 1;
      const projected = projectRecordsTableData(
        request.layout,
        {
          settings: request.settings,
          filterFields: built.filterFields,
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
                narrowing,
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
