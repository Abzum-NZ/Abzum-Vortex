import "server-only";

import type { z } from "zod";
import {
  compareExactDecimals,
  moduleFieldValueV2Schemas,
  parseExactDecimal,
  type JsonValue,
} from "@vortex/contracts";
import type { HumanOrganizationRequestResult } from "@vortex/access";
import {
  arrangementCommandSchema,
  arrangementRowLimit,
  protectedBoardArrangementCommandSchema,
  protectedBoardArrangementPageSchema,
  protectedBoardArrangementResultSchema,
  summaryArrangementResultSchema,
  type AggregateDescriptor,
  type AggregateResult,
  type ArrangementField,
  type ArrangementRefusal,
  type ArrangementRefusalReasonCode,
  type ArrangementResult,
  type ArrangementRow,
  type BoardArrangementDescriptor,
  type BoardArrangementResult,
  type CalendarArrangementDescriptor,
  type CalendarArrangementResult,
  type CalendarItem,
  type ProtectedBoardArrangementPage,
  type ProtectedBoardArrangementResult,
  summaryArrangementCommandSchema,
  type TableArrangementDescriptor,
  type TableArrangementResult,
} from "./arrangement-contracts";
import {
  protectedQueryBoardSummaryResultSchema,
  protectedQueryResultSchema,
  type ProtectedQueryBoardSelector,
} from "./protected-query-contracts";
import type { createProtectedQueryService } from "./protected-query-service";
import { aggregateSupportsFieldType, computeAggregates } from "./exact-aggregation";

type FieldType = ArrangementField["type"];
type Values = Readonly<Record<string, JsonValue>>;
type FieldTypes = ReadonlyMap<string, FieldType>;

const refusal = (reasonCode: ArrangementRefusalReasonCode): ArrangementRefusal => ({
  outcome: "refused",
  reasonCode,
});

const lower = (id: string): string => id.toLowerCase();
const codeUnitOrder = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const valuesOf = (row: ArrangementRow): Values => row.values as Values;
const present = (value: JsonValue | undefined): value is Exclude<JsonValue, null> =>
  value !== undefined && value !== null;

/** Field types whose single value can name a group. */
const groupableTypes: ReadonlySet<FieldType> = new Set([
  "text",
  "whole_number",
  "decimal_number",
  "yes_no",
  "date",
  "date_time",
  "choice",
  "reference_number",
  "email_address",
  "phone_number",
  "web_address",
  "link",
  "link_to_one_of_several",
  "link_to_person",
]);

// Plan validation

/**
 * Keeps only the plan's fields the arrangement declared, keyed by lower-case id,
 * and checks every present value against its declared field type. A repeated
 * record or a value unlike its type refuses the whole arrangement.
 */
const validateRows = (
  rows: readonly ArrangementRow[],
  declared: readonly string[],
  fieldTypes: FieldTypes,
): readonly ArrangementRow[] | undefined => {
  const recordIds = new Set<string>();
  const validated: ArrangementRow[] = [];
  for (const row of rows) {
    const recordId = lower(row.recordId);
    if (recordIds.has(recordId)) return undefined;
    recordIds.add(recordId);

    const supplied = new Map<string, JsonValue>();
    for (const [fieldId, value] of Object.entries(valuesOf(row))) {
      const key = lower(fieldId);
      if (supplied.has(key)) return undefined;
      supplied.set(key, value);
    }
    const values: Record<string, JsonValue> = {};
    for (const fieldId of declared) {
      const value = supplied.get(fieldId);
      if (value === undefined) continue;
      const schema: z.ZodType = moduleFieldValueV2Schemas[fieldTypes.get(fieldId)!];
      if (value !== null && !schema.safeParse(value).success) return undefined;
      values[fieldId] = value;
    }
    validated.push({ recordId: row.recordId, values: values as ArrangementRow["values"] });
  }
  return validated;
};

/** Every named field must be declared, and every aggregate must suit its field type. */
const validateUse = (
  declared: ReadonlySet<string>,
  fieldTypes: FieldTypes,
  groupByFieldIds: readonly string[],
  aggregates: readonly AggregateDescriptor[],
): boolean =>
  groupByFieldIds.every(
    (fieldId) => declared.has(lower(fieldId)) && groupableTypes.has(fieldTypes.get(lower(fieldId))!),
  ) &&
  aggregates.every((aggregate) =>
    aggregate.fieldId === undefined
      ? aggregate.operation === "count"
      : declared.has(lower(aggregate.fieldId)) &&
        aggregateSupportsFieldType(aggregate.operation, fieldTypes.get(lower(aggregate.fieldId))!),
  );

// Grouping

const groupKeyPart = (value: JsonValue | undefined, type: FieldType): JsonValue => {
  if (!present(value)) return null;
  if (type === "link" || type === "link_to_one_of_several") {
    const link = value as Readonly<{ recordTypeId: string; recordId: string }>;
    return [lower(link.recordTypeId), lower(link.recordId)];
  }
  if (type === "link_to_person")
    return lower((value as Readonly<{ organizationAccountId: string }>).organizationAccountId);
  return value;
};

/** Typed value order for group sorting; missing values sort last. */
const compareFieldValues = (
  left: JsonValue | undefined,
  right: JsonValue | undefined,
  type: FieldType,
): number => {
  if (!present(left) || !present(right)) return present(left) ? -1 : present(right) ? 1 : 0;
  switch (type) {
    case "whole_number":
      return (left as number) < (right as number) ? -1 : (left as number) > (right as number) ? 1 : 0;
    case "decimal_number":
      return compareExactDecimals(parseExactDecimal(left)!, parseExactDecimal(right)!);
    case "yes_no":
      return left === right ? 0 : left === false ? -1 : 1;
    case "date_time": {
      const difference = Date.parse(left as string) - Date.parse(right as string);
      return difference < 0 ? -1 : difference > 0 ? 1 : codeUnitOrder(left as string, right as string);
    }
    case "link":
    case "link_to_one_of_several":
    case "link_to_person":
      return codeUnitOrder(JSON.stringify(groupKeyPart(left, type)), JSON.stringify(groupKeyPart(right, type)));
    default:
      return codeUnitOrder(left as string, right as string);
  }
};

type RowGroup = { groupKey: string; groupValues: Record<string, JsonValue>; rows: ArrangementRow[] };

/** Groups rows by the typed values of the grouping fields, in deterministic group order. */
const groupRows = (
  rows: readonly ArrangementRow[],
  groupByFieldIds: readonly string[],
  fieldTypes: FieldTypes,
): readonly RowGroup[] => {
  const groups = new Map<string, RowGroup>();
  for (const row of rows) {
    const values = valuesOf(row);
    const groupKey = JSON.stringify(
      groupByFieldIds.map((fieldId) => groupKeyPart(values[fieldId], fieldTypes.get(fieldId)!)),
    );
    let group = groups.get(groupKey);
    if (group === undefined) {
      const groupValues: Record<string, JsonValue> = {};
      for (const fieldId of groupByFieldIds) groupValues[fieldId] = values[fieldId] ?? null;
      group = { groupKey, groupValues, rows: [] };
      groups.set(groupKey, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()].sort((left, right) => {
    for (const fieldId of groupByFieldIds) {
      const order = compareFieldValues(
        left.groupValues[fieldId],
        right.groupValues[fieldId],
        fieldTypes.get(fieldId)!,
      );
      if (order !== 0) return order;
    }
    return codeUnitOrder(left.groupKey, right.groupKey);
  });
};

const projectRow = (row: ArrangementRow, declaredFieldIds: readonly string[]): ArrangementRow => {
  const values = valuesOf(row);
  const projected: Record<string, JsonValue> = {};
  for (const fieldId of declaredFieldIds)
    if (Object.prototype.hasOwnProperty.call(values, fieldId)) projected[fieldId] = values[fieldId]!;
  return { recordId: row.recordId, values: projected as ArrangementRow["values"] };
};

type Plan = Readonly<{
  plan: TableArrangementResult["plan"];
  rows: readonly ArrangementRow[];
  declaredFieldIds: readonly string[];
  fieldTypes: FieldTypes;
}>;

// Arrangements

const arrangeTable = (
  { plan, rows, declaredFieldIds, fieldTypes }: Plan,
  descriptor: TableArrangementDescriptor,
): TableArrangementResult => {
  const groupByFieldIds = descriptor.groupByFieldIds.map(lower);
  const aggregate = (subset: readonly ArrangementRow[]): Record<string, AggregateResult> =>
    computeAggregates(subset, descriptor.aggregates, fieldTypes);
  const grouped = groupByFieldIds.length > 0;
  return {
    outcome: "completed",
    arrangement: "table",
    plan,
    declaredFieldIds: [...declaredFieldIds] as TableArrangementResult["declaredFieldIds"],
    groupByFieldIds: groupByFieldIds as TableArrangementResult["groupByFieldIds"],
    totalRowCount: rows.length,
    rows: grouped ? null : rows.map((row) => projectRow(row, declaredFieldIds)),
    groups: grouped
      ? groupRows(rows, groupByFieldIds, fieldTypes).map((group) => ({
          groupKey: group.groupKey,
          groupValues: group.groupValues as ArrangementRow["values"],
          rowCount: group.rows.length,
          rows: group.rows.map((row) => projectRow(row, declaredFieldIds)),
          aggregates: aggregate(group.rows),
        }))
      : null,
    aggregates: aggregate(rows),
  };
};

const arrangeBoard = (
  { plan, rows, declaredFieldIds, fieldTypes }: Plan,
  descriptor: BoardArrangementDescriptor,
): BoardArrangementResult => {
  const choiceFieldId = lower(descriptor.choiceFieldId);
  const columns = new Map<string, ArrangementRow[]>(
    descriptor.choiceOptions.map((option) => [option.value, []]),
  );
  const unassigned: ArrangementRow[] = [];
  for (const row of rows) {
    const choice = valuesOf(row)[choiceFieldId];
    const target = typeof choice === "string" ? columns.get(choice) : undefined;
    (target ?? unassigned).push(row);
  }
  const column = (subset: readonly ArrangementRow[]) => ({
    rowCount: subset.length,
    rows: subset.map((row) => projectRow(row, declaredFieldIds)),
    aggregates: computeAggregates(subset, descriptor.aggregates, fieldTypes),
  });
  return {
    outcome: "completed",
    arrangement: "board",
    plan,
    declaredFieldIds: [...declaredFieldIds] as BoardArrangementResult["declaredFieldIds"],
    choiceFieldId: choiceFieldId as BoardArrangementResult["choiceFieldId"],
    totalRowCount: rows.length,
    columns: descriptor.choiceOptions.map((option) => ({
      value: option.value,
      label: option.label,
      ...column(columns.get(option.value)!),
    })),
    unassigned: column(unassigned),
    aggregates: computeAggregates(rows, descriptor.aggregates, fieldTypes),
  };
};

// Calendar

const dayMilliseconds = 86_400_000;
const maximumOffsetMilliseconds = 8_640_000_000_000_000;
const maximumDurationDays = 3_660_000n;
/** 0001-01-01T00:00:00Z; zone offsets are not read before the first common-era year. */
const minimumInstant = -62_135_596_800_000;

const utcDay = (year: number, month: number, day: number): Date => {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
};

const padded = (value: number, width: number): string => String(value).padStart(width, "0");

const isoDate = (date: Date): string | undefined => {
  const year = date.getUTCFullYear();
  if (!Number.isFinite(year) || year < 1 || year > 9999) return undefined;
  return `${padded(year, 4)}-${padded(date.getUTCMonth() + 1, 2)}-${padded(date.getUTCDate(), 2)}`;
};

const isoDateTime = (instant: number): string | undefined =>
  isoDate(new Date(instant)) === undefined ? undefined : new Date(instant).toISOString();

/** Offset of the zone's wall clock from UTC at one instant, to the second. */
const zoneOffset = (zone: Intl.DateTimeFormat, instant: number): number => {
  const second = instant - (((instant % 1000) + 1000) % 1000);
  const parts = new Map(zone.formatToParts(new Date(second)).map((part) => [part.type, part.value]));
  const wallClock = utcDay(Number(parts.get("year")), Number(parts.get("month")), Number(parts.get("day")));
  wallClock.setUTCHours(Number(parts.get("hour")), Number(parts.get("minute")), Number(parts.get("second")));
  return wallClock.getTime() - second;
};

/** Adds whole calendar days in the zone, keeping the local wall-clock time across offset changes. */
const addZonedDays = (zone: Intl.DateTimeFormat, instant: number, days: number): number => {
  const wallClock = instant + zoneOffset(zone, instant) + days * dayMilliseconds;
  const estimate = wallClock - zoneOffset(zone, instant);
  return wallClock - zoneOffset(zone, estimate);
};

/**
 * End of a start-plus-duration item, or undefined when the duration cannot place
 * it: negative, finer than the start's precision, or outside the calendar range.
 * The duration is exact; minutes and hours are elapsed time and days are
 * calendar days in the stated zone.
 */
const durationEnd = (
  start: string,
  startType: FieldType,
  duration: JsonValue,
  unit: "minutes" | "hours" | "days",
  zone: Intl.DateTimeFormat,
): string | undefined => {
  const exact = parseExactDecimal(typeof duration === "number" ? String(duration) : duration);
  if (exact === undefined || exact.coefficient < 0n) return undefined;
  if (unit === "days") {
    if (exact.scale !== 0 || exact.coefficient > maximumDurationDays) return undefined;
    const days = Number(exact.coefficient);
    if (startType === "date") {
      const [year, month, day] = start.split("-").map(Number) as [number, number, number];
      return isoDate(utcDay(year, month, day + days));
    }
    const instant = Date.parse(start);
    if (instant < minimumInstant) return undefined;
    const end = addZonedDays(zone, instant, days);
    return Number.isFinite(end) ? isoDateTime(end) : undefined;
  }
  const scaledMilliseconds = exact.coefficient * (unit === "minutes" ? 60_000n : 3_600_000n);
  const divisor = 10n ** BigInt(exact.scale);
  if (scaledMilliseconds % divisor !== 0n) return undefined;
  const milliseconds = scaledMilliseconds / divisor;
  if (milliseconds > BigInt(maximumOffsetMilliseconds)) return undefined;
  return isoDateTime(Date.parse(start) + Number(milliseconds));
};

const arrangeCalendar = (
  { plan, rows, declaredFieldIds, fieldTypes }: Plan,
  descriptor: CalendarArrangementDescriptor,
  zone: Intl.DateTimeFormat,
): CalendarArrangementResult => {
  const mapping = descriptor.calendarMapping;
  const startFieldId = lower(mapping.startFieldId);
  const startType = fieldTypes.get(startFieldId)!;
  const order = (left: string, right: string): number =>
    compareFieldValues(left, right, startType === "date" ? "date" : "date_time");

  const items: CalendarItem[] = [];
  const unscheduledRows: ArrangementRow[] = [];
  for (const row of rows) {
    const values = valuesOf(row);
    const start = values[startFieldId];
    let end: string | null | undefined = null;
    if (typeof start === "string") {
      if (mapping.kind === "start_end") {
        const value = values[lower(mapping.endFieldId)];
        end = typeof value === "string" ? (order(value, start) < 0 ? undefined : value) : null;
      } else {
        const duration = values[lower(mapping.durationFieldId)];
        end = present(duration)
          ? durationEnd(start, startType, duration, mapping.durationUnit, zone)
          : null;
      }
    }
    if (typeof start !== "string" || end === undefined) {
      unscheduledRows.push(projectRow(row, declaredFieldIds));
      continue;
    }
    items.push({
      recordId: row.recordId,
      start,
      end,
      values: projectRow(row, declaredFieldIds).values,
    });
  }

  items.sort(
    (left, right) =>
      order(left.start, right.start) ||
      (left.end === null || right.end === null
        ? Number(right.end === null) - Number(left.end === null)
        : order(left.end, right.end)) ||
      codeUnitOrder(lower(left.recordId), lower(right.recordId)),
  );

  return {
    outcome: "completed",
    arrangement: "calendar",
    plan,
    declaredFieldIds: [...declaredFieldIds] as CalendarArrangementResult["declaredFieldIds"],
    calendarMapping: mapping,
    timeZone: zone.resolvedOptions().timeZone,
    totalRowCount: rows.length,
    items,
    unscheduledRows,
  };
};

const calendarZone = (timeZone: string): Intl.DateTimeFormat | undefined => {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    return undefined;
  }
};

/**
 * Shapes one complete authorised query result into a table, board or calendar.
 * Summary arrangements use the database-backed protected Query service. Every
 * row, count, group and total comes from the same rows, in the
 * plan's order, before any page is cut; outputs carry only declared fields and
 * are ordered deterministically. A malformed command, an undeclared or
 * unsuitable field, an inconsistent result or an oversized result returns one
 * neutral refusal and nothing partial.
 */
export const arrangeDataset = (commandCandidate: unknown): ArrangementResult => {
  const rowsCandidate = (commandCandidate as { dataset?: { rows?: unknown } } | null)?.dataset?.rows;
  if (Array.isArray(rowsCandidate) && rowsCandidate.length > arrangementRowLimit)
    return refusal("dataset_limit_exceeded");
  const command = arrangementCommandSchema.safeParse(commandCandidate);
  if (!command.success) return refusal("request_invalid");
  const { dataset, descriptor } = command.data;

  const fieldTypes: FieldTypes = new Map(dataset.fields.map((field) => [lower(field.fieldId), field.type]));
  const declaredFieldIds = descriptor.declaredFieldIds.map(lower);
  if (!declaredFieldIds.every((fieldId) => fieldTypes.has(fieldId))) return refusal("descriptor_invalid");
  const declared = new Set(declaredFieldIds);
  const typeOf = (fieldId: string): FieldType | undefined =>
    declared.has(lower(fieldId)) ? fieldTypes.get(lower(fieldId)) : undefined;

  let zone: Intl.DateTimeFormat | undefined;
  switch (descriptor.type) {
    case "table":
      if (!validateUse(declared, fieldTypes, descriptor.groupByFieldIds, descriptor.aggregates))
        return refusal("descriptor_invalid");
      break;
    case "board":
      if (
        typeOf(descriptor.choiceFieldId) !== "choice" ||
        !validateUse(declared, fieldTypes, [], descriptor.aggregates)
      )
        return refusal("descriptor_invalid");
      break;
    case "calendar": {
      const mapping = descriptor.calendarMapping;
      const startType = typeOf(mapping.startFieldId);
      const valid =
        mapping.kind === "start_end"
          ? (startType === "date" || startType === "date_time") && typeOf(mapping.endFieldId) === startType
          : (startType === "date_time" || (startType === "date" && mapping.durationUnit === "days")) &&
            (typeOf(mapping.durationFieldId) === "whole_number" ||
              typeOf(mapping.durationFieldId) === "decimal_number");
      if (!valid) return refusal("descriptor_invalid");
      zone = calendarZone(descriptor.timeZone);
      if (zone === undefined) return refusal("time_zone_invalid");
      break;
    }
  }

  const rows = validateRows(dataset.rows, declaredFieldIds, fieldTypes);
  if (rows === undefined) return refusal("dataset_invalid");
  const plan: Plan = { plan: dataset.plan, rows, declaredFieldIds, fieldTypes };

  switch (descriptor.type) {
    case "table":
      return arrangeTable(plan, descriptor);
    case "board":
      return arrangeBoard(plan, descriptor);
    case "calendar":
      return arrangeCalendar(plan, descriptor, zone!);
  }
};

type ProtectedSummaryService = Pick<ReturnType<typeof createProtectedQueryService>, "summarise">;
type ProtectedSummaryArguments = Parameters<ProtectedSummaryService["summarise"]>;

/** Routes a summary arrangement to the protected database-backed Query service. */
export const arrangeSummary = async (
  queries: ProtectedSummaryService,
  caller: ProtectedSummaryArguments[0],
  selection: ProtectedSummaryArguments[1],
  commandCandidate: unknown,
): Promise<HumanOrganizationRequestResult<ArrangementResult>> => {
  const command = summaryArrangementCommandSchema.safeParse(commandCandidate);
  if (!command.success)
    return { kind: "available", value: refusal("request_invalid") };

  const result = await queries.summarise(caller, selection, command.data);
  if (result.kind !== "available") return result;
  if (result.value.outcome === "refused")
    return { kind: "available", value: refusal(result.value.reasonCode) };

  const mapped = summaryArrangementResultSchema.safeParse({
    outcome: "completed",
    arrangement: "summary",
    plan: {
      moduleRootId: result.value.moduleRootId,
      moduleReleaseVersion: result.value.moduleReleaseVersion,
      queryId: result.value.queryId,
    },
    groupByFieldIds: result.value.groupByFieldIds,
    totalRowCount: result.value.totalRowCount,
    groups: result.value.groups,
    aggregates: result.value.aggregates,
  });
  if (!mapped.success) throw new Error("PROTECTED_QUERY_SUMMARY_RESULT_INVALID");
  return { kind: "available", value: mapped.data };
};

type ProtectedBoardService = Pick<
  ReturnType<typeof createProtectedQueryService>,
  "boardMembers" | "boardSummary"
>;
type ProtectedBoardSummaryArguments = Parameters<ProtectedBoardService["boardSummary"]>;
type ProtectedBoardMembersArguments = Parameters<ProtectedBoardService["boardMembers"]>;
type ProtectedBoardPageRead = HumanOrganizationRequestResult<
  ProtectedBoardArrangementPage | ArrangementRefusal
>;

const requestedProjectionIsPreserved = (
  page: ProtectedBoardArrangementPage,
  requestedFieldIds: readonly string[],
  requestedSystemFieldKeys: readonly string[],
): boolean => {
  const declaredFields = new Set(requestedFieldIds.map(lower));
  const declaredSystemFields = new Set(requestedSystemFieldKeys);
  const recordIds = new Set<string>();
  for (const row of page.rows) {
    const recordId = lower(row.recordId);
    if (recordIds.has(recordId)) return false;
    recordIds.add(recordId);

    const returnedFields = Object.keys(row.values);
    if (
      new Set(returnedFields.map(lower)).size !== returnedFields.length ||
      returnedFields.some((fieldId) => !declaredFields.has(lower(fieldId)))
    )
      return false;

    const returnedSystemFields = Object.keys(row.systemValues ?? {});
    if (returnedSystemFields.some((fieldKey) => !declaredSystemFields.has(fieldKey))) return false;
  }
  return true;
};

const readProtectedBoardPage = async (
  queries: ProtectedBoardService,
  caller: ProtectedBoardMembersArguments[0],
  selection: ProtectedBoardMembersArguments[1],
  command: ReturnType<typeof protectedBoardArrangementCommandSchema.parse>,
  expectedReleaseVersion: string,
  selector: ProtectedQueryBoardSelector,
  continuationToken?: string,
): Promise<ProtectedBoardPageRead> => {
  const producer = await queries.boardMembers(caller, selection, {
    moduleRootId: command.moduleRootId,
    queryId: command.queryId,
    inputValues: command.inputValues,
    requestedFieldIds: command.requestedFieldIds,
    requestedSystemFieldKeys: command.requestedSystemFieldKeys,
    filter: command.filter,
    filterableFieldIds: command.filterableFieldIds,
    selector,
    pageSize: command.pageSize,
    ...(continuationToken === undefined ? {} : { continuationToken }),
  });
  if (producer.kind !== "available") return producer;

  const parsed = protectedQueryResultSchema.safeParse(producer.value);
  if (!parsed.success) return { kind: "available", value: refusal("dataset_invalid") };
  if (parsed.data.outcome === "refused")
    return { kind: "available", value: refusal(parsed.data.reasonCode) };

  if (
    lower(parsed.data.moduleRootId) !== lower(command.moduleRootId) ||
    lower(parsed.data.queryId) !== lower(command.queryId)
  )
    return { kind: "available", value: refusal("dataset_invalid") };
  if (parsed.data.moduleReleaseVersion !== expectedReleaseVersion)
    return { kind: "available", value: refusal("cursor_stale") };

  const page = protectedBoardArrangementPageSchema.safeParse({
    rows: parsed.data.rows,
    nextContinuationToken: parsed.data.nextContinuationToken,
  });
  if (
    !page.success ||
    !requestedProjectionIsPreserved(
      page.data,
      command.requestedFieldIds,
      command.requestedSystemFieldKeys,
    )
  )
    return { kind: "available", value: refusal("dataset_invalid") };
  return { kind: "available", value: page.data };
};

/**
 * Composes one current protected board summary with only its requested member pages. Initial
 * requests read at most twelve installed columns plus unassigned; continuations read one column.
 * Every producer call rechecks current authority, and separate calls do not share an atomic
 * snapshot, so refreshed totals can differ from previously returned or newly read member pages.
 */
export const arrangeProtectedBoard = async (
  queries: ProtectedBoardService,
  caller: ProtectedBoardSummaryArguments[0],
  selection: ProtectedBoardSummaryArguments[1],
  commandCandidate: unknown,
): Promise<
  HumanOrganizationRequestResult<ProtectedBoardArrangementResult | ArrangementRefusal>
> => {
  const parsedCommand = protectedBoardArrangementCommandSchema.safeParse(commandCandidate);
  if (!parsedCommand.success)
    return { kind: "available", value: refusal("request_invalid") };
  const command = parsedCommand.data;

  const producedSummary = await queries.boardSummary(caller, selection, {
    moduleRootId: command.moduleRootId,
    queryId: command.queryId,
    inputValues: command.inputValues,
    choiceFieldId: command.choiceFieldId,
    filter: command.filter,
    filterableFieldIds: command.filterableFieldIds,
  });
  if (producedSummary.kind !== "available") return producedSummary;

  const summaryResult = protectedQueryBoardSummaryResultSchema.safeParse(producedSummary.value);
  if (!summaryResult.success)
    return { kind: "available", value: refusal("dataset_invalid") };
  if (summaryResult.data.outcome === "refused")
    return { kind: "available", value: refusal(summaryResult.data.reasonCode) };

  const summary = summaryResult.data;
  if (
    lower(summary.moduleRootId) !== lower(command.moduleRootId) ||
    lower(summary.queryId) !== lower(command.queryId) ||
    lower(summary.choiceFieldId) !== lower(command.choiceFieldId)
  )
    return { kind: "available", value: refusal("dataset_invalid") };

  const pages = new Map<string, ProtectedBoardArrangementPage>();
  let unassignedPage: ProtectedBoardArrangementPage | null = null;
  const readColumn = async (
    selector: ProtectedQueryBoardSelector,
    token?: string,
  ): Promise<HumanOrganizationRequestResult<ArrangementRefusal> | undefined> => {
    const result = await readProtectedBoardPage(
      queries,
      caller,
      selection,
      command,
      summary.moduleReleaseVersion,
      selector,
      token,
    );
    if (result.kind !== "available") return result;
    if ("outcome" in result.value) return { kind: "available", value: result.value };
    if (selector.column.kind === "unassigned") unassignedPage = result.value;
    else pages.set(selector.column.value, result.value);
    return undefined;
  };

  if (command.pageRequest.kind === "initial") {
    for (const column of summary.columns) {
      const failure = await readColumn({
        choiceFieldId: summary.choiceFieldId,
        column: { kind: "option", value: column.value },
      });
      if (failure !== undefined) return failure;
    }
    const failure = await readColumn({
      choiceFieldId: summary.choiceFieldId,
      column: { kind: "unassigned" },
    });
    if (failure !== undefined) return failure;
  } else {
    const selector = command.pageRequest.selector;
    if (lower(selector.choiceFieldId) !== lower(summary.choiceFieldId))
      return { kind: "available", value: refusal("cursor_stale") };
    if (selector.column.kind === "option") {
      const selectedValue = selector.column.value;
      if (!summary.columns.some((column) => column.value === selectedValue))
        return { kind: "available", value: refusal("cursor_stale") };
    }

    const failure = await readColumn(
      { choiceFieldId: summary.choiceFieldId, column: selector.column },
      command.pageRequest.continuationToken,
    );
    if (failure !== undefined) return failure;
  }

  const completed = protectedBoardArrangementResultSchema.safeParse({
    outcome: "completed",
    arrangement: "board",
    plan: {
      moduleRootId: summary.moduleRootId,
      moduleReleaseVersion: summary.moduleReleaseVersion,
      queryId: summary.queryId,
    },
    choiceFieldId: summary.choiceFieldId,
    declaredFieldIds: command.requestedFieldIds,
    declaredSystemFieldKeys: command.requestedSystemFieldKeys,
    totalRowCount: summary.totalRowCount,
    columns: summary.columns.map((column) => ({
      ...column,
      page: pages.get(column.value) ?? null,
    })),
    unassigned: { ...summary.unassigned, page: unassignedPage },
    aggregates: summary.aggregates,
  });
  if (!completed.success)
    return { kind: "available", value: refusal("dataset_invalid") };
  return { kind: "available", value: completed.data };
};
