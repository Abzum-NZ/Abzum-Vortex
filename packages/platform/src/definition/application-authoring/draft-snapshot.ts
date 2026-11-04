/**
 * Snapshots of the application source: deeply frozen copies that share every node an edit did not
 * touch. No React, no history and no schema is imported here, so the composition modules can ask
 * whether a source is a snapshot without depending on the draft history.
 *
 * `shareSnapshot` is for the Studio draft history alone: it is called only on a source that a
 * command or the history has parsed or commit-validated.
 */

/** Every node a snapshot owns: deeply frozen, free of `undefined` properties, shared between snapshots. */
const owned = new WeakSet<object>();

/** Source is JSON; nothing deeper than this is a source, and a cycle reaches it. */
const maximumDepth = 256;

/** Whether `source` is a snapshot (frozen, shared) rather than a copy someone made. */
export const isStudioDraftSnapshot = (source: unknown): boolean =>
  source !== null && typeof source === "object" && owned.has(source);

/**
 * The frozen copy of `value` that shares every node equal to the one at the same place in
 * `previous`, so an edit costs one comparison and the nodes it did not touch keep their identity
 * (memos keyed on a page or slot object keep hitting). Nodes already frozen here are reused
 * without a look. Like the JSON the draft is stored as, an `undefined` property is left out and an
 * `undefined` list entry is `null`. A value that is not plain JSON (a Date, a Map, a class
 * instance, a cycle) is refused with a `TypeError`.
 */
export const shareSnapshot = (value: unknown, previous: unknown, depth = 0): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (owned.has(value)) return value;
  if (depth > maximumDepth) throw new TypeError("STUDIO_DRAFT_SOURCE_TOO_DEEP");
  if (Array.isArray(value)) {
    const before = Array.isArray(previous) ? previous : undefined;
    const items = value.map((item, index) =>
      item === undefined ? null : shareSnapshot(item, before?.[index], depth + 1),
    );
    if (
      before !== undefined &&
      before.length === items.length &&
      items.every((item, index) => item === before[index])
    )
      return before;
    owned.add(items);
    return Object.freeze(items);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError("STUDIO_DRAFT_SOURCE_NOT_PLAIN");
  const before =
    previous !== null && typeof previous === "object" && !Array.isArray(previous)
      ? (previous as Record<string, unknown>)
      : undefined;
  const entries = Object.entries(value).filter(([, nested]) => nested !== undefined);
  const copy: Record<string, unknown> = {};
  let same = before !== undefined && Object.keys(before).length === entries.length;
  for (const [key, nested] of entries) {
    const shared = shareSnapshot(nested, before?.[key], depth + 1);
    copy[key] = shared;
    if (same && !(before !== undefined && Object.hasOwn(before, key) && before[key] === shared))
      same = false;
  }
  if (same && before !== undefined) return before;
  owned.add(copy);
  return Object.freeze(copy);
};
