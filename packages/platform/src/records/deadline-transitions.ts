import { jsonValueSchema } from "../catalogue/common";
import {
  recordTypeDefinitionSchema,
  type ModuleField,
  type RecordTypeDefinition,
} from "../definition/module-contracts";
import { compareInstants, exactInstant, type ExactInstant } from "./exact-instant";
import { isRecord } from "../catalogue/runtime-primitives";

export type DeriveEarliestPendingDeadlineTransitionInput = Readonly<{
  recordType: RecordTypeDefinition;
  finalAuthoritativeFieldValues: Readonly<Record<string, unknown>>;
  organizationTimeZone: string;
}>;

/** The calculation field which becomes true at `transitionAt`. */
export type PendingDeadlineTransition = Readonly<{
  calculationFieldId: string;
  transitionAt: string;
}>;

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

const utcDate = (year: number, month: number, day: number): Date => {
  const output = new Date(0);
  output.setUTCFullYear(year, month, day);
  output.setUTCHours(0, 0, 0, 0);
  return output;
};

const validCalendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = utcDate(year!, month! - 1, day!);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day
  );
};

const dateAfter = (value: string): string | undefined => {
  if (!validCalendarDate(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  const after = utcDate(year!, month! - 1, day! + 1);
  return after.toISOString().slice(0, 10);
};

const localDate = (date: Date, timeZone: string): string | undefined => {
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
  } catch {
    return undefined;
  }
};

/**
 * Returns the first instant whose organisation-local date is the target day
 * or later. The latter case handles IANA transitions which skip a whole day.
 */
const startOfLocalDate = (dateText: string, timeZone: string): string | undefined => {
  if (!validCalendarDate(dateText)) return undefined;
  const [year, month, day] = dateText.split("-").map(Number);
  const target = utcDate(year!, month! - 1, day!).getTime();
  const span = 48 * 60 * 60 * 1_000;
  let lower = target - span;
  let upper = target + span;
  const lowerDate = localDate(new Date(lower), timeZone);
  const upperDate = localDate(new Date(upper), timeZone);
  if (
    lowerDate === undefined ||
    upperDate === undefined ||
    lowerDate >= dateText ||
    upperDate < dateText
  )
    return undefined;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const middleDate = localDate(new Date(middle), timeZone);
    if (middleDate === undefined) return undefined;
    if (middleDate < dateText) lower = middle + 1;
    else upper = middle;
  }
  return new Date(lower).toISOString();
};

/**
 * Finds the earliest still-pending deadline calculation from final, trusted
 * field values. It deliberately does not evaluate calculations or mutate data.
 */
export const deriveEarliestPendingDeadlineTransition = (
  input: DeriveEarliestPendingDeadlineTransitionInput,
): PendingDeadlineTransition | undefined => {
  const recordType = recordTypeDefinitionSchema.safeParse(input.recordType);
  if (
    !recordType.success ||
    !isRecord(input.finalAuthoritativeFieldValues) ||
    typeof input.organizationTimeZone !== "string"
  )
    return undefined;

  const fields = new Map(recordType.data.fields.map((field) => [field.fieldId, field]));
  let earliest:
    Readonly<{ transition: PendingDeadlineTransition; instant: ExactInstant }> | undefined;
  for (const field of recordType.data.fields) {
    if (field.type !== "calculation" || field.settings.expression.op !== "deadline_passed")
      continue;
    if (input.finalAuthoritativeFieldValues[field.fieldId] !== false) continue;

    const expression = field.settings.expression;
    const statusId =
      expression.status?.op === "reference" && expression.status.reference.source === "module_field"
        ? expression.status.reference.fieldId
        : undefined;
    const status =
      statusId === undefined ? undefined : input.finalAuthoritativeFieldValues[statusId];
    const parsedStatus = jsonValueSchema.safeParse(status);
    if (
      status !== undefined &&
      parsedStatus.success &&
      expression.terminalStatusValues.includes(parsedStatus.data)
    )
      continue;

    if (expression.due.op !== "reference" || expression.due.reference.source !== "module_field")
      continue;
    const dueId = expression.due.reference.fieldId;
    const dueField = fields.get(dueId);
    const dueValue = input.finalAuthoritativeFieldValues[dueId];
    if (!dueField || typeof dueValue !== "string") continue;

    let transitionAt: string | undefined;
    if (isDateDeadlineDueField(dueField)) {
      const followingDate = dateAfter(dueValue);
      transitionAt =
        followingDate === undefined
          ? undefined
          : startOfLocalDate(followingDate, input.organizationTimeZone);
    } else if (fieldResultType(dueField) === "date_time") transitionAt = dueValue;
    if (transitionAt === undefined) continue;
    const instant = exactInstant(transitionAt);
    if (!instant) continue;

    const transition = { calculationFieldId: field.fieldId, transitionAt };
    if (
      earliest === undefined ||
      compareInstants(instant, earliest.instant) < 0 ||
      (compareInstants(instant, earliest.instant) === 0 &&
        transition.calculationFieldId < earliest.transition.calculationFieldId)
    )
      earliest = { transition, instant };
  }
  return earliest?.transition;
};
