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

export const isNonNilUuidText = (value: unknown): value is string =>
  isUuidText(value) && value.toLowerCase() !== "00000000-0000-0000-0000-000000000000";

export const unavailableError = (message: string, code?: string, cause?: unknown): Error => {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  if (code !== undefined) Object.assign(error, { code });
  return error;
};

export const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

/**
 * A safe server-side description of a failed request: only the error class name and code of the
 * error and its causes, never a message, value, identity or secret, so it can be logged without
 * being shown to the browser or leaking data.
 */
export const describeFailure = (error: unknown): string => {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    const name = current instanceof Error ? current.name : typeof current;
    const code = databaseCode(current);
    // A database error's message is its stable cause code (never row data), so it stays in the log.
    // A schema mismatch is described by the failing paths and issue codes, never the values.
    const detail =
      current instanceof Error && name === "VortexDatabaseError"
        ? `:${current.message}`
        : isRecord(current) && Array.isArray(current.issues)
          ? `:${current.issues
              .map(
                (issue: { path?: readonly unknown[]; code?: unknown }) =>
                  `${(issue.path ?? []).join(".")}=${String(issue.code)}`,
              )
              .join(",")}`
          : "";
    parts.push(code === undefined ? `${name}${detail}` : `${name}${detail}(${code})`);
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(" <- ");
};

/**
 * The one server-side line for a refusal or a caught failure: the route or service, the operation,
 * a stable reason code and, when there is one, the safe description of its cause (class names and
 * codes only). Ids may be part of `op`; personal data, values and secrets never are.
 */
export const logRefusal = (route: string, op: string, code: string, cause?: unknown): void => {
  console.error(
    `[${route}] ${op} refused: code=${code}${cause === undefined ? "" : ` cause=${describeFailure(cause)}`}`,
  );
};

export const unavailableResult = Object.freeze({ kind: "unavailable" as const });
