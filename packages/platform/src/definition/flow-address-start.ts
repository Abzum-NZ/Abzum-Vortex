import { protectedOperationMetadata } from "./protected-operation-metadata";

/**
 * A binding may say its flow can be started by a link to the page (`startFromAddress`). A link is
 * followed with the person's own session, so a flow started that way must ask before it changes
 * anything: its first change is always preceded by a confirmation or a form the person answers.
 * A read, a message or a refresh may come first. This is the one place that rule is judged.
 */

type Node = Readonly<Record<string, unknown>>;
type Walked = Readonly<{ guarded: boolean; unguardedChange: boolean }>;

const guardTypes: ReadonlySet<string> = new Set(["interface.confirm", "interface.show_form"]);
const changeTypes: ReadonlySet<string> = new Set([
  "record.save",
  "record.create",
  "record.set_fields",
  "record.link",
  "record.delete",
  "record.restore",
  "backend.run",
  "event.announce",
  "run_flow",
  "form.save_draft",
  "form.discard_draft",
  "data.record_link",
]);

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An operation call changes something unless its registered operation only reads. */
const operationChanges = (task: Node): boolean => {
  const properties = isNode(task.properties) ? task.properties : {};
  const operation = isNode(properties.operation) ? properties.operation : {};
  const literal = isNode(operation.literal) ? operation.literal : {};
  const name = typeof literal.value === "string" ? literal.value : "";
  const key = name.startsWith("platform.") ? name.slice("platform.".length) : name;
  const metadata = (protectedOperationMetadata as Record<string, { transaction: string }>)[key];
  return metadata === undefined || metadata.transaction !== "read";
};

const walkTasks = (tasks: unknown, guarded: boolean): Walked => {
  if (!Array.isArray(tasks)) return { guarded, unguardedChange: false };
  let state = guarded;
  for (const task of tasks) {
    if (!isNode(task)) continue;
    const walked = walkTask(task, state);
    if (walked.unguardedChange) return walked;
    state = walked.guarded;
  }
  return { guarded: state, unguardedChange: false };
};

const walkTask = (task: Node, guarded: boolean): Walked => {
  const type = typeof task.type === "string" ? task.type : "";
  if (guardTypes.has(type)) return { guarded: true, unguardedChange: false };
  if (changeTypes.has(type) || (type === "operation.call" && operationChanges(task)))
    return guarded ? { guarded, unguardedChange: false } : { guarded, unguardedChange: true };
  // Branches start from what is already asked; only a question in every branch counts after them.
  const branches: unknown[] = [];
  if (Array.isArray(task.then)) branches.push(task.then);
  if (Array.isArray(task.else)) branches.push(task.else);
  if (Array.isArray(task.cases))
    for (const entry of task.cases) if (isNode(entry)) branches.push(entry.tasks);
  if (Array.isArray(task.default)) branches.push(task.default);
  if (branches.length === 0)
    return Array.isArray(task.tasks)
      ? walkTasks(task.tasks, guarded)
      : { guarded, unguardedChange: false };
  let allGuarded = true;
  for (const branch of branches) {
    const walked = walkTasks(branch, guarded);
    if (walked.unguardedChange) return walked;
    allGuarded = allGuarded && walked.guarded;
  }
  // A branch left out (an `if` with no `else`) continues unchanged.
  const covers = Array.isArray(task.cases)
    ? Array.isArray(task.default)
    : Array.isArray(task.then) && Array.isArray(task.else);
  return { guarded: guarded || (covers && allGuarded), unguardedChange: false };
};

/** Whether the flow asks before it first changes anything, so a link may start it. */
export const flowAsksBeforeChanging = (flow: Readonly<{ tasks?: unknown }>): boolean =>
  !walkTasks(flow.tasks, false).unguardedChange;
