import { type ModuleField } from "../definition/module-contracts";

const fieldResultType = (field: ModuleField): string =>
  field.type === "calculation" || field.type === "total" ? field.settings.resultType : field.type;

/**
 * The single date-due decision shared by the deadline scheduler and the save
 * path. A deadline is date-based when its due field yields a calendar date: a
 * plain date field, or a calculation or total whose declared result is a date.
 * Both a calculation and a total must compare against the organisation-local
 * date rather than the UTC date, so they are treated identically here.
 */
export const isDateDeadlineDueField = (field: ModuleField): boolean =>
  fieldResultType(field) === "date";

/** The calendar date of an instant in a time zone, or undefined for an unknown zone. */
export const localDate = (date: Date, timeZone: string): string | undefined => {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value;
    const year = value("year");
    const month = value("month");
    const day = value("day");
    return year && month && day ? `${year}-${month}-${day}` : undefined;
    // guard-allow: silent-catch Intl throws for an unknown time zone; the caller treats the date as unknown.
  } catch {
    return undefined;
  }
};
