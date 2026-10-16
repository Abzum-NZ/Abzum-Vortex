"use client";

import type { ReactElement } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "../components/button";
import { Card, CardContent, CardDescription, CardHeader } from "../components/card";
import {
  DisplayHeader,
  RecordsEmptyState,
  RecordsLoadingState,
} from "./controls";
import { resolveDisplayContext, type DisplayRenderProps } from "./context";
import { DisplayStateContainer } from "./display-state-container";
import type { CalendarPayload, CalendarView } from "./projected-data";

const calendarViews: readonly CalendarView[] = ["month", "week", "agenda"];
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
type DayBoundaries = Readonly<{ start: number; end: number }>;
const calendarDateFormatters = new Map<string, Intl.DateTimeFormat>();
const itemTimeFormatters = new Map<string, Intl.DateTimeFormat>();

const calendarDateFormatter = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = calendarDateFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    calendarDateFormatters.set(timeZone, formatter);
  }
  return formatter;
};

const itemTimeFormatter = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = itemTimeFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(undefined, {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    });
    itemTimeFormatters.set(timeZone, formatter);
  }
  return formatter;
};

const dateAtUtc = (year: number, month: number, day: number): Date => {
  const result = new Date(0);
  result.setUTCFullYear(year, month, day);
  result.setUTCHours(0, 0, 0, 0);
  return result;
};

const toIsoDate = (date: Date): string =>
  `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;

const addDays = (date: string, count: number): string => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return toIsoDate(dateAtUtc(year, month - 1, day + count));
};

const localToday = (timeZone: string): string => {
  const parts = calendarDateFormatter(timeZone).formatToParts(new Date());
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
};

const weekdayIndex = (date: string): number => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return dateAtUtc(year, month - 1, day).getUTCDay();
};

const daysInMonth = (date: string): number => {
  const [year, month] = date.split("-").map(Number) as [number, number];
  return dateAtUtc(year, month, 0).getUTCDate();
};

const shiftMonth = (date: string, offset: number): string => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const first = dateAtUtc(year, month - 1 + offset, 1);
  const boundedDay = Math.min(day, daysInMonth(toIsoDate(first)));
  first.setUTCDate(boundedDay);
  return toIsoDate(first);
};

const localDateOf = (instant: string, timeZone: string): string => {
  const parts = calendarDateFormatter(timeZone).formatToParts(new Date(instant));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
};

const localDayStart = (date: string, timeZone: string): number => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const estimate = dateAtUtc(year, month - 1, day).getTime();
  let lower = estimate - 48 * 60 * 60 * 1_000;
  let upper = estimate + 48 * 60 * 60 * 1_000;
  const localDateAt = (instant: number): string => localDateOf(new Date(instant).toISOString(), timeZone);
  if (localDateAt(lower) >= date) return lower;
  if (localDateAt(upper) < date) return upper;
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2);
    if (localDateAt(middle) >= date) upper = middle;
    else lower = middle;
  }
  return upper;
};

const itemIntersectsDay = (
  item: CalendarPayload["items"][number],
  day: string,
  boundaries: DayBoundaries | undefined,
  endExclusive: boolean,
): boolean => {
  if (datePattern.test(item.start)) {
    const startDay = item.start;
    const endDay = item.end ?? startDay;
    return startDay <= day &&
      (endExclusive && endDay > startDay ? endDay > day : endDay >= day);
  }
  if (boundaries === undefined)
    throw new Error("A timestamped calendar item requires precomputed day boundaries");
  const start = Date.parse(item.start);
  const end = item.end === null ? start : Date.parse(item.end);
  return start < boundaries.end &&
    (endExclusive && end > start ? end > boundaries.start : end >= boundaries.start);
};

const dayLabel = (date: string): string => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(dateAtUtc(year, month - 1, day));
};

const monthLabel = (date: string): string => {
  const [year, month] = date.split("-").map(Number) as [number, number];
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(dateAtUtc(year, month - 1, 1));
};

const itemTime = (value: string, timeZone: string): string =>
  datePattern.test(value)
    ? ""
    : itemTimeFormatter(timeZone).format(new Date(value));

const periodDays = (values: CalendarPayload): readonly string[] => {
  if (values.view === "week")
    return Array.from({ length: 7 }, (_, index) => addDays(values.windowStart, index));
  if (values.view === "agenda")
    return Array.from({ length: 30 }, (_, index) => addDays(values.windowStart, index));
  const firstOfMonth = `${values.date.slice(0, 7)}-01`;
  const leadingDays = (weekdayIndex(firstOfMonth) + 6) % 7;
  const gridStart = addDays(firstOfMonth, -leadingDays);
  const gridLength = Math.ceil((leadingDays + daysInMonth(values.date)) / 7) * 7;
  return Array.from({ length: gridLength }, (_, index) => addDays(gridStart, index));
};

/** A query-bound calendar that keeps its view and period in this placement's page parameters. */
export function CalendarDisplay(props: DisplayRenderProps<CalendarPayload>): ReactElement {
  const { placementId, availability } = props;
  const {
    title,
    accessibleName,
    values,
    state,
    emptyMessage,
    refusedMessage,
    errorMessage,
    events,
  } = resolveDisplayContext<CalendarPayload>(
    props,
    () => false,
    "No items in this period",
  );
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const days = values === undefined ? [] : periodDays(values);
  const dayBoundaries = new Map<string, DayBoundaries>();
  if (values?.items.some((item) => !datePattern.test(item.start))) {
    const boundaryStarts = new Map<string, number>();
    const boundaryStart = (day: string): number => {
      let start = boundaryStarts.get(day);
      if (start === undefined) {
        start = localDayStart(day, values.timeZone);
        boundaryStarts.set(day, start);
      }
      return start;
    };
    for (const day of days) {
      if (day < values.windowStart || day >= values.windowEnd) continue;
      dayBoundaries.set(day, {
        start: boundaryStart(day),
        end: boundaryStart(addDays(day, 1)),
      });
    }
  }

  const replaceParameters = (change: (parameters: URLSearchParams) => void): void => {
    const parameters = new URLSearchParams(searchParams.toString());
    change(parameters);
    const query = parameters.toString();
    router.replace(query === "" ? pathname : `${pathname}?${query}`);
  };

  if (state.status === "loading") return <RecordsLoadingState accessibleName={accessibleName} />;
  if (state.status === "empty")
    return <RecordsEmptyState accessibleName={accessibleName} message={emptyMessage} />;

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={availability}
      projectedData={state}
      emptyMessage={emptyMessage}
      {...(refusedMessage === undefined ? {} : { refusedMessage })}
      {...(errorMessage === undefined ? {} : { errorMessage })}
    >
      {values === undefined ? null : (
        <section data-vortex-display="calendar" data-vortex-placement-id={placementId}>
          <DisplayHeader title={title} accessibleName={accessibleName} events={events} />
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Calendar period">
              <Button
                type="button"
                variant="outline"
                aria-label="Previous period"
                onClick={() =>
                  replaceParameters((parameters) => {
                    const amount = values.view === "week" ? -7 : values.view === "agenda" ? -30 : 0;
                    const date = amount === 0 ? shiftMonth(values.date, -1) : addDays(values.date, amount);
                    parameters.set(`date.${placementId}`, date);
                  })
                }
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  replaceParameters((parameters) => parameters.set(`date.${placementId}`, localToday(values.timeZone)))
                }
              >
                Today
              </Button>
              <Button
                type="button"
                variant="outline"
                aria-label="Next period"
                onClick={() =>
                  replaceParameters((parameters) => {
                    const amount = values.view === "week" ? 7 : values.view === "agenda" ? 30 : 0;
                    const date = amount === 0 ? shiftMonth(values.date, 1) : addDays(values.date, amount);
                    parameters.set(`date.${placementId}`, date);
                  })
                }
              >
                Next
              </Button>
              <h3 className="min-w-36 text-center font-medium" aria-live="polite">
                {values.view === "month"
                  ? monthLabel(values.date)
                  : `${dayLabel(values.windowStart)} – ${dayLabel(addDays(values.windowEnd, -1))}`}
              </h3>
            </div>
            <div className="flex gap-1" role="group" aria-label="Calendar view">
              {calendarViews.map((view) => (
                <Button
                  key={view}
                  type="button"
                  size="sm"
                  variant={values.view === view ? "default" : "outline"}
                  aria-pressed={values.view === view}
                  onClick={() =>
                    replaceParameters((parameters) => parameters.set(`view.${placementId}`, view))
                  }
                >
                  {view === "agenda" ? "Agenda" : view[0]!.toUpperCase() + view.slice(1)}
                </Button>
              ))}
            </div>
          </div>
          {values.truncated ? (
            <p className="mb-2 text-sm text-muted-foreground" role="status">
              More items in this period than shown
            </p>
          ) : null}
          {values.items.length === 0 && !values.truncated ? (
            <RecordsEmptyState accessibleName={accessibleName} message={emptyMessage} />
          ) : values.view === "agenda" ? (
            <div className="space-y-3" data-vortex-calendar-view="agenda">
              {days.map((day) => {
                const boundaries = dayBoundaries.get(day);
                const items =
                  day >= values.windowStart && day < values.windowEnd
                    ? values.items.filter((item) =>
                        itemIntersectsDay(
                          item,
                          day,
                          boundaries,
                          values.endExclusive,
                        ),
                      )
                    : [];
                if (items.length === 0) return null;
                return (
                  <section key={day} aria-label={dayLabel(day)} className="border-b pb-2">
                    <h4 className="mb-1 font-medium">{dayLabel(day)}</h4>
                    <ul className="space-y-1">
                      {items.map((item) => (
                        <li key={item.recordId}>
                          <CalendarItemButton
                            item={item}
                            timeZone={values.timeZone}
                            events={events}
                            showTime
                          />
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          ) : (
            <div
              className={values.view === "week" ? "grid grid-cols-1 gap-2 sm:grid-cols-7" : "grid grid-cols-7 gap-1"}
              data-vortex-calendar-view={values.view}
              role="group"
              aria-label={`${values.view} calendar`}
            >
              {values.view === "month"
                ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((weekday) => (
                    <div key={weekday} className="px-1 py-2 text-center text-sm font-medium text-muted-foreground">
                      {weekday}
                    </div>
                  ))
                : null}
              {days.map((day) => {
                const inPeriod = day >= values.windowStart && day < values.windowEnd;
                const boundaries = dayBoundaries.get(day);
                const items = inPeriod
                  ? values.items.filter((item) =>
                      itemIntersectsDay(item, day, boundaries, values.endExclusive),
                    )
                  : [];
                return (
                  <Card
                    key={day}
                    size="sm"
                    role="group"
                    aria-label={dayLabel(day)}
                    className={`min-h-24 min-w-0 ${inPeriod ? "" : "bg-muted/30 text-muted-foreground"}`}
                  >
                    <CardHeader className={values.view === "month" ? "text-right" : undefined}>
                      <CardDescription>
                        {values.view === "week" ? dayLabel(day) : Number(day.slice(8, 10))}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <ul className="flex flex-col gap-1">
                        {items.map((item) => (
                          <li key={item.recordId}>
                            <CalendarItemButton
                              item={item}
                              timeZone={values.timeZone}
                              events={events}
                              showTime={values.view === "week"}
                            />
                          </li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </section>
      )}
    </DisplayStateContainer>
  );
}

const CalendarItemButton = ({
  item,
  timeZone,
  events,
  showTime,
}: Readonly<{
  item: CalendarPayload["items"][number];
  timeZone: string;
  events: DisplayRenderProps<CalendarPayload>["events"];
  showTime: boolean;
}>): ReactElement => {
  const label = item.title.trim() || "Untitled item";
  const startTime = itemTime(item.start, timeZone);
  const time = showTime ? startTime : "";
  const content = (
    <>
      {time === "" ? null : <span className="mr-1 text-muted-foreground">{time}</span>}
      <span className="break-words">{label}</span>
    </>
  );
  return events?.row_action === undefined ? (
    <span className="block px-1 py-1 text-xs">{content}</span>
  ) : (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="h-auto w-full justify-start whitespace-normal text-left"
      aria-label={`Open ${label}${startTime === "" ? "" : ` at ${startTime}`}`}
      onClick={() => events.row_action?.({ event: "row_action", recordId: item.recordId })}
    >
      {content}
    </Button>
  );
};
