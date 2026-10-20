import "server-only";

import {
  describeFailure,
  unavailableResult,
  gridLayoutVisibleFieldIds,
  readRecordsTableContract,
  type BlockPropertyValueContract,
  type RecordsTableContract,
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
  protectedQueryGroupedMembersCommandSchema,
  protectedQuerySummaryCommandSchema,
  protectedQueryTreeLevelCommandSchema,
  type ProtectedQueryCommand,
  type ProtectedQueryFieldBounds,
  type ProtectedQueryGroupedMembersResult,
  type ProtectedQuerySummaryResult,
  type ProtectedQueryRefusalReasonCode,
  type ProtectedQueryResult,
  type ProtectedQueryRow,
  type ProtectedQueryTreeLevelCommand,
  type ProtectedQueryTreeLevelResult,
} from "../queries/index";
import {
  collectRecordLinks,
  projectRecordsTableData,
  type ProjectedComponentData,
  type ProjectedTableGroups,
  type ProjectedTableValues,
  type RecordLinkResolver,
  type RecordsTableNarrowing,
  type LinkFieldType,
} from "./component-data-projection";
import {
  conditionalFormattingFieldIds,
  logRecordsTableRequestRefusal,
  recordsTableNarrowingRefusal,
  recordsTableRequestRefusal,
  type ConditionalFormattingContext,
  type RecordsTableFeatureProjection,
  type RecordsTableInlineEditor,
  type RecordsTableRequestRefusal,
} from "./records-table-features";
import {
  projectRecordsTableGroups,
  recordsTableGroupSelector,
  RECORDS_TABLE_GROUP_READ_LIMIT,
  type RecordsTableGroupRead,
} from "./records-table-features/grouping";
import { CalendarEndpointError, calendarAddDays, calendarStartOfDay } from "./calendar-date";
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
  /** The counts of a grouped table's groups, in one bounded summary read. */
  summarise(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: unknown,
  ): Promise<HumanOrganizationRequestResult<ProtectedQuerySummaryResult>>;
  /** One page of the currently readable members of one group. */
  groupedMembers(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: unknown,
  ): Promise<HumanOrganizationRequestResult<ProtectedQueryGroupedMembersResult>>;
  /** One level of a tree: the roots or the children of one parent record. */
  treeLevel(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: ProtectedQueryTreeLevelCommand,
  ): Promise<HumanOrganizationRequestResult<ProtectedQueryTreeLevelResult>>;
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
  /** What the table's formatting rules are evaluated with; supplied only when they are on. */
  formatting?: ConditionalFormattingContext;
  /** How a cell edits each field of the installed definition; supplied only when inline editing is on. */
  fieldEditors?: Readonly<Record<string, RecordsTableInlineEditor>>;
  /**
   * Set when the table is a tree: the read is one level of it, the roots (no parent) or the
   * children of one record, `pageSize` at a time, over the link that names each record's parent.
   */
  tree?: Readonly<{ parentFieldId: string; parentRecordId: string | null; pageSize: number }>;
  /**
   * Set when the table is grouped: the read counts the groups in one summary and, when a group is
   * open, reads one page of its members through the table's own sort, filters, search and columns;
   * the table's page size is the one row budget the open group's page shares.
   */
  group?: RecordsTableGroupRead;
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

/** The rows with only the visible columns' values: a value read only for formatting never leaves. */
const visibleRows = (
  rows: readonly ProtectedQueryRow[],
  fieldIds: readonly string[],
): readonly ProtectedQueryRow[] =>
  rows.map((row) => ({
    ...row,
    values: Object.fromEntries(
      Object.entries(row.values).filter(([key]) => fieldIds.includes(key.toLowerCase())),
    ),
  }));

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
  if (filter.kind === "empty")
    return { kind: "comparison", operator: "is_empty", left: { source: "field", fieldId } };
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

/** The search and filters of one Records table request, built from the installed definition. */
export type RecordsTableNarrowingCommand = Readonly<{
  kind: "built";
  /** The declared filter fields the installed definition describes, for their filter controls. */
  filterFields: Readonly<Record<string, RecordsTableFilterField>>;
  appliedFilters: readonly RecordsTableFilterValue[];
  filter: JsonValue | undefined;
  search: string | undefined;
  filterableFieldIds: readonly string[];
}>;

/**
 * Validates the viewer's search and filters against the table's declared contract and builds the
 * condition the Query engine applies: a filter needs a field Column filters declares and a search
 * needs Search on. Both the page read and the pivot read narrow through this one function, so a
 * pivot totals exactly the records the table shows.
 */
export const buildRecordsTableNarrowing = (
  contract: RecordsTableContract,
  request: Pick<RecordsTableQueryRequest, "state" | "filterTargets" | "timeZone" | "fieldLabels">,
  filterableFieldIds: readonly string[] = lowerUnique(
    contract.features.columnFilters.enabled ? contract.features.columnFilters.fields : [],
  ),
): RecordsTableNarrowingCommand | RecordsTableRequestRefusal => {
  const { state } = request;
  const columnFilters = contract.features.columnFilters;
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
    let condition: JsonValue | undefined;
    try {
      condition = typedFilterCondition(target, fieldId, filter, request.timeZone);
    } catch (error) {
      if (!(error instanceof CalendarEndpointError)) throw error;
      return recordsTableRequestRefusal("filter", "value_out_of_range");
    }
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
  return { kind: "built", filterFields, appliedFilters, filter, search, filterableFieldIds };
};

/** A built Records table read: the Query command, its visible projection and its effective order. */
export type RecordsTableQueryCommand = Readonly<{
  kind: "built";
  command: ProtectedQueryCommand;
  /** The visible columns, in declared order; the rows the page returns carry only these values. */
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
  const narrowed = buildRecordsTableNarrowing(contract, request, filterableFieldIds);
  if (narrowed.kind === "refused") return narrowed;
  const { filterFields, appliedFilters, filter, search } = narrowed;

  // Fields only the formatting rules read are an optional projection: the engine returns each
  // under the viewer's field policy (absent where withheld) and never filters or sorts by it, so
  // the rules never change which rows the page holds. They are stripped after evaluation.
  const formattingFieldIds = conditionalFormattingFieldIds(contract).filter(
    (fieldId) => !fieldIds.includes(fieldId),
  );
  const command = protectedQueryCommandSchema.safeParse({
    moduleRootId: request.moduleRootId,
    queryId: request.queryId,
    inputValues,
    requestedFieldIds: [...fieldIds, ...formattingFieldIds],
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

/** The table without its Group by control, for a viewer the grouped read refused the field. */
const withoutGrouping = (values: ProjectedTableValues): ProjectedTableValues => {
  if (values.features?.grouping === undefined) return values;
  const features = Object.fromEntries(
    Object.entries(values.features).filter(([key]) => key !== "grouping"),
  ) as RecordsTableFeatureProjection;
  const rest = Object.fromEntries(
    Object.entries(values).filter(([key]) => key !== "features"),
  ) as ProjectedTableValues;
  return Object.keys(features).length === 0 ? rest : { ...rest, features };
};

/** The rows and bounds one grouped read returned, in the shape an ordinary page read has. */
type GroupedPage = Readonly<{
  rows: readonly ProtectedQueryRow[];
  fieldBounds: ProtectedQueryFieldBounds;
  nextContinuationToken?: string;
  previousContinuationToken?: string;
}>;

type GroupedRead =
  | Readonly<{ kind: "resolution"; resolution: RecordsTableQueryResolution }>
  /**
   * The groups cannot be counted for this viewer or this many records: read the page flat.
   * `withheld` says the summary refused the grouping field for this viewer, so the flat page
   * offers no Group by control that would only repeat the same refusal.
   */
  | Readonly<{ kind: "flat"; groups?: ProjectedTableGroups; withheld?: true }>
  | Readonly<{ kind: "read"; groups?: ProjectedTableGroups; page: GroupedPage }>;

/**
 * Reads a grouped table: one summary read counts every group (unless only the open group's page
 * is wanted), and a group that is open reads one page of its members. A closed table reads no
 * member. A viewer who cannot read the grouping field on every record, or a filtered set above
 * the summary's candidate limit, gets the ordinary page instead, so grouping never shows a value
 * the viewer may not read and the table stays usable.
 */
const readGrouped = async (
  runner: RecordsTableQueryRunner,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  request: RecordsTableQueryRequest,
  group: RecordsTableGroupRead,
  built: RecordsTableQueryCommand,
): Promise<GroupedRead> => {
  let groups: ProjectedTableGroups | undefined;
  let fieldBounds: ProtectedQueryFieldBounds | undefined;
  if (!group.membersOnly) {
    const summaryCommand = protectedQuerySummaryCommandSchema.safeParse({
      moduleRootId: request.moduleRootId,
      queryId: request.queryId,
      inputValues: request.inputValues,
      grouping: { fieldId: group.fieldId, limit: RECORDS_TABLE_GROUP_READ_LIMIT },
      ...(built.command.search === undefined ? {} : { search: built.command.search }),
      searchableFieldIds: built.command.searchableFieldIds,
      ...(built.command.filter === undefined ? {} : { filter: built.command.filter }),
      filterableFieldIds: built.command.filterableFieldIds,
    });
    if (!summaryCommand.success) {
      logRecordsTableRequestRefusal(
        recordsTableRequestRefusal("group", "summary_command_invalid"),
        "table_read",
      );
      return { kind: "resolution", resolution: refused };
    }
    const summary = await runner.summarise(session, selection, summaryCommand.data);
    if (summary.kind === "temporarily_unavailable")
      return { kind: "resolution", resolution: unavailableResult };
    if (summary.kind !== "available") return { kind: "resolution", resolution: refused };
    if (summary.value.outcome === "refused") {
      const reason = summary.value.reasonCode;
      if (reason === "dataset_limit_exceeded")
        return { kind: "flat", groups: { status: "too_many" } };
      if (reason === "field_unbounded") return { kind: "flat", withheld: true };
      return { kind: "resolution", resolution: { kind: "refused", reasonCode: reason } };
    }
    // More stored values than one grouped read counts (choices removed since records were saved):
    // the groups it returned would hide the rest, so the table stays flat until it is narrowed.
    if (summary.value.nextGroupKey !== undefined && summary.value.nextGroupKey !== null)
      return { kind: "flat", groups: { status: "too_many" } };
    fieldBounds = summary.value.fieldBounds;
    groups = projectRecordsTableGroups(
      summary.value,
      {
        fieldId: group.fieldId,
        unassignedLabel: group.unassignedLabel,
        options: request.fieldChoiceLabels?.[group.fieldId] ?? [],
      },
      group.expanded,
    );
    if (fieldBounds === undefined || groups === undefined)
      throw new Error("PROTECTED_QUERY_RESULT_INVALID");
  }
  // The open group: the one the summary counted, or the one a members-only read names.
  const opened =
    group.expanded === null || (groups?.status === "ready" && groups.expanded === undefined)
      ? undefined
      : group.expanded;
  if (opened === undefined) {
    if (group.membersOnly || fieldBounds === undefined)
      return { kind: "resolution", resolution: refused };
    return {
      kind: "read",
      ...(groups === undefined ? {} : { groups }),
      page: { rows: [], fieldBounds },
    };
  }
  const selector = recordsTableGroupSelector(group.fieldId, opened);
  // A group's members are never one exact record, so the grouped command has no such part.
  const memberBase: Record<string, unknown> = { ...built.command };
  delete memberBase["exactRecordId"];
  const memberCommand = protectedQueryGroupedMembersCommandSchema.safeParse({
    ...memberBase,
    selector,
    grouping: { fieldId: group.fieldId, limit: RECORDS_TABLE_GROUP_READ_LIMIT },
  });
  if (selector === undefined || !memberCommand.success) {
    logRecordsTableRequestRefusal(
      recordsTableRequestRefusal("group", "member_command_invalid"),
      "table_read",
    );
    return { kind: "resolution", resolution: refused };
  }
  const members = await runner.groupedMembers(session, selection, memberCommand.data);
  if (members.kind === "temporarily_unavailable")
    return { kind: "resolution", resolution: unavailableResult };
  if (members.kind !== "available") return { kind: "resolution", resolution: refused };
  if (members.value.outcome === "refused")
    return {
      kind: "resolution",
      resolution: { kind: "refused", reasonCode: members.value.reasonCode },
    };
  return {
    kind: "read",
    ...(groups === undefined ? {} : { groups }),
    page: {
      rows: members.value.rows,
      fieldBounds: members.value.fieldBounds,
      ...(members.value.nextContinuationToken === undefined
        ? {}
        : { nextContinuationToken: members.value.nextContinuationToken }),
      ...(members.value.previousContinuationToken === undefined
        ? {}
        : { previousContinuationToken: members.value.previousContinuationToken }),
    },
  };
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
      // The viewer's own search or filters list the matching records flat: a level narrowed on its
      // own would hide a matching record whose parent does not match, and no ancestor walk is run.
      const tree =
        request.tree?.parentRecordId === null &&
        (built.narrowing.search !== null || built.narrowing.filters.length > 0)
          ? undefined
          : request.tree;
      const treeCommand =
        tree === undefined
          ? undefined
          : protectedQueryTreeLevelCommandSchema.safeParse({
              ...built.command,
              pageSize: tree.pageSize,
              parentFieldId: tree.parentFieldId,
              parentRecordId: tree.parentRecordId,
            });
      if (treeCommand !== undefined && !treeCommand.success) {
        logRecordsTableRequestRefusal(
          // The cause stays in the log: which parts of the tree command failed and how.
          recordsTableRequestRefusal(
            "tree_level",
            `tree_command_invalid:${treeCommand.error.issues
              .map((issue) => `${issue.path.join(".")}/${issue.code}`)
              .join(",")}`,
          ),
          "table_read",
        );
        return refused;
      }
      const grouped =
        request.group === undefined
          ? undefined
          : await readGrouped(runner, session, selection, request, request.group, built);
      if (grouped?.kind === "resolution") return grouped.resolution;
      let result:
        | HumanOrganizationRequestResult<ProtectedQueryResult | ProtectedQueryTreeLevelResult>
        | undefined =
        grouped?.kind === "read"
          ? undefined
          : treeCommand === undefined
            ? await runner.run(session, selection, built.command)
            : await runner.treeLevel(session, selection, treeCommand.data);
      // A viewer who may not see the parent link on every record it may read has no tree: the
      // table lists its records flat, as a table without the feature does. That viewer's next page
      // carries a flat position, which the tree read refuses as stale before it reaches the field
      // check, so a refused position of the roots is read flat once as well; a flat read refuses a
      // tree position the same way.
      if (
        tree?.parentRecordId === null &&
        result !== undefined &&
        result.kind === "available" &&
        result.value.outcome === "refused" &&
        (result.value.reasonCode === "field_unbounded" ||
          (built.command.continuationToken !== undefined &&
            (result.value.reasonCode === "cursor_stale" ||
              result.value.reasonCode === "cursor_invalid")))
      )
        result = await runner.run(session, selection, built.command);
      if (result?.kind === "temporarily_unavailable") return unavailableResult;
      if (result !== undefined && result.kind !== "available") return refused;
      if (result?.value.outcome === "refused")
        return { kind: "refused", reasonCode: result.value.reasonCode };
      const read: GroupedPage | undefined =
        grouped?.kind === "read"
          ? grouped.page
          : result?.value.outcome === "completed"
            ? {
                rows: result.value.rows,
                fieldBounds: result.value.fieldBounds,
                ...(result.value.nextContinuationToken === undefined
                  ? {}
                  : { nextContinuationToken: result.value.nextContinuationToken }),
                ...(result.value.previousContinuationToken === undefined
                  ? {}
                  : { previousContinuationToken: result.value.previousContinuationToken }),
              }
            : undefined;
      if (read === undefined) return refused;
      const groups = grouped?.groups;
      const projectedRows = visibleRows(read.rows, built.fieldIds);
      // The records a link filter names are titled in the same batched read as the page's links.
      const filterLinks = built.narrowing.filters.flatMap(({ fieldId, filter }) => {
        const recordTypeId = request.filterTargets?.[fieldId]?.recordTypeId;
        return filter.kind !== "link" || recordTypeId === undefined
          ? []
          : filter.recordIds.map((recordId) => ({ recordTypeId, recordId }));
      });
      const links = [...collectRecordLinks(projectedRows), ...filterLinks];
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
          ...(request.formatting === undefined ? {} : { formatting: request.formatting }),
          ...(request.fieldEditors === undefined ? {} : { fieldEditors: request.fieldEditors }),
          ...(request.state.pivot === undefined ? {} : { pivotView: request.state.pivot }),
          ...(groups === undefined ? {} : { groups }),
        },
        read.rows,
        read.fieldBounds,
      );
      if (projected === undefined) return refused;
      // The projection that draws the controls also decides whether this read's own search and
      // filters were the viewer's to use; a refused read returns none of its rows.
      const narrowingRefusal = recordsTableNarrowingRefusal(
        projected.status === "ready" ? projected.values.features : undefined,
        built.narrowing,
      );
      if (narrowingRefusal !== undefined) {
        logRecordsTableRequestRefusal(narrowingRefusal, "table_read");
        return refused;
      }
      const nextContinuationToken = read.nextContinuationToken;
      const previousContinuationToken = read.previousContinuationToken;
      const display: ProjectedComponentData<ProjectedTableValues> =
        projected.status === "empty"
          ? projected
          : {
              status: "ready",
              values: {
                ...(grouped?.kind === "flat" && grouped.withheld === true
                  ? withoutGrouping(projected.values)
                  : projected.values),
                ...(built.sort === undefined ? {} : { sort: built.sort }),
                narrowing,
                page,
                hasNextPage: nextContinuationToken !== undefined,
                scanLimited: result.value.scanLimited,
                hasPreviousPage: previousContinuationToken !== undefined,
                ...(nextContinuationToken === undefined ? {} : { nextContinuationToken }),
                ...(previousContinuationToken === undefined ? {} : { previousContinuationToken }),
              },
            };
      return {
        kind: "available",
        fieldIds: built.fieldIds,
        display,
        pageSize: request.tree?.pageSize ?? built.command.pageSize,
        rows: projectedRows,
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
