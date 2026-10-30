/** Record steps a For each may run as one set-based change. */
export const setBasedSteps: ReadonlySet<string> = new Set([
  "record.create",
  "record.set_fields",
  "record.link",
  "record.delete",
  "record.restore",
  "record.changes",
]);

/** The ids of the tasks a value tree reads through `{{ outputs.<task>.<key> }}`. */
const readTaskIds = (value: unknown, found: Set<string> = new Set()): Set<string> => {
  if (typeof value === "string")
    for (const match of value.matchAll(/\{\{\s*outputs\.([a-z][a-z0-9_]*)\./g))
      found.add(match[1]!);
  else if (Array.isArray(value)) for (const item of value) readTaskIds(item, found);
  else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.source === "task_output" && typeof record.task === "string") found.add(record.task);
    for (const item of Object.values(record)) readTaskIds(item, found);
  }
  return found;
};

/**
 * Whether a For each runs as one set-based change: its body is only record steps (no control
 * step), and no body step reads another body step's output, so every item's calls are known
 * before any of them runs.
 */
export const isSetBasedForEach = (
  task: Readonly<{ type: string; tasks?: readonly Readonly<{ id: string; type: string }>[] }>,
): boolean => {
  if (task.type !== "for_each" || task.tasks === undefined) return false;
  const body = task.tasks;
  const ids = new Set(body.map((child) => child.id));
  return (
    body.length > 0 &&
    body.every(
      (child) =>
        setBasedSteps.has(child.type) &&
        ![...readTaskIds(child)].some((id) => ids.has(id) && id !== child.id),
    )
  );
};
