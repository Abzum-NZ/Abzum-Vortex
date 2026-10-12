import { timestampSchema } from "@vortex/contracts";

export type ExactInstant = Readonly<{ epochSecond: bigint; fraction: string }>;

/** Retains fractional precision while comparing timestamp offsets as the same instant. */
export const exactInstant = (value: string): ExactInstant | undefined => {
  if (!timestampSchema.safeParse(value).success) return undefined;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = ""] = match;
  const zone = match[8]!;
  const local = new Date(0);
  local.setUTCFullYear(Number(yearText), Number(monthText) - 1, Number(dayText));
  local.setUTCHours(Number(hourText), Number(minuteText), Number(secondText), 0);
  const localMilliseconds = local.getTime();
  if (!Number.isFinite(localMilliseconds)) return undefined;
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    offsetMinutes = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  }
  return {
    epochSecond: BigInt(localMilliseconds / 1_000 - offsetMinutes * 60),
    fraction,
  };
};

export const compareInstants = (left: ExactInstant, right: ExactInstant): -1 | 0 | 1 => {
  if (left.epochSecond < right.epochSecond) return -1;
  if (left.epochSecond > right.epochSecond) return 1;
  const scale = Math.max(left.fraction.length, right.fraction.length);
  const leftFraction = left.fraction.padEnd(scale, "0");
  const rightFraction = right.fraction.padEnd(scale, "0");
  return leftFraction < rightFraction ? -1 : leftFraction > rightFraction ? 1 : 0;
};
