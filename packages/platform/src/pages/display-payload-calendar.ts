import { z } from "zod";
import { timestampSchema } from "../catalogue/identifiers";
import type { CalendarView } from "./calendar-date";
import { displayTextSchema, refineUniqueKeys } from "./display-payload-parts";

const isoCalendarDatePattern = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/** A real ISO calendar date: its day exists in its month. */
const isIsoCalendarDate = (text: string): boolean => {
  if (!isoCalendarDatePattern.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number) as [number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
};

const calendarDateSchema = z.string().refine(isIsoCalendarDate, "A calendar date is an ISO date");

const calendarMomentSchema = z
  .string()
  .refine(
    (text) => isIsoCalendarDate(text) || timestampSchema.safeParse(text).success,
    "A calendar item time is an ISO date or offset timestamp",
  );

/** One permitted query row placed on a calendar day and shown with its declared title field. */
export const calendarItemSchema = z
  .object({
    recordId: displayTextSchema,
    start: calendarMomentSchema,
    end: calendarMomentSchema.nullable(),
    title: z.string(),
  })
  .strict()
  .readonly()
  .refine(
    (item) => item.end === null || isIsoCalendarDate(item.start) === isIsoCalendarDate(item.end),
    { message: "A calendar item start and end must use the same date precision", path: ["end"] },
  );

/** The server-computed bounded window and arranged calendar items for one placement. */
export const calendarPayloadSchema = z
  .object({
    kind: z.literal("calendar"),
    view: z.enum(["month", "week", "agenda"] satisfies CalendarView[]),
    date: calendarDateSchema,
    windowStart: calendarDateSchema,
    windowEnd: calendarDateSchema,
    /** The organisation's IANA time zone; the browser checks that it can show it. */
    timeZone: displayTextSchema,
    endExclusive: z.boolean(),
    truncated: z.boolean(),
    items: z
      .array(calendarItemSchema)
      .readonly()
      .superRefine((items, context) =>
        refineUniqueKeys(
          items,
          (item) => item.recordId.toLowerCase(),
          context,
          "Each calendar record appears once",
        ),
      ),
  })
  .strict()
  .readonly()
  .refine((calendar) => calendar.windowStart < calendar.windowEnd, {
    message: "A calendar window must have positive length",
    path: ["windowEnd"],
  });
export type CalendarPayload = z.output<typeof calendarPayloadSchema>;
