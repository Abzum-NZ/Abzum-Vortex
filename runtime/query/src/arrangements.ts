import "server-only";

import {
  compareExactDecimals,
  parseExactDecimal,
  type JsonValue,
} from "@vortex/contracts";
import type { ProtectedQueryRow } from "./protected-query-contracts";
import {
  arrangementCommandSchema,
  boardArrangementDescriptorSchema,
  calendarArrangementDescriptorSchema,
  summaryArrangementDescriptorSchema,
  tableArrangementDescriptorSchema,
  type ArrangementCommand,
  type ArrangementDataset,
  type ArrangementRefusal,
  type ArrangementResult,
  type BoardArrangementDescriptor,
  type BoardArrangementResult,
  type BoardColumn,
  type CalendarArrangementDescriptor,
  type CalendarArrangementResult,
  type CalendarItem,
  type SummaryArrangementDescriptor,
  type SummaryArrangementResult,
  type SummaryGroup,
  type TableArrangementDescriptor,
  type TableArrangementResult,
  type TableGroup,
} from "./arrangement-contracts";
import { computeAggregates } from "./exact-aggregation";

/**
 * Projects only declared fields from row values.
 * Fields not declared are stripped.
 */
export const projectDeclaredFields = (
  values: Readonly<Record<string, JsonValue>>,
  declaredFieldIds: readonly string[],
): Record<string, JsonValue> => {
  const projected: Record<string, JsonValue> = {};
  for (const fieldId of declaredFieldIds) {
    if (Object.prototype.hasOwnProperty.call(values, fieldId)) {
      projected[fieldId] = values[fieldId]!;
    }
  }
  return projected;
};

const projectRow = (
  row: ProtectedQueryRow,
  declaredFieldIds: readonly string[],
): ProtectedQueryRow => ({
  recordId: row.recordId,
  values: projectDeclaredFields(row.values, declaredFieldIds),
});

/**
 * Deterministically compares two group values records across groupByFieldIds.
 */
export const compareGroupValues = (
  left: Readonly<Record<string, JsonValue>>,
  right: Readonly<Record<string, JsonValue>>,
  groupByFieldIds: readonly string[],
): number => {
  for (const fieldId of groupByFieldIds) {
    const l = left[fieldId];
    const r = right[fieldId];
    if (l === r) continue;
    if (l === undefined || l === null) return 1;
    if (r === undefined || r === null) return -1;

    if (typeof l === "number" && typeof r === "number") {
      if (l !== r) return l < r ? -1 : 1;
      continue;
    }

    if (typeof l === "string" && typeof r === "string") {
      const dl = parseExactDecimal(l);
      const dr = parseExactDecimal(r);
      if (dl !== undefined && dr !== undefined) {
        const cmp = compareExactDecimals(dl, dr);
        if (cmp !== 0) return cmp;
        continue;
      }
      const cmp = l.localeCompare(r);
      if (cmp !== 0) return cmp;
      continue;
    }

    const sl = JSON.stringify(l);
    const sr = JSON.stringify(r);
    const cmp = sl.localeCompare(sr);
    if (cmp !== 0) return cmp;
  }
  return 0;
};

const buildGroupKey = (
  values: Readonly<Record<string, JsonValue>>,
  groupByFieldIds: readonly string[],
): string => {
  return groupByFieldIds
    .map((fieldId) => {
      const v = values[fieldId];
      if (v === undefined || v === null) return "\0null";
      if (typeof v === "object") return JSON.stringify(v);
      return String(v);
    })
    .join("::");
};

/**
 * Pure table arrangement transform.
 * Emits either flat table rows or deterministic table groups with group-level
 * and overall aggregates.
 */
export const arrangeTable = (
  dataset: ArrangementDataset,
  descriptorInput: TableArrangementDescriptor,
): TableArrangementResult | ArrangementRefusal => {
  const parsedDescriptor = tableArrangementDescriptorSchema.safeParse(descriptorInput);
  if (!parsedDescriptor.success) {
    return {
      outcome: "refused",
      reasonCode: "descriptor_invalid",
      message: parsedDescriptor.error.message,
    };
  }
  const descriptor = parsedDescriptor.data;
  const { declaredFieldIds, groupByFieldIds, aggregates } = descriptor;

  // Ungrouped flat table
  if (!groupByFieldIds || groupByFieldIds.length === 0) {
    const projectedRows = dataset.rows.map((row) =>
      projectRow(row, declaredFieldIds),
    );
    const computedAggregates = computeAggregates(dataset.rows, aggregates ?? []);
    return {
      outcome: "completed",
      arrangement: "table",
      plan: dataset.plan,
      declaredFieldIds,
      totalRowCount: dataset.rows.length,
      grouped: false,
      rows: projectedRows,
      aggregates: computedAggregates,
    };
  }

  // Grouped table
  const groupMap = new Map<
    string,
    { groupValues: Record<string, JsonValue>; rows: ProtectedQueryRow[] }
  >();

  for (const row of dataset.rows) {
    const groupValues: Record<string, JsonValue> = {};
    for (const fieldId of groupByFieldIds) {
      groupValues[fieldId] = row.values[fieldId] ?? null;
    }
    const key = buildGroupKey(groupValues, groupByFieldIds);
    let entry = groupMap.get(key);
    if (!entry) {
      entry = { groupValues, rows: [] };
      groupMap.set(key, entry);
    }
    entry.rows.push(row);
  }

  const rawGroups = Array.from(groupMap.entries()).map(([groupKey, entry]) => ({
    groupKey,
    groupValues: entry.groupValues,
    rows: entry.rows,
  }));

  // Deterministic ordering of groups
  rawGroups.sort((a, b) =>
    compareGroupValues(a.groupValues, b.groupValues, groupByFieldIds),
  );

  const tableGroups: TableGroup[] = rawGroups.map((g) => {
    const projectedGroupRows = g.rows.map((row) =>
      projectRow(row, declaredFieldIds),
    );
    const groupAggregates = computeAggregates(g.rows, aggregates ?? []);
    return {
      groupKey: g.groupKey,
      groupValues: g.groupValues,
      rowCount: g.rows.length,
      rows: projectedGroupRows,
      aggregates: groupAggregates,
    };
  });

  const overallAggregates = computeAggregates(dataset.rows, aggregates ?? []);

  return {
    outcome: "completed",
    arrangement: "table",
    plan: dataset.plan,
    declaredFieldIds,
    totalRowCount: dataset.rows.length,
    grouped: true,
    groupByFieldIds,
    groups: tableGroups,
    overallAggregates,
  };
};

/**
 * Pure board arrangement transform.
 * Groups records into columns by a filterable choice field with at most twelve options.
 */
export const arrangeBoard = (
  dataset: ArrangementDataset,
  descriptorInput: BoardArrangementDescriptor,
): BoardArrangementResult | ArrangementRefusal => {
  const parsedDescriptor = boardArrangementDescriptorSchema.safeParse(descriptorInput);
  if (!parsedDescriptor.success) {
    const hasTooManyOptions =
      Array.isArray(descriptorInput.choiceOptions) &&
      descriptorInput.choiceOptions.length > 12;
    return {
      outcome: "refused",
      reasonCode: hasTooManyOptions
        ? "choice_options_exceeded"
        : "descriptor_invalid",
      message: parsedDescriptor.error.message,
    };
  }
  const descriptor = parsedDescriptor.data;

  if (descriptor.choiceOptions.length > 12) {
    return {
      outcome: "refused",
      reasonCode: "choice_options_exceeded",
      message: "A board groups records by a choice field with no more than twelve options",
    };
  }

  const columnMap = new Map<
    string,
    { label: string; rows: ProtectedQueryRow[] }
  >();

  for (const opt of descriptor.choiceOptions) {
    columnMap.set(opt.value, {
      label: opt.label ?? opt.value,
      rows: [],
    });
  }

  const unassignedRows: ProtectedQueryRow[] = [];

  for (const row of dataset.rows) {
    const choiceVal = row.values[descriptor.choiceFieldId];
    if (typeof choiceVal === "string" && columnMap.has(choiceVal)) {
      columnMap.get(choiceVal)!.rows.push(row);
    } else {
      unassignedRows.push(row);
    }
  }

  const columns: BoardColumn[] = [];

  for (const opt of descriptor.choiceOptions) {
    const entry = columnMap.get(opt.value)!;
    const projectedRows = entry.rows.map((row) =>
      projectRow(row, descriptor.declaredFieldIds),
    );
    const aggregates = computeAggregates(entry.rows, descriptor.aggregates ?? []);
    columns.push({
      columnId: opt.value,
      label: entry.label,
      rowCount: entry.rows.length,
      rows: projectedRows,
      aggregates,
    });
  }

  // Include unassigned column if requested or present
  if (
    descriptor.includeUnassignedColumn !== false &&
    unassignedRows.length > 0
  ) {
    const projectedRows = unassignedRows.map((row) =>
      projectRow(row, descriptor.declaredFieldIds),
    );
    const aggregates = computeAggregates(
      unassignedRows,
      descriptor.aggregates ?? [],
    );
    columns.push({
      columnId: "__unassigned__",
      label: "Unassigned",
      rowCount: unassignedRows.length,
      rows: projectedRows,
      aggregates,
    });
  }

  const overallAggregates = computeAggregates(
    dataset.rows,
    descriptor.aggregates ?? [],
  );

  return {
    outcome: "completed",
    arrangement: "board",
    plan: dataset.plan,
    choiceFieldId: descriptor.choiceFieldId,
    declaredFieldIds: descriptor.declaredFieldIds,
    totalRowCount: dataset.rows.length,
    columns,
    overallAggregates,
  };
};

const computeCalendarEnd = (
  start: string,
  durationValue: JsonValue,
  unit: "minutes" | "hours" | "days",
): string | null => {
  let durationAmount: number;
  if (typeof durationValue === "number" && Number.isFinite(durationValue)) {
    durationAmount = durationValue;
  } else if (typeof durationValue === "string") {
    const parsed = Number(durationValue);
    if (Number.isFinite(parsed)) {
      durationAmount = parsed;
    } else {
      return null;
    }
  } else {
    return null;
  }

  // Handle simple ISO date (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(start) && unit === "days") {
    const startDate = new Date(`${start}T00:00:00.000Z`);
    if (Number.isNaN(startDate.getTime())) return null;
    const endMs = startDate.getTime() + durationAmount * 86_400_000;
    return new Date(endMs).toISOString().slice(0, 10);
  }

  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) return null;

  const unitMs =
    unit === "minutes" ? 60_000 : unit === "hours" ? 3_600_000 : 86_400_000;
  const endMs = startDate.getTime() + durationAmount * unitMs;
  return new Date(endMs).toISOString();
};

/**
 * Pure calendar arrangement transform.
 * Uses explicit start/end or start-plus-duration mapping to project scheduled items
 * and unscheduled rows with deterministic ordering.
 */
export const arrangeCalendar = (
  dataset: ArrangementDataset,
  descriptorInput: CalendarArrangementDescriptor,
): CalendarArrangementResult | ArrangementRefusal => {
  const parsedDescriptor =
    calendarArrangementDescriptorSchema.safeParse(descriptorInput);
  if (!parsedDescriptor.success) {
    return {
      outcome: "refused",
      reasonCode: "calendar_mapping_invalid",
      message: parsedDescriptor.error.message,
    };
  }
  const descriptor = parsedDescriptor.data;
  const { calendarMapping, declaredFieldIds, timeZone = "UTC" } = descriptor;

  const items: CalendarItem[] = [];
  const unscheduledRows: ProtectedQueryRow[] = [];

  for (const row of dataset.rows) {
    const startVal = row.values[calendarMapping.startFieldId];
    if (typeof startVal !== "string" || startVal.trim() === "") {
      unscheduledRows.push(projectRow(row, declaredFieldIds));
      continue;
    }

    let endVal: string | null = null;
    if (calendarMapping.kind === "start_end") {
      const rawEnd = row.values[calendarMapping.endFieldId];
      if (typeof rawEnd === "string" && rawEnd.trim() !== "") {
        endVal = rawEnd;
      }
    } else if (calendarMapping.kind === "start_duration") {
      const rawDuration = row.values[calendarMapping.durationFieldId];
      endVal = computeCalendarEnd(
        startVal,
        rawDuration,
        calendarMapping.durationUnit,
      );
    }

    items.push({
      recordId: row.recordId,
      start: startVal,
      end: endVal,
      values: projectDeclaredFields(row.values, declaredFieldIds),
    });
  }

  // Deterministic sorting of items: start ascending, recordId ascending
  items.sort((a, b) => {
    const cmp = a.start.localeCompare(b.start);
    if (cmp !== 0) return cmp;
    return a.recordId.localeCompare(b.recordId);
  });

  // Deterministic sorting of unscheduled rows: recordId ascending
  unscheduledRows.sort((a, b) => a.recordId.localeCompare(b.recordId));

  return {
    outcome: "completed",
    arrangement: "calendar",
    plan: dataset.plan,
    calendarMapping,
    timeZone,
    declaredFieldIds,
    totalRowCount: dataset.rows.length,
    scheduledItemCount: items.length,
    unscheduledRowCount: unscheduledRows.length,
    items,
    unscheduledRows,
  };
};

/**
 * Pure summary arrangement transform.
 * Computes compatible aggregates and optional group breakdowns with exact decimals.
 */
export const arrangeSummary = (
  dataset: ArrangementDataset,
  descriptorInput: SummaryArrangementDescriptor,
): SummaryArrangementResult | ArrangementRefusal => {
  const parsedDescriptor =
    summaryArrangementDescriptorSchema.safeParse(descriptorInput);
  if (!parsedDescriptor.success) {
    return {
      outcome: "refused",
      reasonCode: "descriptor_invalid",
      message: parsedDescriptor.error.message,
    };
  }
  const descriptor = parsedDescriptor.data;
  const { aggregates, groupByFieldIds } = descriptor;

  const overallAggregates = computeAggregates(dataset.rows, aggregates);

  if (!groupByFieldIds || groupByFieldIds.length === 0) {
    return {
      outcome: "completed",
      arrangement: "summary",
      plan: dataset.plan,
      totalRowCount: dataset.rows.length,
      grouped: false,
      aggregates: overallAggregates,
    };
  }

  const groupMap = new Map<
    string,
    { groupValues: Record<string, JsonValue>; rows: ProtectedQueryRow[] }
  >();

  for (const row of dataset.rows) {
    const groupValues: Record<string, JsonValue> = {};
    for (const fieldId of groupByFieldIds) {
      groupValues[fieldId] = row.values[fieldId] ?? null;
    }
    const key = buildGroupKey(groupValues, groupByFieldIds);
    let entry = groupMap.get(key);
    if (!entry) {
      entry = { groupValues, rows: [] };
      groupMap.set(key, entry);
    }
    entry.rows.push(row);
  }

  const rawGroups = Array.from(groupMap.entries()).map(([groupKey, entry]) => ({
    groupKey,
    groupValues: entry.groupValues,
    rows: entry.rows,
  }));

  rawGroups.sort((a, b) =>
    compareGroupValues(a.groupValues, b.groupValues, groupByFieldIds),
  );

  const groups: SummaryGroup[] = rawGroups.map((g) => ({
    groupKey: g.groupKey,
    groupValues: g.groupValues,
    rowCount: g.rows.length,
    aggregates: computeAggregates(g.rows, aggregates),
  }));

  return {
    outcome: "completed",
    arrangement: "summary",
    plan: dataset.plan,
    totalRowCount: dataset.rows.length,
    grouped: true,
    groupByFieldIds,
    groups,
    aggregates: overallAggregates,
  };
};

/**
 * Unified arrangement dispatcher.
 * Validates command and dispatches to table, board, calendar, or summary arrangement.
 */
export const arrangeDataset = (commandCandidate: unknown): ArrangementResult => {
  const parsed = arrangementCommandSchema.safeParse(commandCandidate);
  if (!parsed.success) {
    return {
      outcome: "refused",
      reasonCode: "descriptor_invalid",
      message: parsed.error.message,
    };
  }

  const { dataset, descriptor } = parsed.data;

  switch (descriptor.type) {
    case "table":
      return arrangeTable(dataset, descriptor);
    case "board":
      return arrangeBoard(dataset, descriptor);
    case "calendar":
      return arrangeCalendar(dataset, descriptor);
    case "summary":
      return arrangeSummary(dataset, descriptor);
  }
};
