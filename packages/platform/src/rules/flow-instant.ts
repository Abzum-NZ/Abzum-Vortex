/** Parses a canonical or authored date-time without truncating its fractional microseconds. */
export const flowInstantMicros = (value: unknown): bigint | undefined => {
  if (typeof value !== "string") return undefined;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const local = new Date(0);
  local.setUTCHours(hour, minute, second, 0);
  local.setUTCFullYear(year, month - 1, day);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day
  )
    return undefined;
  const zone = match[8]!;
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetRemainder = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetRemainder > 59) return undefined;
    offsetMinutes = (offsetHours * 60 + offsetRemainder) * (zone[0] === "+" ? 1 : -1);
  }
  const fractionalMicros = BigInt((match[7] ?? "").padEnd(6, "0"));
  return BigInt(local.getTime() - offsetMinutes * 60_000) * 1_000n + fractionalMicros;
};
