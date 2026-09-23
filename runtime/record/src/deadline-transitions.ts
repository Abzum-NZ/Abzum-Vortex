import {
  jsonValueSchema,
  recordTypeDefinitionV2Schema,
  timestampSchema,
  type ModuleFieldV2,
  type RecordTypeDefinitionV2,
} from "@vortex/contracts";
import type { RelationshipTotalParentMutation } from "./relationship-total-save";

export type DeriveEarliestPendingDeadlineTransitionV2Input = Readonly<{
  recordType: RecordTypeDefinitionV2;
  finalAuthoritativeFieldValues: Readonly<Record<string, unknown>>;
  organizationTimeZone: string;
}>;

/** The calculation field which becomes true at `transitionAt`. */
export type PendingDeadlineTransitionV2 = Readonly<{
  calculationFieldId: string;
  transitionAt: string;
}>;

type ExactInstant = Readonly<{ epochSecond: bigint; fraction: string }>;

const isValueMap = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const fieldResultType = (field: ModuleFieldV2): string =>
  field.type === "calculation" || field.type === "total" ? field.settings.resultType : field.type;

/**
 * The single date-due decision shared by the deadline scheduler and the save
 * path. A deadline is date-based when its due field yields a calendar date: a
 * plain date field, or a calculation or total whose declared result is a date.
 * Both a calculation and a total must compare against the organisation-local
 * date rather than the UTC date, so they are treated identically here.
 */
export const isDateDeadlineDueFieldV2 = (field: ModuleFieldV2): boolean =>
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

const exactInstant = (value: string): ExactInstant | undefined => {
  if (!timestampSchema.safeParse(value).success) return undefined;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = ""] = match;
  const zone = match[8]!;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const local = utcDate(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    offsetMinutes = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  }
  return {
    epochSecond: BigInt(local.getTime() / 1_000 - offsetMinutes * 60),
    fraction,
  };
};

const compareInstants = (left: ExactInstant, right: ExactInstant): -1 | 0 | 1 => {
  if (left.epochSecond < right.epochSecond) return -1;
  if (left.epochSecond > right.epochSecond) return 1;
  const scale = Math.max(left.fraction.length, right.fraction.length);
  const leftFraction = left.fraction.padEnd(scale, "0");
  const rightFraction = right.fraction.padEnd(scale, "0");
  return leftFraction < rightFraction ? -1 : leftFraction > rightFraction ? 1 : 0;
};

/**
 * Finds the earliest still-pending deadline calculation from final, trusted
 * field values. It deliberately does not evaluate calculations or mutate data.
 */
export const deriveEarliestPendingDeadlineTransitionV2 = (
  input: DeriveEarliestPendingDeadlineTransitionV2Input,
): PendingDeadlineTransitionV2 | undefined => {
  const recordType = recordTypeDefinitionV2Schema.safeParse(input.recordType);
  if (
    !recordType.success ||
    !isValueMap(input.finalAuthoritativeFieldValues) ||
    typeof input.organizationTimeZone !== "string"
  )
    return undefined;

  const fields = new Map(recordType.data.fields.map((field) => [field.fieldId, field]));
  let earliest:
    Readonly<{ transition: PendingDeadlineTransitionV2; instant: ExactInstant }> | undefined;
  for (const field of recordType.data.fields) {
    if (field.type !== "calculation" || field.settings.expression.kind !== "deadline_passed")
      continue;
    if (input.finalAuthoritativeFieldValues[field.fieldId] !== false) continue;

    const expression = field.settings.expression;
    const status = expression.statusFieldId
      ? input.finalAuthoritativeFieldValues[expression.statusFieldId]
      : undefined;
    const parsedStatus = jsonValueSchema.safeParse(status);
    if (
      status !== undefined &&
      parsedStatus.success &&
      expression.terminalStatusValues.includes(parsedStatus.data)
    )
      continue;

    const dueField = fields.get(expression.dueFieldId);
    const dueValue = input.finalAuthoritativeFieldValues[expression.dueFieldId];
    if (!dueField || typeof dueValue !== "string") continue;

    let transitionAt: string | undefined;
    if (fieldResultType(dueField) === "date") {
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

/** The minimal locked-record shape needed to re-derive a parent's due transition. */
export type DeadlineDueParentRecordLookup = Readonly<{
  recordKey: string;
  recordId?: string;
  recordType: RecordTypeDefinitionV2;
  existingValues: Readonly<Record<string, unknown>>;
}>;

/**
 * The next due transition of one submitted relationship-total parent, keyed by
 * the revision the parent writer expects. `null` cancels the parent's due row.
 */
export type ParentDeadlineDueTransition = Readonly<{
  storageContractId: string;
  recordTypeId: string;
  recordId: string;
  expectedConcurrencyNumber: number;
  dueTransition: PendingDeadlineTransitionV2 | null;
}>;

/**
 * Derives the next due transition for every submitted parent mutation. The
 * SQL composer applies it only to a parent whose revision the shared parent
 * writer actually advanced, so this never predicts which values change.
 */
export const deriveParentDeadlineDueTransitions = (
  parentMutations: readonly RelationshipTotalParentMutation[],
  records: readonly DeadlineDueParentRecordLookup[],
  organizationTimeZone: string,
): readonly ParentDeadlineDueTransition[] =>
  parentMutations.map((mutation) => {
    const record = records.find(
      (candidate) =>
        candidate.recordKey !== "root" &&
        candidate.recordId === mutation.recordId &&
        candidate.recordType.recordTypeId === mutation.recordTypeId,
    );
    if (record === undefined) throw new Error("RECORD_DEADLINE_PARENT_UNAVAILABLE");
    return {
      storageContractId: record.recordType.storageContractId,
      recordTypeId: mutation.recordTypeId,
      recordId: mutation.recordId,
      expectedConcurrencyNumber: mutation.expectedConcurrencyNumber,
      dueTransition:
        deriveEarliestPendingDeadlineTransitionV2({
          recordType: record.recordType,
          finalAuthoritativeFieldValues: { ...record.existingValues, ...mutation.finalValues },
          organizationTimeZone,
        }) ?? null,
    };
  });
