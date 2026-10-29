import {
  flowTaskChildLists,
  type ApplicationSourceDocument,
  type FlowValue,
  type SourceFlow,
} from "@vortex/platform/schema";
import { studioFlowLabel } from "./semantic-selection";

/**
 * The before-save rules of a record type, as the Data tab lists them. A rule is a BeforeSave flow
 * of the module that owns the record type, edited on the Flows tab with the same step editors as
 * every flow; there is no other kind of rule. The record type's ordered rule list
 * (`before_save_rules`) is the order they run in; the list says when each runs and what it does.
 */

type SourceTask = SourceFlow["tasks"][number];

export type StudioRecordRule = Readonly<{
  flowAlias: string;
  name: string;
  /** When it runs, in words: before the record is created, changed, deleted or restored. */
  when: string;
  /** What its steps do, one line per refusal, warning or required field, in step order. */
  effects: readonly string[];
}>;

const textOf = (value: FlowValue | undefined): string | undefined =>
  value?.kind === "literal" && typeof value.literal.value === "string"
    ? value.literal.value
    : undefined;

const beforeSaveTrigger = (flow: SourceFlow, recordKey: string) =>
  flow.triggers.find(
    (trigger) => trigger.type === "BeforeSave" && trigger.recordTypeId === recordKey,
  );

const operationWords = {
  create: "created",
  update: "changed",
  delete: "deleted",
  restore: "restored",
} as const;

/** The rules of one record type of an owned module, in the order they run. */
export const studioRecordRules = (
  source: Readonly<ApplicationSourceDocument>,
  moduleKey: string,
  recordKey: string,
): readonly StudioRecordRule[] => {
  const module = source.body.modules.find((entry) => entry.key === moduleKey);
  const record = module?.record_types.find((entry) => entry.key === recordKey);
  if (module === undefined || record === undefined) return [];
  const fieldLabel = (reference: string | undefined) => {
    const key = reference?.slice(reference.lastIndexOf(".") + 1);
    return record.fields.find((field) => field.key === key)?.label ?? key ?? "a field";
  };
  return record.before_save_rules.flatMap((flowAlias) => {
    const flow = module.flows.find((entry) => entry.id === flowAlias);
    const trigger = flow === undefined ? undefined : beforeSaveTrigger(flow, recordKey);
    if (flow === undefined || trigger === undefined || trigger.type !== "BeforeSave") return [];
    const words = trigger.operations.map((operation) => operationWords[operation.kind]);
    const effects: string[] = [];
    const visit = (tasks: readonly SourceTask[]) => {
      for (const task of tasks) {
        if ("properties" in task) {
          const message = textOf(task.properties.message);
          if (task.type === "rule.refuse")
            effects.push(`Refuses the save: ${message ?? "with a reason"}`);
          else if (task.type === "rule.warn") effects.push(`Warns: ${message ?? "with a message"}`);
          else if (task.type === "rule.require")
            effects.push(`Requires ${fieldLabel(textOf(task.properties.field))}`);
        }
        for (const child of flowTaskChildLists(task as never))
          visit(child.tasks as unknown as readonly SourceTask[]);
      }
    };
    visit(flow.tasks);
    return [
      {
        flowAlias: flow.id,
        name: studioFlowLabel(flow),
        when: `Before a record is ${words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`}`,
        effects,
      },
    ];
  });
};

export type StudioRecordRuleDelete =
  | Readonly<{ kind: "deleted"; source: ApplicationSourceDocument }>
  | Readonly<{ kind: "refused"; reason: string }>;

/** Deletes one rule from its module, refused while another flow of the draft runs it. */
export const deleteStudioRecordRule = (
  source: Readonly<ApplicationSourceDocument>,
  moduleKey: string,
  flowAlias: string,
): StudioRecordRuleDelete => {
  const candidate: ApplicationSourceDocument = structuredClone(source);
  const module = candidate.body.modules.find((entry) => entry.key === moduleKey);
  const flow = module?.flows.find((entry) => entry.id === flowAlias);
  if (module === undefined || flow === undefined)
    return { kind: "refused", reason: "This rule is no longer in the draft." };
  const runs = (tasks: readonly SourceTask[]): boolean =>
    tasks.some(
      (task) =>
        ("flowId" in task && (task.flowId === flow.id || task.flowId === flow.key)) ||
        flowTaskChildLists(task as never).some((child) =>
          runs(child.tasks as unknown as readonly SourceTask[]),
        ),
    );
  const caller = [
    ...candidate.body.flows,
    ...candidate.body.modules.flatMap((entry) => entry.flows),
  ].find((entry) => entry !== flow && runs([...entry.tasks, ...entry.errors, ...entry.finally]));
  if (caller !== undefined)
    return {
      kind: "refused",
      reason: `${studioFlowLabel(caller)} runs this rule, so it cannot be deleted. Remove that step first.`,
    };
  module.flows = module.flows.filter((entry) => entry !== flow);
  syncStudioRecordRuleLists(module);
  return { kind: "deleted", source: candidate };
};

type SourceModule = ApplicationSourceDocument["body"]["modules"][number];

/**
 * Keeps each record type's ordered rule list equal to the module's BeforeSave flows that name it:
 * a flow that no longer covers the record type leaves its list, and a newly covering flow runs
 * last. Every Studio edit that adds, removes or retargets a rule calls it on the edited module.
 */
export const syncStudioRecordRuleLists = (module: SourceModule): void => {
  for (const record of module.record_types) {
    const covering = module.flows
      .filter((flow) => beforeSaveTrigger(flow, record.key) !== undefined)
      .map((flow) => flow.id);
    record.before_save_rules = [
      ...record.before_save_rules.filter((alias) => covering.includes(alias)),
      ...covering.filter((alias) => !record.before_save_rules.includes(alias)),
    ];
  }
};

export type StudioRecordRuleMove =
  | Readonly<{ kind: "moved"; source: ApplicationSourceDocument }>
  | Readonly<{ kind: "refused"; reason: string }>;

/** Moves one rule a place earlier or later in its record type's run order. */
export const moveStudioRecordRule = (
  source: Readonly<ApplicationSourceDocument>,
  moduleKey: string,
  recordKey: string,
  flowAlias: string,
  direction: "earlier" | "later",
): StudioRecordRuleMove => {
  const candidate: ApplicationSourceDocument = structuredClone(source);
  const record = candidate.body.modules
    .find((entry) => entry.key === moduleKey)
    ?.record_types.find((entry) => entry.key === recordKey);
  const index = record?.before_save_rules.indexOf(flowAlias) ?? -1;
  const target = direction === "earlier" ? index - 1 : index + 1;
  if (record === undefined || index < 0)
    return { kind: "refused", reason: "This rule is no longer in the draft." };
  if (target < 0 || target >= record.before_save_rules.length)
    return {
      kind: "refused",
      reason: `This rule already runs ${direction === "earlier" ? "first" : "last"}.`,
    };
  const order = [...record.before_save_rules];
  [order[index], order[target]] = [order[target]!, order[index]!];
  record.before_save_rules = order;
  return { kind: "moved", source: candidate };
};
