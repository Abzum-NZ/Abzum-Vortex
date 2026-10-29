/** Values carried by flow inputs, outputs and other JSON contracts. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Checks JSON values without bringing schema libraries into a browser flow runner. */
export const isJsonValue = (value: unknown): value is JsonValue => {
  const ancestors = new Set<object>();
  const accepts = (entry: unknown): boolean => {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return true;
    if (typeof entry === "number") return Number.isFinite(entry);
    if (typeof entry !== "object" || ancestors.has(entry)) return false;
    if (!Array.isArray(entry)) {
      const constructor: unknown = Reflect.get(entry, "constructor");
      if (typeof constructor === "function") {
        const prototype: unknown = Reflect.get(constructor, "prototype");
        if (
          prototype === null ||
          typeof prototype !== "object" ||
          Array.isArray(prototype) ||
          !Object.hasOwn(prototype, "isPrototypeOf")
        )
          return false;
      }
    }
    ancestors.add(entry);
    let valid = true;
    if (Array.isArray(entry)) {
      for (const item of entry as unknown[]) {
        if (!accepts(item)) {
          valid = false;
          break;
        }
      }
    } else {
      for (const key of Reflect.ownKeys(entry)) {
        if (!Object.prototype.propertyIsEnumerable.call(entry, key) || key === "__proto__")
          continue;
        if (typeof key !== "string" || !accepts(Reflect.get(entry, key))) {
          valid = false;
          break;
        }
      }
    }
    ancestors.delete(entry);
    return valid;
  };
  return accepts(value);
};

/** Match record parsing's detached output and omission of the unsafe __proto__ key. */
export const cloneJsonValue = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "__proto__")
      .map(([key, member]) => [key, cloneJsonValue(member)]),
  );
};
