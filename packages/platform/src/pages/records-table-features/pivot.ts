import "server-only";

import type { IdentitySession, OrganizationSelectionCandidate } from "../../access/identity-access";
import type { JsonValue } from "../../catalogue/common";
import { describeFailure } from "../../catalogue/runtime-primitives";
import { readQueryBindings } from "../../definition/application-composition/query-bindings";
import { recordsTableContractOrLog } from "../../definition/application-composition/records-display";
import { recordsTablePivotFeature } from "../../definition/application-composition/records-table-features";
import { UnreadableSettingError } from "../../definition/application-composition/records-table-features/shared";
import { moneyValueSchema, recordLinkValueSchema } from "../../records/module-field-values";
import type { HumanOrganizationRequestResult } from "../../access/human-organization-request";
import type { QueryContinuationKey } from "../../queries/continuation-token";
import type { InstalledRuntimeContext } from "../../definition/installed-runtime-context";
import {
  protectedQuerySummaryCommandSchema,
  type ProtectedQueryPivotResult,
  type ProtectedQuerySummaryResult,
} from "../../queries/protected-query-contracts";
import {
  fieldFilterTargetsOf,
  findModuleQuery,
  placementSettingsOf,
  type PlacementField,
  type PlacementReadEntry,
} from "../placement-read/shared";
import { summaryAggregateCellValue } from "../placement-read/summary-chart";
import {
  collectRecordLinkValues,
  recordLinkPlainText,
  type ProjectedRecordLinks,
  type RecordLinkResolver,
} from "../component-data-projection";
import { resolveQueryBindings, type QueryBindingContext } from "../query-binding-resolver";
import { buildRecordsTableNarrowing } from "../records-table-query";
import { resolveRecordsTableView } from "../placement-read/records-table-view";
import type { PlacementReadInput } from "../placement-read/types";
import { encodeRecordsTableFieldFilter, readRecordsTableQueryState } from "../records-table-state";
import { formatDecimal, formatMoney } from "../value-format";
import { openPivotCursor, sealPivotCursor, type PivotCursorBinding } from "./pivot-cursor";
import { bucketFirstDay, bucketLabel, bucketLastDay } from "./dimension-values";
import { logRecordsTableRequestRefusal, recordsTableRequestRefusal } from "./index";

/** The measure's alias in the summary; the pivot defines exactly one. */
const MEASURE_ALIAS = "pivot_measure";

/** One cell value a pivot shows: the same closed values a summary shows. */
export type PivotCell =
  | Readonly<{ kind: "number"; value: number; formatted: string }>
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "boolean"; value: boolean }>
  | Readonly<{ kind: "date"; iso: string }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "unavailable" }>;

/** The filter a click on a row or column heading applies to the ordinary grid, in address spelling. */
export type PivotDrill = Readonly<{ fieldId: string; filter: string }>;

export type PivotAxisValue = Readonly<{
  /** The canonical value text the server keys it by (a choice value or a bucket start). */
  key: string;
  label: string;
  drill?: PivotDrill;
}>;

export type PivotRow = PivotAxisValue &
  Readonly<{
    /** Records in this row. */
    count: number;
    /** One entry per column, null where the row holds no record of that column. */
    cells: readonly (PivotCell | null)[];
    total?: PivotCell;
  }>;

/**
 * One page of a pivot. A refusal carries a business sentence and nothing else; an error carries
 * nothing, so the panel cannot show values the read did not authorise. The cause stays in the log.
 */
export type PivotResult =
  | Readonly<{
      status: "ready";
      rowLabel: string;
      columnLabel: string;
      measureLabel: string;
      columns: readonly PivotAxisValue[];
      rows: readonly PivotRow[];
      /** Aligned with `columns`; present when the table shows totals. */
      columnTotals?: readonly PivotCell[];
      grandTotal?: PivotCell;
      totalRecords: number;
      rowGroupCount: number;
      /** Opaque position of the next page of rows; absent on the last page. */
      nextCursor?: string;
    }>
  | Readonly<{ status: "empty" }>
  | Readonly<{ status: "refused"; message: string }>
  | Readonly<{ status: "error" }>;

/** The one Query engine entry a pivot reads through: the protected summary. */
export type RecordsTablePivotQueryRunner = Readonly<{
  summarise(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: unknown,
  ): Promise<HumanOrganizationRequestResult<ProtectedQuerySummaryResult>>;
}>;

export type PivotRequest = Readonly<{
  context: InstalledRuntimeContext;
  session: IdentitySession;
  selection: OrganizationSelectionCandidate;
  /** The Records table placement of the viewer's current page projection. */
  placement: PlacementReadEntry;
  pageDefinition: PlacementReadInput["pageDefinition"];
  gridLayouts: PlacementReadInput["gridLayouts"];
  /** The page address, from which the table's own search and filters are read. */
  addressEntries: readonly (readonly [string, string])[];
  /** The sealed position of the first row of the page; absent reads the first rows. */
  cursor?: string;
  /** The page the table is on; a cursor is bound to it. */
  pageId: string;
  /** Seals and opens the pivot's row positions. */
  continuationKey: QueryContinuationKey;
  /** The page's binding context, from which the table query's inputs resolve. */
  bindings: QueryBindingContext;
  queries: RecordsTablePivotQueryRunner;
  /** The organisation's time zone, read only when a date dimension or filter needs it. */
  readTimeZone: () => Promise<string | undefined>;
  resolveRecordLinks: RecordLinkResolver;
}>;

const refused = (message: string): PivotResult => Object.freeze({ status: "refused", message });
const failed = Object.freeze({ status: "error" as const });

const refuse = (reason: string): PivotResult => {
  logRecordsTableRequestRefusal(
    recordsTableRequestRefusal("command", reason),
    recordsTablePivotFeature.key,
  );
  return refused("This pivot is not available.");
};

const fail = (cause: string): PivotResult => {
  console.error(`[records-table] pivot unavailable where=pivot cause=${cause}`);
  return failed;
};

type Dimension = Readonly<{
  field: PlacementField;
  unit?: string;
  /** The pivot setting that names this axis's calendar unit, for a refusal that has none. */
  unitSetting: "row_date_unit" | "column_date_unit";
  /** Whether a click on this dimension's heading can open the ordinary grid filtered to it. */
  drillable: boolean;
}>;

/**
 * Names and drill-down of one dimension value. A choice shows its installed label (a value the
 * field no longer offers shows as Other); a date shows its bucket; no value shows as Not set.
 */
const axisValue = (
  dimension: Dimension,
  value: JsonValue,
  timeZone: string | undefined,
  recordLinks: ProjectedRecordLinks | undefined,
): PivotAxisValue => {
  const key = JSON.stringify(value);
  if (value === null)
    return {
      key,
      label: "Not set",
      ...(dimension.drillable
        ? {
            drill: {
              fieldId: String(dimension.field.fieldId).toLowerCase(),
              filter: encodeRecordsTableFieldFilter({ kind: "empty" }),
            },
          }
        : {}),
    };
  if (dimension.field.type === "link") {
    if (value === "not_available") return { key, label: "Not available" };
    const link = recordLinkValueSchema.parse(value);
    return {
      key,
      label: recordLinkPlainText(link, recordLinks) ?? "Not available",
      ...(dimension.drillable
        ? {
            drill: {
              fieldId: String(dimension.field.fieldId).toLowerCase(),
              filter: encodeRecordsTableFieldFilter({ kind: "link", recordIds: [link.recordId] }),
            },
          }
        : {}),
    };
  }
  if (typeof value !== "string") throw new Error("PIVOT_AXIS_VALUE_INVALID");
  if (dimension.field.type === "choice") {
    const label = dimension.field.settings.options.find((option) => option.value === value)?.label;
    return {
      key,
      label: label ?? "Other",
      ...(!dimension.drillable || label === undefined
        ? {}
        : {
            drill: {
              fieldId: String(dimension.field.fieldId).toLowerCase(),
              filter: encodeRecordsTableFieldFilter({ kind: "choice", values: [value] }),
            },
          }),
    };
  }
  // Publication refuses a date axis without its calendar unit, so a read that has none is a defect
  // in what was published, never a unit to guess.
  const unit = dimension.unit;
  if (unit === undefined)
    throw new UnreadableSettingError(`features.pivot.${dimension.unitSetting}`);
  const start = bucketFirstDay(dimension.field.type, value, timeZone);
  return {
    key,
    label: bucketLabel(start, unit),
    ...(!dimension.drillable
      ? {}
      : {
          drill: {
            fieldId: String(dimension.field.fieldId).toLowerCase(),
            filter: encodeRecordsTableFieldFilter({
              kind: "date",
              from: start,
              to: bucketLastDay(start, unit),
            }),
          },
        }),
  };
};

const measureNames: Readonly<Record<string, string>> = {
  count: "Count of records",
  sum: "Total",
  average: "Average",
  minimum: "Lowest",
  maximum: "Highest",
};

/**
 * Reads one page of a pivot: the table's records, filtered by the table's own search and filters,
 * as rows crossed with columns. One protected summary statement returns the cells of the page's
 * rows with every row, column and grand total over the whole filtered set, under the viewer's
 * current access and field policy; this function only names and formats what that statement
 * returned. A forged dimension, a field the viewer cannot read, too many columns or too many
 * records is refused by the engine, and the refusal here carries a business sentence, not a value.
 */
export const readRecordsTablePivot = async (request: PivotRequest): Promise<PivotResult> => {
  const { context, placement } = request;
  const settings = placementSettingsOf(placement);
  const contract = recordsTableContractOrLog(settings, recordsTablePivotFeature.key);
  const feature = contract?.features.pivot;
  if (contract === undefined || feature === undefined || !feature.enabled)
    return refuse("feature_off");
  const { rowField, columnField, measureFunction, measureField, rowPageSize, totals } = feature;
  if (
    rowField === undefined ||
    columnField === undefined ||
    measureFunction === undefined ||
    rowPageSize === undefined
  )
    return refuse("feature_incomplete");
  const bound =
    typeof placement.vortex.queryId === "string"
      ? findModuleQuery(context, placement.vortex.queryId)
      : undefined;
  if (bound === undefined) return refuse("query_not_installed");
  const fields = new Map(
    bound.module.content.recordTypes.flatMap((recordType) =>
      recordType.fields.map((field) => [String(field.fieldId).toLowerCase(), field] as const),
    ),
  );
  const row = fields.get(rowField.toLowerCase());
  const column = fields.get(columnField.toLowerCase());
  const measure = measureField === undefined ? undefined : fields.get(measureField.toLowerCase());
  if (
    row === undefined ||
    column === undefined ||
    (measureField !== undefined && measure === undefined)
  )
    return refuse("field_not_installed");

  const addressed = readRecordsTableQueryState(placement.placementId, request.addressEntries);
  if (addressed.kind === "malformed") return refuse(`table_state_malformed ${addressed.part}`);
  const view = resolveRecordsTableView({
    contract,
    placementId: placement.placementId,
    bound,
    pageDefinition: request.pageDefinition,
    gridLayouts: request.gridLayouts,
    addressEntries: request.addressEntries,
    state: addressed.state,
  });
  if (view === undefined) return refuse("table_columns_withheld");
  const columnFilters = contract.features.columnFilters;
  const filterable = new Set(
    columnFilters.enabled ? columnFilters.fields.map((field) => field.toLowerCase()) : [],
  );
  const filterTargets = fieldFilterTargetsOf(bound.module);
  const usesDates =
    [row, column].some((field) => field.type === "date" || field.type === "date_time") ||
    view.state.filters.some(
      (filter) => filterTargets[filter.fieldId.toLowerCase()]?.type === "date_time",
    );
  let timeZone: string | undefined;
  if (usesDates) {
    try {
      timeZone = await request.readTimeZone();
    } catch (error) {
      return fail(`time_zone ${describeFailure(error)}`);
    }
    if (timeZone === undefined) return fail("time_zone_unavailable");
  }
  const narrowing = buildRecordsTableNarrowing(contract, {
    state: view.state,
    filterTargets,
    ...(timeZone === undefined ? {} : { timeZone }),
  });
  if (narrowing.kind === "refused") {
    logRecordsTableRequestRefusal(narrowing, recordsTablePivotFeature.key);
    return refused("This pivot is not available.");
  }

  const bindings = readQueryBindings(settings);
  if (bindings.kind === "malformed") return refuse("bindings_malformed");
  const resolution = await resolveQueryBindings(
    bindings.bindings,
    bound.query.inputs,
    request.bindings,
    {},
    (cause) => console.error(`[records-table] pivot input withheld where=pivot cause=${cause}`),
  );
  if (resolution.kind === "awaiting") return { status: "empty" };
  if (resolution.kind === "refused")
    return refuse(`binding ${resolution.part} ${resolution.reason}`);

  const bucket = (field: PlacementField, unit: string | undefined) =>
    (field.type !== "date" && field.type !== "date_time") || unit === undefined
      ? undefined
      : { unit, timeZone: timeZone ?? "UTC" };
  const rowBucket = bucket(row, feature.rowDateUnit);
  const columnBucket = bucket(column, feature.columnDateUnit);
  const query = {
    mode: "pivot",
    moduleRootId: bound.module.rootId,
    queryId: bound.query.queryId,
    inputValues: resolution.inputValues,
    pivot: {
      rowFieldId: String(row.fieldId).toLowerCase(),
      ...(rowBucket === undefined ? {} : { rowDateBucket: rowBucket }),
      columnFieldId: String(column.fieldId).toLowerCase(),
      ...(columnBucket === undefined ? {} : { columnDateBucket: columnBucket }),
      measure:
        measureFunction === "count"
          ? { operation: "count" }
          : { operation: measureFunction, fieldId: String(measure!.fieldId).toLowerCase() },
      rowLimit: rowPageSize,
    },
    ...(narrowing.search === undefined ? {} : { search: narrowing.search }),
    searchableFieldIds: [],
    ...(narrowing.filter === undefined ? {} : { filter: narrowing.filter }),
    filterableFieldIds: narrowing.filterableFieldIds,
  };
  const binding: PivotCursorBinding = {
    session: request.session,
    selection: request.selection,
    installationRevision: context.applicationReleaseRevision,
    pageId: request.pageId,
    placementId: placement.placementId,
    query,
  };
  // A cursor that is not exactly for this read (other filters, person, release, a tampered token)
  // is stale: the cause is logged and the pivot starts again at its first page.
  let after: string | undefined;
  if (request.cursor !== undefined) {
    const opening = openPivotCursor(request.cursor, request.continuationKey, binding);
    if (opening.kind === "stale")
      logRecordsTableRequestRefusal(
        recordsTableRequestRefusal("cursor", `cursor_stale ${opening.cause}`),
        recordsTablePivotFeature.key,
      );
    else after = opening.groupKey;
  }
  const command = protectedQuerySummaryCommandSchema.safeParse({
    ...query,
    ...(after === undefined ? {} : { groupAfter: after }),
  });
  if (!command.success) return refuse("command_invalid");

  let result: HumanOrganizationRequestResult<ProtectedQuerySummaryResult>;
  try {
    result = await request.queries.summarise(request.session, request.selection, command.data);
  } catch (error) {
    return fail(`summary_threw ${describeFailure(error)}`);
  }
  if (result.kind === "temporarily_unavailable") return fail("summary_unavailable");
  if (result.kind !== "available") return refuse("summary_not_available");
  const summary = result.value;
  if (summary.outcome === "refused") {
    logRecordsTableRequestRefusal(
      recordsTableRequestRefusal("command", `summary_refused code=${summary.reasonCode}`),
      recordsTablePivotFeature.key,
    );
    switch (summary.reasonCode) {
      case "pivot_columns_exceeded":
        return refused(
          "This pivot has more than 50 column values, which is too many to show. Narrow the records with search or filters.",
        );
      case "dataset_limit_exceeded":
        return refused(
          "There are too many records to pivot at once. Narrow them with search or filters.",
        );
      case "value_out_of_range":
        return refused(
          "Some dates in these records fall in a period that reaches past the supported years 0001 to 9999. Narrow them with search or filters, or group the dates by a shorter period.",
        );
      case "field_unbounded":
        return refused("You can't see every field this pivot needs.");
      default:
        return refused("This pivot is not available.");
    }
  }
  const pivot = summary.pivot as ProtectedQueryPivotResult | undefined;
  if (pivot === undefined) return fail("pivot_missing");
  if (summary.totalRowCount === 0 && pivot.rows.length === 0) return { status: "empty" };

  const aggregate = {
    operation: measureFunction,
    alias: MEASURE_ALIAS,
    ...(measure === undefined ? {} : { fieldId: String(measure.fieldId) }),
  } as unknown as Parameters<typeof summaryAggregateCellValue>[0];
  const cellOf = (
    aggregates: ProtectedQueryPivotResult["rows"][number]["aggregates"],
  ): PivotCell => {
    const measured = aggregates[MEASURE_ALIAS];
    if (measured === undefined) throw new Error("PIVOT_MEASURE_MISSING");
    // Money shows as the viewer's formatted amount, like every other money value.
    if (measure?.type === "money" && measured.outcome === "completed" && measured.valueCount > 0) {
      const money = moneyValueSchema.safeParse(measured.value);
      if (money.success) return { kind: "text", text: formatMoney(money.data) };
    }
    const cell = summaryAggregateCellValue(aggregate, measure, measured);
    if (cell === undefined) {
      throw new Error("PIVOT_MEASURE_INVALID");
    }
    return cell.kind === "number" ? { ...cell, formatted: formatDecimal(cell.value) } : cell;
  };
  const links = collectRecordLinkValues([
    ...pivot.columns.map((entry) => entry.value),
    ...pivot.rows.map((entry) => entry.value),
  ]);
  const recordLinks = links.length === 0 ? undefined : await request.resolveRecordLinks(links);
  if (links.length > 0 && recordLinks === undefined) return fail("link_labels_unavailable");

  const rowDimension: Dimension = {
    field: row,
    ...(feature.rowDateUnit === undefined ? {} : { unit: feature.rowDateUnit }),
    unitSetting: "row_date_unit",
    drillable: filterable.has(String(row.fieldId).toLowerCase()),
  };
  const columnDimension: Dimension = {
    field: column,
    ...(feature.columnDateUnit === undefined ? {} : { unit: feature.columnDateUnit }),
    unitSetting: "column_date_unit",
    drillable: filterable.has(String(column.fieldId).toLowerCase()),
  };
  const columns = pivot.columns.map((entry) =>
    axisValue(columnDimension, entry.value, timeZone, recordLinks),
  );
  const columnIndex = new Map(columns.map((entry, index) => [entry.key, index] as const));
  const rows: PivotRow[] = pivot.rows.map((entry) => {
    const cells: (PivotCell | null)[] = columns.map(() => null);
    for (const cell of entry.cells) {
      const index = columnIndex.get(JSON.stringify(cell.column));
      if (index !== undefined) cells[index] = cellOf(cell.aggregates);
    }
    return {
      ...axisValue(rowDimension, entry.value, timeZone, recordLinks),
      count: entry.rowCount,
      cells,
      ...(totals ? { total: cellOf(entry.aggregates) } : {}),
    };
  });
  const next = summary.nextGroupKey;
  return {
    status: "ready",
    rowLabel: String(row.label),
    columnLabel: String(column.label),
    measureLabel:
      measure === undefined
        ? measureNames["count"]!
        : `${measureNames[measureFunction] ?? measureFunction} of ${String(measure.label)}`,
    columns,
    rows,
    ...(totals
      ? {
          columnTotals: pivot.columns.map((entry) => cellOf(entry.aggregates)),
          grandTotal: cellOf(summary.aggregates),
        }
      : {}),
    totalRecords: summary.totalRowCount,
    rowGroupCount: pivot.rowGroupCount,
    ...(next === null || next === undefined
      ? {}
      : { nextCursor: sealPivotCursor(request.continuationKey, binding, next) }),
  };
};
