import "server-only";

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  applicationRootIdSchema,
  builderKeySchema,
  flowIdSchema,
  flowScheduleRecurrenceSchema,
  organizationIdSchema,
  revisionSchema,
  stableDefinitionReleaseVersionSchema,
  type FlowTrigger,
} from "@vortex/contracts";

import type { KestraFlowCompilerEnvironment, KestraFlowIdentity } from "./kestra-compiler";

type ScheduleRecurrence = Extract<FlowTrigger, { type: "Schedule" }>["recurrence"];

export type ScheduleOccurrenceInput = Readonly<{
  identity: KestraFlowIdentity;
  flowId: string;
  triggerId: string;
  recurrence: ScheduleRecurrence;
  /** An exclusive UTC cursor, serialized as an ISO timestamp ending in `Z`. */
  afterUtc: string;
  /** An inclusive UTC search bound, serialized as an ISO timestamp ending in `Z`. */
  throughUtc: string;
}>;

export const scheduleOccurrenceRefusalReasons = [
  "invalid_input",
  "invalid_identity",
  "invalid_flow_id",
  "invalid_trigger_id",
  "invalid_schedule",
  "invalid_time_zone",
  "invalid_window",
  "window_too_wide",
  "candidate_limit_exceeded",
] as const;

export type ScheduleOccurrenceRefusalReason =
  (typeof scheduleOccurrenceRefusalReasons)[number];

export type ScheduleOccurrenceResult =
  | Readonly<{
      outcome: "occurrence";
      scheduledForUtc: string;
      occurrenceId: string;
    }>
  | Readonly<{ outcome: "none" }>
  | Readonly<{
      outcome: "refused";
      reason: ScheduleOccurrenceRefusalReason;
    }>;

const dayMs = 24 * 60 * 60 * 1_000;
const hourMs = 60 * 60 * 1_000;
const searchMarginMs = 2 * dayMs;
const maximumWindowMs = 366 * dayMs;
const maximumExaminedSlots = 10_000;
const maximumTimeZoneOffsetMs = dayMs;

const inputKeys = ["identity", "flowId", "triggerId", "recurrence", "afterUtc", "throughUtc"];
const identityKeys = [
  "environment",
  "organizationId",
  "applicationRootId",
  "applicationVersion",
  "installationRevision",
  "workflowRevision",
];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean => Object.keys(value).every((key) => allowed.includes(key));

const isEnvironment = (value: unknown): value is KestraFlowCompilerEnvironment =>
  value === "local" || value === "testing" || value === "production";

const parseIdentity = (candidate: unknown): KestraFlowIdentity | undefined => {
  if (!isRecord(candidate) || !hasOnlyKeys(candidate, identityKeys)) return undefined;
  if (!isEnvironment(candidate.environment)) return undefined;

  const organizationId = organizationIdSchema.safeParse(candidate.organizationId);
  const applicationRootId = applicationRootIdSchema.safeParse(candidate.applicationRootId);
  const applicationVersion = stableDefinitionReleaseVersionSchema.safeParse(
    candidate.applicationVersion,
  );
  const installationRevision = revisionSchema.safeParse(candidate.installationRevision);
  const workflowRevision = revisionSchema.safeParse(candidate.workflowRevision);
  if (
    !organizationId.success ||
    !applicationRootId.success ||
    !applicationVersion.success ||
    !installationRevision.success ||
    !workflowRevision.success
  )
    return undefined;

  return {
    environment: candidate.environment,
    organizationId: organizationId.data.toLowerCase() as KestraFlowIdentity["organizationId"],
    applicationRootId: applicationRootId.data.toLowerCase() as KestraFlowIdentity[
      "applicationRootId"
    ],
    applicationVersion: applicationVersion.data,
    installationRevision: installationRevision.data,
    workflowRevision: workflowRevision.data,
  };
};

const civilEpoch = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): number => {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, millisecond);
  return date.getTime();
};

const utcInstantPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

const parseUtcInstant = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const match = utcInstantPattern.exec(value);
  if (!match) return undefined;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText] = match;
  const year = Number(yearText);
  const month = Number(monthText) - 1;
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = fractionText === undefined ? 0 : Number(fractionText.padEnd(3, "0"));
  if (
    month < 0 ||
    month > 11 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return undefined;

  const epoch = civilEpoch(year, month, day, hour, minute, second, millisecond);
  if (!Number.isFinite(epoch)) return undefined;
  const date = new Date(epoch);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== millisecond
  )
    return undefined;
  return epoch;
};

type CivilParts = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}>;

const makeZoneFormatter = (timeZone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    era: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

const zoneParts = (formatter: Intl.DateTimeFormat, epoch: number): CivilParts => {
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(epoch)).map(({ type, value }) => [type, value]),
  );
  const displayedYear = Number(parts.year);
  const year = parts.era === "BC" || parts.era === "BCE" ? 1 - displayedYear : displayedYear;
  const result = {
    year,
    month: Number(parts.month) - 1,
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
  if (
    !Number.isInteger(result.year) ||
    result.month < 0 ||
    result.month > 11 ||
    result.day < 1 ||
    result.day > 31 ||
    result.hour < 0 ||
    result.hour > 23 ||
    result.minute < 0 ||
    result.minute > 59 ||
    result.second < 0 ||
    result.second > 59
  )
    throw new RangeError("Time zone formatting did not produce civil date parts");
  return result;
};

const offsetAt = (formatter: Intl.DateTimeFormat, epoch: number): number => {
  const parts = zoneParts(formatter, epoch);
  return civilEpoch(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ) - epoch;
};

const sameLocalMinute = (left: CivilParts, right: CivilParts): boolean =>
  left.year === right.year &&
  left.month === right.month &&
  left.day === right.day &&
  left.hour === right.hour &&
  left.minute === right.minute &&
  left.second === right.second;

type LocalSlot = Readonly<{ fields: CivilParts | undefined; wallEpoch: number | undefined }>;

const fieldsForWallEpoch = (wallEpoch: number): CivilParts => {
  const date = new Date(wallEpoch);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
};

const daysInMonth = (year: number, month: number): number =>
  new Date(civilEpoch(year, month + 1, 0)).getUTCDate();

function* enumerateLocalSlots(
  recurrence: ScheduleRecurrence,
  startWallEpoch: number,
  endWallEpoch: number,
): Generator<LocalSlot> {
  const hour = recurrence.cadence === "hourly" ? 0 : (recurrence.hour ?? 0);
  const { minute } = recurrence;

  if (recurrence.cadence === "hourly") {
    // Count every Nth civil hour from local 1970-01-01 00:00, at the declared minute.
    const anchor = civilEpoch(1970, 0, 1, 0, minute);
    const step = recurrence.interval * hourMs;
    const first = anchor + Math.ceil((startWallEpoch - anchor) / step) * step;
    for (let wallEpoch = first; wallEpoch <= endWallEpoch; wallEpoch += step)
      yield { fields: fieldsForWallEpoch(wallEpoch), wallEpoch };
    return;
  }

  if (recurrence.cadence === "daily") {
    // Count every Nth local date from 1970-01-01 at the declared wall-clock time.
    const anchor = civilEpoch(1970, 0, 1, hour, minute);
    const step = recurrence.interval * dayMs;
    const first = anchor + Math.ceil((startWallEpoch - anchor) / step) * step;
    for (let wallEpoch = first; wallEpoch <= endWallEpoch; wallEpoch += step)
      yield { fields: fieldsForWallEpoch(wallEpoch), wallEpoch };
    return;
  }

  if (recurrence.cadence === "weekly") {
    // ISO weeks begin Monday 1969-12-29; the declared weekday selects a date in that week.
    const anchor = civilEpoch(
      1969,
      11,
      29 + (recurrence.weekDay ?? 1) - 1,
      hour,
      minute,
    );
    const step = recurrence.interval * 7 * dayMs;
    const first = anchor + Math.ceil((startWallEpoch - anchor) / step) * step;
    for (let wallEpoch = first; wallEpoch <= endWallEpoch; wallEpoch += step)
      yield { fields: fieldsForWallEpoch(wallEpoch), wallEpoch };
    return;
  }

  const startDate = new Date(startWallEpoch);
  const endDate = new Date(endWallEpoch);
  // Monthly intervals count forward from January 1970, skipping months without monthDay.
  const anchorMonth = 1970 * 12;
  const startMonth = startDate.getUTCFullYear() * 12 + startDate.getUTCMonth();
  const endMonth = endDate.getUTCFullYear() * 12 + endDate.getUTCMonth();
  const firstMonth =
    anchorMonth + Math.ceil((startMonth - anchorMonth) / recurrence.interval) * recurrence.interval;
  for (let monthIndex = firstMonth; monthIndex <= endMonth; monthIndex += recurrence.interval) {
    const year = Math.floor(monthIndex / 12);
    const month = monthIndex - year * 12;
    const monthDay = recurrence.monthDay ?? 1;
    if (monthDay > daysInMonth(year, month)) {
      yield { fields: undefined, wallEpoch: undefined };
      continue;
    }
    const wallEpoch = civilEpoch(year, month, monthDay, hour, minute);
    if (wallEpoch >= startWallEpoch) {
      if (wallEpoch > endWallEpoch) break;
      yield { fields: fieldsForWallEpoch(wallEpoch), wallEpoch };
    }
  }
}

const occurrenceDigest = (
  identity: KestraFlowIdentity,
  flowId: string,
  triggerId: string,
  scheduledForUtc: string,
): string => {
  const framedValues = [
    "vortex.schedule-occurrence.v1",
    identity.environment,
    identity.organizationId,
    identity.applicationRootId,
    identity.applicationVersion,
    String(identity.installationRevision),
    String(identity.workflowRevision),
    flowId,
    triggerId,
    scheduledForUtc,
  ]
    .map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`)
    .join("");
  return createHash("sha256").update(framedValues, "utf8").digest("hex");
};

const refused = (reason: ScheduleOccurrenceRefusalReason): ScheduleOccurrenceResult => ({
  outcome: "refused",
  reason,
});

/**
 * Finds the earliest published Schedule occurrence after the cursor and no later than the bound.
 * The recurrence is enumerated in anchored local civil time, then resolved through the runtime's
 * IANA database. Gaps and absent month days are skipped; folds keep their earlier UTC instant.
 */
export const computeNextScheduleOccurrence = (candidate: unknown): ScheduleOccurrenceResult => {
  try {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, inputKeys)) return refused("invalid_input");

    const identity = parseIdentity(candidate.identity);
    if (!identity) return refused("invalid_identity");

    const flowId = flowIdSchema.safeParse(candidate.flowId);
    if (!flowId.success) return refused("invalid_flow_id");
    const triggerId = builderKeySchema.safeParse(candidate.triggerId);
    if (!triggerId.success) return refused("invalid_trigger_id");

    const recurrence = flowScheduleRecurrenceSchema.safeParse(candidate.recurrence);
    if (!recurrence.success) return refused("invalid_schedule");

    const afterEpoch = parseUtcInstant(candidate.afterUtc);
    const throughEpoch = parseUtcInstant(candidate.throughUtc);
    if (
      afterEpoch === undefined ||
      throughEpoch === undefined ||
      throughEpoch <= afterEpoch
    )
      return refused("invalid_window");
    if (throughEpoch - afterEpoch > maximumWindowMs) return refused("window_too_wide");

    let formatter: Intl.DateTimeFormat;
    try {
      formatter = makeZoneFormatter(recurrence.data.timeZone);
      formatter.formatToParts(new Date(afterEpoch));
    } catch {
      return refused("invalid_time_zone");
    }

    // The two-day margins on both UTC bounds contain every possible local slot whose UTC
    // instant is in the requested window, including zones with large historical offset jumps.
    const startWallEpoch = afterEpoch - searchMarginMs;
    const endWallEpoch = throughEpoch + searchMarginMs;
    const offsetsByUtcDay = new Map<number, ReadonlySet<number>>();
    const offsetsNearWall = (wallEpoch: number): readonly number[] => {
      const utcDay = Math.floor(wallEpoch / dayMs);
      const offsets = new Set<number>();
      // Every valid IANA UTC offset is under one day, so these full UTC days contain all
      // possible instants for this local minute. Hourly sampling captures both sides of a
      // daylight-saving transition while keeping a year-long hourly request bounded.
      for (let day = utcDay - 2; day <= utcDay + 2; day += 1) {
        let dayOffsets = offsetsByUtcDay.get(day);
        if (!dayOffsets) {
          const sampled = new Set<number>();
          for (let hour = 0; hour < 24; hour += 1) {
            const offset = offsetAt(formatter, day * dayMs + hour * hourMs);
            if (Math.abs(offset) > maximumTimeZoneOffsetMs)
              throw new RangeError("Unsupported UTC offset");
            sampled.add(offset);
          }
          dayOffsets = sampled;
          offsetsByUtcDay.set(day, dayOffsets);
        }
        for (const offset of dayOffsets) offsets.add(offset);
      }
      return [...offsets];
    };

    let examinedSlots = 0;
    let earliestEpoch: number | undefined;
    for (const slot of enumerateLocalSlots(recurrence.data, startWallEpoch, endWallEpoch)) {
      examinedSlots += 1;
      if (examinedSlots > maximumExaminedSlots)
        return refused("candidate_limit_exceeded");
      if (slot.fields === undefined || slot.wallEpoch === undefined) continue;

      const matches = new Set<number>();
      for (const offset of offsetsNearWall(slot.wallEpoch)) {
        const instant = slot.wallEpoch - offset;
        if (sameLocalMinute(zoneParts(formatter, instant), slot.fields)) matches.add(instant);
      }
      if (matches.size === 0) continue;

      // A fold can map one civil minute to two UTC instants. Keeping the earlier one gives
      // that local schedule slot exactly one canonical occurrence.
      const earlierFoldInstant = Math.min(...matches);
      if (earlierFoldInstant <= afterEpoch || earlierFoldInstant > throughEpoch) continue;
      if (earliestEpoch === undefined || earlierFoldInstant < earliestEpoch)
        earliestEpoch = earlierFoldInstant;
    }

    if (earliestEpoch === undefined) return { outcome: "none" };
    const scheduledForUtc = new Date(earliestEpoch).toISOString();
    return {
      outcome: "occurrence",
      scheduledForUtc,
      occurrenceId: `schedule_${occurrenceDigest(
        identity,
        flowId.data.toLowerCase(),
        triggerId.data,
        scheduledForUtc,
      )}`,
    };
  } catch {
    return refused("invalid_input");
  }
};
