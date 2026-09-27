/** Compare optional identifiers without changing the absence boundary. */
export const sameId = (
  left: string | null | undefined,
  right: string | null | undefined,
): boolean =>
  left === null || left === undefined || right === null || right === undefined
    ? left === right
    : left.toLowerCase() === right.toLowerCase();

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Convert database revision transport values before a caller validates its schema. */
export const databaseRevision = (value: unknown): unknown => {
  if (typeof value === "bigint")
    return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : value;
  }
  return value;
};

/** Convert a database timestamp without accepting an invalid Date. */
export const databaseTimestamp = (value: unknown): unknown =>
  value instanceof Date && Number.isFinite(value.valueOf()) ? value.toISOString() : value;

const uuidTextPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Storage-format UUID check; typed public identifiers use their stricter schemas. */
export const isUuidText = (value: unknown): value is string =>
  typeof value === "string" && uuidTextPattern.test(value);

export const uuidText = (value: unknown): string | undefined =>
  isUuidText(value) ? value : undefined;

export const isNonNilUuidText = (value: unknown): value is string =>
  isUuidText(value) && value.toLowerCase() !== "00000000-0000-0000-0000-000000000000";

export const unavailableError = (message: string, code?: string): Error => {
  const error = new Error(message);
  if (code !== undefined) Object.assign(error, { code });
  return error;
};

export const unavailableResult = Object.freeze({ kind: "unavailable" as const });
