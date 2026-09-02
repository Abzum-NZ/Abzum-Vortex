import { createHash } from "node:crypto";

/**
 * Serialises JSON values with recursively sorted object keys. Arrays remain in
 * their supplied order; callers must normalise collections whose order is not
 * meaningful before hashing them.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON accepts finite numbers only");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Canonical JSON accepts JSON values only");

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, entry]) => entry === undefined))
    throw new TypeError("Canonical JSON does not accept undefined object properties");
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
};

export const fingerprintCanonicalValue = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
