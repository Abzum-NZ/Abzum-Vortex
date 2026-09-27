/** Locale-independent UTF-16 code-unit order, matching JavaScript `<`/`>` contract checks. */
export const compareCanonicalStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Serialises JSON values with recursively sorted object keys. Arrays remain in
 * their supplied order; callers must normalise unordered collections first.
 */
export const canonicalJson = (
  value: unknown,
  compareKeys: (left: string, right: string) => number = compareCanonicalStrings,
): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON accepts finite numbers only");
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry, compareKeys)).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Canonical JSON accepts JSON values only");

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, entry]) => entry === undefined))
    throw new TypeError("Canonical JSON does not accept undefined object properties");
  entries.sort(([left], [right]) => compareKeys(left, right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry, compareKeys)}`)
    .join(",")}}`;
};
