import type {
  readCurrentOrganizationRuntimeSettingsAfterAuthorization,
  createProtectedQueryService} from "@web/platform-server";
import {
  protectedQueryCommandSchema,
  arrangeDataset,
  type HumanOrganizationRequestResult
} from "@web/platform-server";
import {
  type CalendarMapping,
  type BlockPropertyValueContract,
  calendarMappingSchema,
  type JsonValue,
  calendarBlockSourceIsSupported,
  type IdentitySession,
  type OrganizationSelectionCandidate,
} from "@vortex/platform/schema";
import type { collectPlacements } from "./placement-helpers";
import { isRecord, sameId, first } from "./placement-helpers";
import type { findModuleQuery } from "./query-helpers";
import { logPlacementFailure } from "./query-helpers";
import type { ApplicationPageLoaderAddress, PageDataState, SearchParameters } from "./types";

type CalendarView = "month" | "week" | "agenda";

type CalendarPlacementContract = Readonly<{
  calendarMapping: CalendarMapping;
  itemTitleFieldId: string;
  defaultView: CalendarView;
}>;

const calendarFieldReference = (value: BlockPropertyValueContract | undefined): string | undefined =>
  value?.kind === "field_reference" ? value.fieldId : undefined;

const calendarChoice = (value: BlockPropertyValueContract | undefined): string | undefined =>
  value?.kind === "choice" ? value.value : undefined;

/** Reads the one calendar placement's declared field mapping from its validated settings. */
export const readCalendarPlacementContract = (
  settings: Readonly<Record<string, BlockPropertyValueContract>>,
): CalendarPlacementContract | undefined => {
  const group = settings.calendar_mapping;
  if (group?.kind !== "group") return undefined;
  const properties = group.properties;
  const kind = calendarChoice(properties.kind);
  const startFieldId = calendarFieldReference(properties.start_field);
  const endFieldId = calendarFieldReference(properties.end_field);
  const durationFieldId = calendarFieldReference(properties.duration_field);
  const durationUnit = calendarChoice(properties.duration_unit);
  if (startFieldId === undefined) return undefined;
  const mappingCandidate =
    kind === "start_end" &&
    endFieldId !== undefined &&
    durationFieldId === undefined &&
    durationUnit === undefined
      ? { kind, startFieldId, endFieldId }
      : kind === "start_duration" &&
          endFieldId === undefined &&
          durationFieldId !== undefined &&
          durationUnit !== undefined
        ? { kind, startFieldId, durationFieldId, durationUnit }
        : undefined;
  const mapping = calendarMappingSchema.safeParse(mappingCandidate);
  const itemTitleFieldId = calendarFieldReference(settings.item_title_field);
  if (!mapping.success || itemTitleFieldId === undefined) return undefined;
  const configuredView = calendarChoice(settings.default_view);
  const defaultView: CalendarView =
    configuredView === "week" || configuredView === "agenda" ? configuredView : "month";
  return { calendarMapping: mapping.data, itemTitleFieldId, defaultView };
};

const calendarDateIsValid = (candidate: string | undefined): candidate is string => {
  if (candidate === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return false;
  const [year, month, day] = candidate.split("-").map(Number) as [number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return (
    year >= 1 &&
    year <= 9999 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

const calendarUtcDate = (year: number, month: number, day: number): Date => {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
};

const calendarIsoDate = (date: Date): string =>
  `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;

const calendarAddDays = (date: string, count: number): string => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return calendarIsoDate(calendarUtcDate(year, month - 1, day + count));
};

const calendarToday = (timeZone: string): string => {
  const values = new Map(
    new Intl.DateTimeFormat("en", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map((part) => [part.type, part.value]),
  );
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
};

const calendarLocalDate = (instant: number, timeZone: string): string => {
  const values = new Map(
    new Intl.DateTimeFormat("en", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
};

/** First instant of an organisation-local day, including offset changes around daylight saving. */
const calendarStartOfDay = (date: string, timeZone: string): string => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const estimate = calendarUtcDate(year, month - 1, day).getTime();
  let lower = estimate - 48 * 60 * 60 * 1_000;
  let upper = estimate + 48 * 60 * 60 * 1_000;
  if (calendarLocalDate(lower, timeZone) >= date) return new Date(lower).toISOString();
  if (calendarLocalDate(upper, timeZone) < date) return new Date(upper).toISOString();
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2);
    if (calendarLocalDate(middle, timeZone) >= date) upper = middle;
    else lower = middle;
  }
  return new Date(upper).toISOString();
};

const calendarPeriod = (
  view: CalendarView,
  date: string,
): Readonly<{ startDate: string; endDate: string }> => {
  if (view === "agenda") return { startDate: date, endDate: calendarAddDays(date, 30) };
  if (view === "week") {
    const [year, month, day] = date.split("-").map(Number) as [number, number, number];
    const mondayOffset = (calendarUtcDate(year, month - 1, day).getUTCDay() + 6) % 7;
    const startDate = calendarAddDays(date, -mondayOffset);
    return { startDate, endDate: calendarAddDays(startDate, 7) };
  }
  const [year, month] = date.split("-").map(Number) as [number, number];
  const startDate = calendarIsoDate(calendarUtcDate(year, month - 1, 1));
  const endDate = calendarAddDays(startDate, calendarUtcDate(year, month, 0).getUTCDate());
  return { startDate, endDate };
};

const calendarWindowFilter = (
  mapping: CalendarMapping,
  dateFieldType: "date" | "date_time",
  window: Readonly<{ startDate: string; endDate: string }>,
  timeZone: string,
): JsonValue => {
  const startValue =
    dateFieldType === "date" ? window.startDate : calendarStartOfDay(window.startDate, timeZone);
  const endValue =
    dateFieldType === "date" ? window.endDate : calendarStartOfDay(window.endDate, timeZone);
  const compare = (
    fieldId: string,
    operator: "less_than" | "greater_than_or_equal",
    value: string,
  ): JsonValue => ({
    kind: "comparison",
    operator,
    left: { source: "field", fieldId: fieldId.toLowerCase() },
    right: { source: "value", value },
  });
  const conditions =
    mapping.kind === "start_end"
      ? [
          compare(mapping.startFieldId, "less_than", endValue),
          compare(mapping.endFieldId, "greater_than_or_equal", startValue),
        ]
      : [
          compare(mapping.startFieldId, "greater_than_or_equal", startValue),
          compare(mapping.startFieldId, "less_than", endValue),
        ];
  return { kind: "all", conditions };
};

const calendarTitle = (value: JsonValue | undefined, field: { type: string; settings?: unknown }): string => {
  if (typeof value === "string") {
    if (field.type === "choice" && isRecord(field.settings) && Array.isArray(field.settings.options)) {
      const option = field.settings.options.find(
        (candidate) => isRecord(candidate) && candidate.value === value,
      );
      if (isRecord(option) && typeof option.label === "string") return option.label;
    }
    return value.slice(0, 200);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value))
    return value
      .flatMap((entry) => {
        if (typeof entry !== "string") return [];
        if (
          field.type !== "several_choices" ||
          !isRecord(field.settings) ||
          !Array.isArray(field.settings.options)
        )
          return [entry];
        const option = field.settings.options.find(
          (candidate) => isRecord(candidate) && candidate.value === entry,
        );
        return [isRecord(option) && typeof option.label === "string" ? option.label : entry];
      })
      .join(", ")
      .slice(0, 200);
  if (field.type === "formatted_text" && isRecord(value)) {
    const textParts: string[] = [];
    const collect = (candidate: unknown): void => {
      if (Array.isArray(candidate)) {
        candidate.forEach(collect);
      } else if (isRecord(candidate)) {
        if (typeof candidate.text === "string") textParts.push(candidate.text);
        else Object.values(candidate).forEach(collect);
      }
    };
    collect(value);
    return textParts.join("").slice(0, 200);
  }
  return "";
};

export const readCalendarPlacement = async (input: {
  readCalendarSettings: () => Promise<
    HumanOrganizationRequestResult<{
      settings: Awaited<ReturnType<typeof readCurrentOrganizationRuntimeSettingsAfterAuthorization>>;
      accessVersion: number;
    }>
  >;
  address: ApplicationPageLoaderAddress;
  placementId: string;
  data: Record<string, PageDataState>;
  page: Parameters<typeof collectPlacements>[0];
  bound: NonNullable<ReturnType<typeof findModuleQuery>>;
  calendarContract: NonNullable<ReturnType<typeof readCalendarPlacementContract>>;
  parameters: SearchParameters;
  queries: ReturnType<typeof createProtectedQueryService>;
  session: IdentitySession;
  selection: OrganizationSelectionCandidate;
}): Promise<void> => {
  const {
    readCalendarSettings,
    address,
    placementId,
    data,
    page,
    bound,
    calendarContract,
    parameters,
    queries,
    session,
    selection,
  } = input;
  let organizationSettings: Awaited<ReturnType<typeof readCalendarSettings>>;
  try {
    organizationSettings = await readCalendarSettings();
  } catch {
    logPlacementFailure(address, placementId, "calendar_time_zone_unavailable");
    data[placementId] = { status: "error" };
    return;
  }
  if (
    organizationSettings.kind !== "available" ||
    organizationSettings.value.accessVersion !== page.accessVersion ||
    organizationSettings.value.settings === undefined
  ) {
    logPlacementFailure(
      address,
      placementId,
      organizationSettings.kind === "unavailable"
        ? "calendar_settings_invalid"
        : "calendar_time_zone_unavailable",
    );
    data[placementId] =
      organizationSettings.kind === "unavailable"
        ? { status: "refused", reason: "not_permitted" }
        : { status: "error" };
    return;
  }
  const timeZone = organizationSettings.value.settings.timeZone;
  const recordTypeReference = bound.query.recordType;
  const recordType =
    recordTypeReference.state === "resolved"
      ? bound.module.content.recordTypes.find((candidate) =>
          sameId(String(candidate.recordTypeId), String(recordTypeReference.recordTypeId)),
        )
      : undefined;
  const fieldById = new Map(
    (recordType?.fields ?? []).map((field) => [String(field.fieldId).toLowerCase(), field]),
  );
  const mapping = calendarContract.calendarMapping;
  const startField = fieldById.get(mapping.startFieldId.toLowerCase());
  const endField =
    mapping.kind === "start_end" ? fieldById.get(mapping.endFieldId.toLowerCase()) : undefined;
  const durationField =
    mapping.kind === "start_duration"
      ? fieldById.get(mapping.durationFieldId.toLowerCase())
      : undefined;
  const titleField = fieldById.get(calendarContract.itemTitleFieldId.toLowerCase());
  const selected = new Set(bound.query.selectedFieldIds.map((fieldId) => fieldId.toLowerCase()));
  const dateFieldType = startField?.type;
  const filterableDateFields =
    mapping.kind === "start_end"
      ? [startField, endField]
      : [startField];
  const mappingValid =
    recordType !== undefined &&
    (dateFieldType === "date" || dateFieldType === "date_time") &&
    filterableDateFields.every((field) => field?.filterable === true) &&
    (mapping.kind !== "start_end" || endField?.type === dateFieldType) &&
    (mapping.kind !== "start_duration" ||
      ((dateFieldType === "date_time" ||
        (dateFieldType === "date" && mapping.durationUnit === "days")) &&
        durationField?.type === "whole_number")) &&
    titleField !== undefined &&
    calendarBlockSourceIsSupported(bound.query, titleField.type);
  const requestedFieldIds = [
    mapping.startFieldId,
    ...(mapping.kind === "start_end" ? [mapping.endFieldId] : [mapping.durationFieldId]),
    calendarContract.itemTitleFieldId,
  ];
  if (
    !mappingValid ||
    !requestedFieldIds.every((fieldId) => selected.has(fieldId.toLowerCase()))
  ) {
    logPlacementFailure(address, placementId, "calendar_settings_invalid");
    data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }

  const rawView = first(parameters[`view.${placementId}`]);
  const view: CalendarView =
    rawView === "week" || rawView === "agenda" || rawView === "month"
      ? rawView
      : calendarContract.defaultView;
  const rawDate = first(parameters[`date.${placementId}`]);
  const candidateDate = calendarDateIsValid(rawDate) ? rawDate : calendarToday(timeZone);
  const candidateWindow = calendarPeriod(view, candidateDate);
  const date =
    calendarDateIsValid(candidateWindow.startDate) &&
    calendarDateIsValid(candidateWindow.endDate)
      ? candidateDate
      : calendarToday(timeZone);
  const window = calendarPeriod(view, date);
  const filterableFieldIds =
    mapping.kind === "start_end"
      ? [mapping.startFieldId, mapping.endFieldId].map((fieldId) => fieldId.toLowerCase())
      : [mapping.startFieldId.toLowerCase()];
  const command = protectedQueryCommandSchema.safeParse({
    moduleRootId: bound.module.rootId,
    queryId: bound.query.queryId,
    inputValues: {},
    requestedFieldIds: [...new Set(requestedFieldIds.map((fieldId) => fieldId.toLowerCase()))],
    requestedSystemFieldKeys: [],
    sort: [],
    filter: calendarWindowFilter(mapping, dateFieldType as "date" | "date_time", window, timeZone),
    sortableFieldIds: [],
    filterableFieldIds,
    searchableFieldIds: [],
    pageSize: bound.query.pageSize,
  });
  if (!command.success) {
    logPlacementFailure(address, placementId, "calendar_query_invalid");
    data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }

  let queryResult: Awaited<ReturnType<typeof queries.run>>;
  try {
    queryResult = await queries.run(session, selection, command.data);
  } catch {
    queryResult = { kind: "temporarily_unavailable" as const };
  }
  if (queryResult.kind === "temporarily_unavailable") {
    logPlacementFailure(address, placementId, "calendar_query_unavailable");
    data[placementId] = { status: "error" };
    return;
  }
  if (queryResult.kind !== "available" || queryResult.value.outcome !== "completed") {
    logPlacementFailure(address, placementId, "calendar_query_refused");
    data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }

  const fieldIds = [...new Set(requestedFieldIds.map((fieldId) => fieldId.toLowerCase()))];
  const arranged = arrangeDataset({
    dataset: {
      plan: {
        moduleRootId: queryResult.value.moduleRootId,
        moduleReleaseVersion: queryResult.value.moduleReleaseVersion,
        queryId: queryResult.value.queryId,
      },
      fields: fieldIds.flatMap((fieldId) => {
        const field = fieldById.get(fieldId);
        return field === undefined ? [] : [{ fieldId, type: field.type }];
      }),
      rows: queryResult.value.rows,
    },
    descriptor: {
      type: "calendar",
      declaredFieldIds: fieldIds,
      calendarMapping: mapping,
      timeZone,
    },
  });
  if (arranged.outcome !== "completed" || arranged.arrangement !== "calendar") {
    logPlacementFailure(address, placementId, "calendar_arrangement_refused");
    data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }

  const items = arranged.items.map((item) => {
    const titleValue = Object.entries(item.values).find(([key]) =>
      sameId(key, calendarContract.itemTitleFieldId),
    )?.[1];
    return {
      recordId: item.recordId,
      start: item.start,
      end: item.end,
      title: calendarTitle(titleValue, titleField),
    };
  });
  const truncated = queryResult.value.nextContinuationToken !== undefined;
  data[placementId] = {
    status: "ready",
    values: {
      kind: "calendar",
      view,
      date,
      windowStart: window.startDate,
      windowEnd: window.endDate,
      timeZone,
      endExclusive: mapping.kind === "start_duration",
      truncated,
      items,
    },
  };
};
