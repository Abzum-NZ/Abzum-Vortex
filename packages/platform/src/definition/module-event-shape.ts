import {
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
} from "./application-source-contracts";
import type { SourceFlowTask } from "../workflows/flow-source-contracts";

type ModuleEvent = ApplicationSourceDocument["body"]["modules"][number]["events"][number];

/** Only declaration references count; ordinary text may contain the same event key. */
const tasksAnnounce = (tasks: readonly SourceFlowTask[], key: string): boolean =>
  tasks.some((task) => {
    if (task.type === "event.announce" && "properties" in task) {
      const event = task.properties.event;
      if (event?.kind === "literal" && event.literal.value === key) return true;
    }
    if ("then" in task && tasksAnnounce(task.then, key)) return true;
    if ("else" in task && tasksAnnounce(task.else ?? [], key)) return true;
    if ("tasks" in task && tasksAnnounce(task.tasks, key)) return true;
    if ("cases" in task && task.cases.some((entry) => tasksAnnounce(entry.tasks, key))) return true;
    if ("default" in task && tasksAnnounce(task.default ?? [], key)) return true;
    return "branches" in task && task.branches.some((branch) => tasksAnnounce(branch, key));
  });

/** Edits a declared module event without changing its identity or announcement references. */
export const saveInlineModuleEvent = (
  current: ApplicationSourceDocument,
  change: Readonly<{
    moduleKey: string;
    eventId?: string;
    key: string;
    recordKey: string;
    carries: readonly string[];
  }>,
):
  | Readonly<{ kind: "changed"; source: ApplicationSourceDocument }>
  | Readonly<{ kind: "invalid"; issues: readonly string[] }> => {
  const source = structuredClone(current);
  const module = source.body.modules.find((entry) => entry.key === change.moduleKey);
  const record = module?.record_types.find((entry) => entry.key === change.recordKey);
  if (module === undefined || record === undefined)
    return { kind: "invalid", issues: ["Choose a record type owned by this module."] };
  const existing =
    change.eventId === undefined
      ? undefined
      : module.events.find((entry) => entry.id === change.eventId);
  if (change.eventId !== undefined && existing === undefined)
    return { kind: "invalid", issues: ["The event is no longer in this module."] };
  const issues: string[] = [];
  if (existing !== undefined && existing.key !== change.key)
    issues.push("An existing event keeps its key so its references remain valid.");
  if (existing !== undefined && existing.record_type !== record.key) {
    const referenced =
      source.body.modules.some((owner) =>
        owner.actions.some((action) =>
          action.tasks.some(
            (task) => task.type === "event.announce" && task.properties.event === existing.key,
          ),
        ),
      ) ||
      [source.body, ...source.body.modules].some((owner) =>
        owner.flows.some(
          (flow) =>
            flow.triggers.some(
              (trigger) =>
                trigger.type === "Event" &&
                trigger.event.kind === "declared" &&
                trigger.event.eventKey === existing.key,
            ) || tasksAnnounce([...flow.tasks, ...flow.errors, ...flow.finally], existing.key),
        ),
      );
    if (referenced)
      issues.push(
        "Remove this event's announcements and flow references before changing its record type.",
      );
  }
  if (module.events.some((entry) => entry !== existing && entry.key === change.key))
    issues.push("This event key is already declared.");
  if (new Set(change.carries).size !== change.carries.length)
    issues.push("Choose each carried field once.");
  for (const key of change.carries) {
    const field = record.fields.find((entry) => entry.key === key);
    if (field === undefined) issues.push(`The record type has no field ${key}.`);
    else if (field.personal_data !== "none")
      issues.push(
        `${field.label} contains personal or sensitive data and cannot be carried by an event.`,
      );
  }
  if (issues.length > 0) return { kind: "invalid", issues };
  const aliases = new Set<string>();
  const collect = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if ("id" in value && typeof value.id === "string") aliases.add(value.id);
    for (const entry of Object.values(value)) collect(entry);
  };
  collect(source);
  let n = module.events.length + 1;
  while (aliases.has(`event_${n}`)) n += 1;
  const event: ModuleEvent = {
    id: existing?.id ?? `event_${n}`,
    key: change.key,
    record_type: record.key,
    carries: [...change.carries],
    personal_or_sensitive_values_allowed: false,
  };
  if (existing === undefined) module.events.push(event);
  else module.events[module.events.indexOf(existing)] = event;
  const parsed = applicationSourceDocumentSchema.safeParse(source);
  return parsed.success
    ? { kind: "changed", source: parsed.data }
    : {
        kind: "invalid",
        issues: parsed.error.issues.map((issue) => `${issue.message} (${issue.path.join(" / ")})`),
      };
};
