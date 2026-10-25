"use client";

import type { ReactElement } from "react";
import {
  addressParameter,
  calendarAddDays as addDays,
  calendarDaysInMonth,
  calendarDaysSinceMonday,
  calendarLocalDate,
  calendarMonthStart,
  calendarPeriodSupported,
  calendarShiftMonth,
  calendarStartOfDay,
} from "@vortex/platform/schema";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "../components/button";
import { Card, CardContent, CardDescription, CardHeader } from "../components/card";
import { DisplayHeader, RecordsEmptyState, RecordsLoadingState } from "./controls";
import { resolveDisplayContext, rowActionEventIdOf, type DisplayRenderProps } from "./context";
import { DisplayStateContainer } from "./display-state-container";
import { formatIsoDate } from "./date-format";
import { useDateFormatOptions } from "./date-format-context";
import type { CalendarPayload, CalendarView } from "./projected-data";

const calendarViews: readonly CalendarView[] = ["month", "week", "agenda"];
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
type DayBoundaries = Readonly<{ start: number; end: number }>;

const localToday = (timeZone: string): string => calendarLocalDate(Date.now(), timeZone);

const itemIntersectsDay = (
  item: CalendarPayload["items"][number],
  day: string,
  boundaries: DayBoundaries | undefined,
  endExclusive: boolean,
): boolean => {
  if (datePattern.test(item.start)) {
    const startDay = item.start;
    const endDay = item.end ?? startDay;
    return startDay <= day && (endExclusive && endDay > startDay ? endDay > day : endDay >= day);
  }
  if (boundaries === undefined)
    throw new Error("A timestamped calendar item requires precomputed day boundaries");
  const start = Date.parse(item.start);
  const end = item.end === null ? start : Date.parse(item.end);
  return (
    start < boundaries.end &&
    (endExclusive && end > start ? end > boundaries.start : end >= boundaries.start)
  );
};

const dayLabel = (date: string, locale: string | undefined): string => {
  const label = formatIsoDate(date, { locale }, "weekday");
  if (label === undefined) throw new Error("A calendar day must be a valid ISO date");
  return label;
};

const monthLabel = (date: string, locale: string | undefined): string => {
  const label = formatIsoDate(`${date.slice(0, 7)}-01`, { locale }, "month");
  if (label === undefined) throw new Error("A calendar month must be a valid ISO date");
  return label;
};

const itemTime = (value: string, timeZone: string, locale: string | undefined): string => {
  if (datePattern.test(value)) return "";
  const label = formatIsoDate(value, { locale, timeZone }, "time");
  if (label === undefined) throw new Error("A calendar item must have a valid ISO timestamp");
  return label;
};

const periodDays = (values: CalendarPayload): readonly string[] => {
  if (values.view === "week")
    return Array.from({ length: 7 }, (_, index) => addDays(values.windowStart, index));
  if (values.view === "agenda")
    return Array.from({ length: 30 }, (_, index) => addDays(values.windowStart, index));
  const firstOfMonth = calendarMonthStart(values.date);
  const leadingDays = calendarDaysSinceMonday(firstOfMonth);
  const gridStart = addDays(firstOfMonth, -leadingDays);
  const gridLength = Math.ceil((leadingDays + calendarDaysInMonth(values.date)) / 7) * 7;
  return Array.from({ length: gridLength }, (_, index) => addDays(gridStart, index));
};

/** A query-bound calendar that keeps its view and period in this placement's page parameters. */
export function CalendarDisplay(props: DisplayRenderProps<CalendarPayload>): ReactElement {
  const { locale } = useDateFormatOptions();
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
  } = resolveDisplayContext<CalendarPayload>(props, () => false, "No items in this period");
  const rowActionEventId = events?.row_action === undefined ? undefined : rowActionEventIdOf(props);
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
        start = Date.parse(calendarStartOfDay(day, values.timeZone));
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

  const periodStep = values?.view === "week" ? 7 : values?.view === "agenda" ? 30 : 0;
  const shiftedDate = (direction: 1 | -1): string =>
    values === undefined
      ? ""
      : periodStep === 0
        ? calendarShiftMonth(values.date, direction)
        : addDays(values.date, direction * periodStep);
  const previousDate = shiftedDate(-1);
  const nextDate = shiftedDate(1);

  const replaceParameters = (change: (parameters: URLSearchParams) => void): void => {
    const parameters = new URLSearchParams(searchParams.toString());
    change(parameters);
    const query = parameters.toString();
    router.replace(query === "" ? pathname : `${pathname}?${query}`);
  };

  if (state.status === "loading") return <RecordsLoadingState accessibleName={accessibleName} />;
  if (state.status === "empty")
    return <RecordsEmptyState accessibleName={accessibleName} message={emptyMessage} />;

  // A malformed or unsupported period must leave the definition's current period reachable.
  if (values === undefined && searchParams.has(addressParameter("date", placementId)))
    return (
      <>
        <DisplayStateContainer
          accessibleName={accessibleName}
          availability={availability}
          projectedData={state}
          emptyMessage={emptyMessage}
          {...(refusedMessage === undefined ? {} : { refusedMessage })}
          {...(errorMessage === undefined ? {} : { errorMessage })}
        >
          {null}
        </DisplayStateContainer>
        <Button
          type="button"
          variant="outline"
          className="mt-2"
          onClick={() =>
            replaceParameters((parameters) =>
              parameters.delete(addressParameter("date", placementId)),
            )
          }
        >
          Go to the current period
        </Button>
      </>
    );

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
            <div
              className="flex flex-wrap items-center gap-2"
              role="group"
              aria-label="Calendar period"
            >
              <Button
                type="button"
                variant="outline"
                aria-label="Previous period"
                disabled={!calendarPeriodSupported(values.view, previousDate, values.timeZone)}
                onClick={() =>
                  replaceParameters((parameters) =>
                    parameters.set(addressParameter("date", placementId), previousDate),
                  )
                }
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  replaceParameters((parameters) =>
                    parameters.set(
                      addressParameter("date", placementId),
                      localToday(values.timeZone),
                    ),
                  )
                }
              >
                Today
              </Button>
              <Button
                type="button"
                variant="outline"
                aria-label="Next period"
                disabled={!calendarPeriodSupported(values.view, nextDate, values.timeZone)}
                onClick={() =>
                  replaceParameters((parameters) =>
                    parameters.set(addressParameter("date", placementId), nextDate),
                  )
                }
              >
                Next
              </Button>
              <h3 className="min-w-36 text-center font-medium" aria-live="polite">
                {values.view === "month"
                  ? monthLabel(values.date, locale)
                  : `${dayLabel(values.windowStart, locale)} – ${dayLabel(addDays(values.windowEnd, -1), locale)}`}
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
                  disabled={!calendarPeriodSupported(view, values.date, values.timeZone)}
                  onClick={() =>
                    replaceParameters((parameters) =>
                      parameters.set(addressParameter("calendar", placementId), view),
                    )
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
                        itemIntersectsDay(item, day, boundaries, values.endExclusive),
                      )
                    : [];
                if (items.length === 0) return null;
                return (
                  <section key={day} aria-label={dayLabel(day, locale)} className="border-b pb-2">
                    <h4 className="mb-1 font-medium">{dayLabel(day, locale)}</h4>
                    <ul className="space-y-1">
                      {items.map((item) => (
                        <li key={item.recordId}>
                          <CalendarItemButton
                            item={item}
                            timeZone={values.timeZone}
                            locale={locale}
                            events={events}
                            rowActionEventId={rowActionEventId}
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
              className={
                values.view === "week"
                  ? "grid grid-cols-1 gap-2 sm:grid-cols-7"
                  : "grid grid-cols-7 gap-1"
              }
              data-vortex-calendar-view={values.view}
              role="group"
              aria-label={`${values.view} calendar`}
            >
              {values.view === "month"
                ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((weekday) => (
                    <div
                      key={weekday}
                      className="px-1 py-2 text-center text-sm font-medium text-muted-foreground"
                    >
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
                    aria-label={dayLabel(day, locale)}
                    className={`min-h-24 min-w-0 ${inPeriod ? "" : "bg-muted/30 text-muted-foreground"}`}
                  >
                    <CardHeader className={values.view === "month" ? "text-right" : undefined}>
                      <CardDescription>
                        {values.view === "week" ? dayLabel(day, locale) : Number(day.slice(8, 10))}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <ul className="flex flex-col gap-1">
                        {items.map((item) => (
                          <li key={item.recordId}>
                            <CalendarItemButton
                              item={item}
                              timeZone={values.timeZone}
                              locale={locale}
                              events={events}
                              rowActionEventId={rowActionEventId}
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
  locale,
  events,
  rowActionEventId,
  showTime,
}: Readonly<{
  item: CalendarPayload["items"][number];
  timeZone: string;
  locale: string | undefined;
  events: DisplayRenderProps<CalendarPayload>["events"];
  /** The block's `row_action_event_id`; read only while a row action is bound. */
  rowActionEventId: string | undefined;
  showTime: boolean;
}>): ReactElement => {
  const label = item.title.trim() || "Untitled item";
  const startTime = itemTime(item.start, timeZone, locale);
  const time = showTime ? startTime : "";
  const content = (
    <>
      {time === "" ? null : <span className="mr-1 text-muted-foreground">{time}</span>}
      <span className="break-words">{label}</span>
    </>
  );
  return events?.row_action === undefined || rowActionEventId === undefined ? (
    <span className="block px-1 py-1 text-xs">{content}</span>
  ) : (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="h-auto w-full justify-start whitespace-normal text-left"
      aria-label={`Open ${label}${startTime === "" ? "" : ` at ${startTime}`}`}
      onClick={() =>
        events.row_action?.({
          event: "row_action",
          eventId: rowActionEventId,
          recordId: item.recordId,
        })
      }
    >
      {content}
    </Button>
  );
};
