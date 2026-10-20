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
  // A definition repeats the same property names across thousands of fields and placements.
  // Encode each name once in this serialization, without retaining any values between calls.
  const encodedKeys = new Map<string, string>();
  const serialize = (entry: unknown): string => {
    if (entry === null || typeof entry === "boolean" || typeof entry === "string")
      return JSON.stringify(entry);
    if (typeof entry === "number") {
      if (!Number.isFinite(entry))
        throw new TypeError("Canonical JSON accepts finite numbers only");
      return JSON.stringify(entry);
    }
    if (Array.isArray(entry)) return `[${entry.map(serialize).join(",")}]`;
    if (typeof entry !== "object") throw new TypeError("Canonical JSON accepts JSON values only");

    const object = entry as Record<string, unknown>;
    const keys = Object.keys(object);
    if (keys.some((key) => object[key] === undefined))
      throw new TypeError("Canonical JSON does not accept undefined object properties");
    keys.sort(compareKeys);
    return `{${keys
      .map((key) => {
        let encoded = encodedKeys.get(key);
        if (encoded === undefined) {
          encoded = JSON.stringify(key);
          encodedKeys.set(key, encoded);
        }
        return `${encoded}:${serialize(object[key])}`;
      })
      .join(",")}}`;
  };
  return serialize(value);
};

const assertCanonicalValueKind = (value: unknown): void => {
  const kind = typeof value;
  if (typeof value === "number" && !Number.isFinite(value))
    throw new TypeError("Canonical JSON accepts finite numbers only");
  if (kind !== "object" && kind !== "boolean" && kind !== "string" && kind !== "number")
    throw new TypeError("Canonical JSON accepts JSON values only");
};

/** Equality of validated JSON values: object key order is immaterial, array order is not. */
export const sameCanonicalValue = (left: unknown, right: unknown): boolean => {
  assertCanonicalValueKind(left);
  assertCanonicalValueKind(right);
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => sameCanonicalValue(entry, right[index]))
    );
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        sameCanonicalValue(Reflect.get(left, key), Reflect.get(right, key)),
    )
  );
};
