import "server-only";

import {
  readRecordsTableContract,
  type BlockPropertyValueV2Contract,
  type ConditionNode,
  type IdentitySession,
  type JsonValue,
  type ModuleRootId,
  type OrganizationSelectionCandidate,
  type QueryId,
  type RecordsDisplayFormat,
} from "@vortex/contracts";
import type { HumanOrganizationRequestResult } from "@vortex/access";
import {
  protectedQueryCommandSchema,
  type ProtectedQueryCommand,
  type ProtectedQueryResult,
  type ProtectedQueryRow,
} from "@vortex/query";
import {
  projectRecordsTableData,
  type ProjectedComponentData,
  type ProjectedTableValues,
} from "./component-data-projection";

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
  settings: Readonly<Record<string, BlockPropertyValueV2Contract>>;
  pageParameters?: Readonly<Record<string, JsonValue>>;
  continuationToken?: string;
  /** Headings from the installed definition for declared columns that set no label (field identity to label). */
  fieldLabels?: Readonly<Record<string, string>>;
  /**
   * The viewer's chosen sort, from a `sort_changed` data event. It must be a declared sortable
   * field; `null` or absent uses the bound query's declared sort.
   */
  sort?: Readonly<{ fieldId: string; direction: "ascending" | "descending" }> | null;
  /**
   * The viewer's active per-field filters, from `filter_changed` data events. An empty value
   * clears that field; every named field must be a declared filterable field.
   */
  filters?: readonly Readonly<{ fieldId: string; value: string }>[];
  /**
   * The viewer's search text, from a `search_changed` data event. It is sent only when the
   * placement enables search; the engine matches it over the record type's searchable fields.
   */
  search?: string | null;
}>;

/**
 * A neutral refusal never distinguishes an undeclared table, a missing page value, a refused
 * query or a hidden fact, and is never an empty page. `unavailable` is a temporary failure the
 * placement may retry; the component then shows its declared error message.
 */
export type RecordsTableQueryResolution =
  | Readonly<{
      kind: "available";
      /** Declared columns, in order, as field identities; each row's values are keyed by them. */
      fieldIds: readonly string[];
      pageSize: number;
      rows: readonly ProtectedQueryRow[];
      /** The display payload projected from the rows and the declared contract; render this, never `rows`. */
      display: ProjectedComponentData<ProjectedTableValues>;
      nextContinuationToken?: string;
    }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "unavailable" }>;

const refused = Object.freeze({ kind: "refused" as const });
const unavailable = Object.freeze({ kind: "unavailable" as const });

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
  if (start.getUTCFullYear() !== year || start.getUTCMonth() !== month || start.getUTCDate() !== day)
    return undefined;
  const end = new Date(Date.UTC(year, month, day + 1));
  return [start.toISOString(), end.toISOString()];
};

/**
 * One `filter_changed` value as a typed condition over its field, chosen by the column's declared
 * format, which is also what picks the filter control. A text-like field matches a substring; a
 * number, date or yes/no field must equal the value the control reports; a date-and-time field
 * matches the whole reported calendar day, taken in UTC. An unparsable value yields undefined so the
 * command is refused rather than filtered loosely.
 */
const filterConditionFor = (
  format: RecordsDisplayFormat,
  fieldId: string,
  raw: string,
): ConditionNode | undefined => {
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

/**
 * Builds the Query engine command a declared Records table needs: exactly its declared columns,
 * its declared page size, its declared query inputs, and the viewer's current sort, filters and
 * search from the table's data events. Every user choice must stay inside the component's declared
 * sortable and filterable fields, so an unconfigured field can neither sort nor filter. Returns
 * undefined when the placement declares no data contract, a page-supplied input is missing, a user
 * choice names an undeclared or unreadable field, or the command is not one the Query engine accepts.
 */
export const buildRecordsTableQueryCommand = (
  request: RecordsTableQueryRequest,
): Readonly<{ command: ProtectedQueryCommand; fieldIds: readonly string[] }> | undefined => {
  const contract = readRecordsTableContract(request.settings);
  if (contract === undefined || contract.columns.length === 0) return undefined;
  const fieldIds = [...new Set(contract.columns.map((column) => column.field))];
  const inputValues: Record<string, JsonValue> = {};
  for (const parameter of contract.parameters) {
    const value =
      parameter.source === "fixed"
        ? parameter.fixedValue
        : parameter.pageParameter === undefined
          ? undefined
          : request.pageParameters?.[parameter.pageParameter];
    if (value === undefined) return undefined;
    inputValues[parameter.input] = value;
  }

  const sortableFieldIds = lowerUnique(contract.sortableFields);
  const filterableFieldIds = lowerUnique(contract.filterableFields);
  const sort: { fieldId: string; direction: "ascending" | "descending" }[] = [];
  if (request.sort !== undefined && request.sort !== null) {
    if (!sortableFieldIds.includes(request.sort.fieldId.toLowerCase())) return undefined;
    sort.push({ fieldId: request.sort.fieldId, direction: request.sort.direction });
  }
  const conditions: ConditionNode[] = [];
  for (const filter of request.filters ?? []) {
    if (filter.value === "") continue;
    const fieldId = filter.fieldId.toLowerCase();
    if (!filterableFieldIds.includes(fieldId)) return undefined;
    const column = contract.columns.find((candidate) => candidate.field.toLowerCase() === fieldId);
    if (column === undefined) return undefined;
    const condition = filterConditionFor(column.format, filter.fieldId, filter.value);
    if (condition === undefined) return undefined;
    conditions.push(condition);
  }
  const filter: ConditionNode | undefined =
    conditions.length === 0
      ? undefined
      : conditions.length === 1
        ? conditions[0]
        : { kind: "all", conditions };
  const search =
    contract.search && request.search !== undefined && request.search !== null && request.search.trim() !== ""
      ? request.search.trim()
      : undefined;

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
    ...(request.continuationToken === undefined
      ? {}
      : { continuationToken: request.continuationToken }),
  });
  return command.success ? { fieldIds, command: command.data } : undefined;
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
    if (built === undefined) return refused;
    try {
      const result = await runner.run(session, selection, built.command);
      if (result.kind === "temporarily_unavailable") return unavailable;
      if (result.kind !== "available" || result.value.outcome !== "completed") return refused;
      const display = projectRecordsTableData(
        {
          settings: request.settings,
          ...(request.fieldLabels === undefined ? {} : { fieldLabels: request.fieldLabels }),
        },
        result.value.rows,
      );
      if (display === undefined) return refused;
      return {
        kind: "available",
        fieldIds: built.fieldIds,
        display,
        pageSize: built.command.pageSize,
        rows: result.value.rows,
        ...(result.value.nextContinuationToken === undefined
          ? {}
          : { nextContinuationToken: result.value.nextContinuationToken }),
      };
    } catch {
      return unavailable;
    }
  },
});
