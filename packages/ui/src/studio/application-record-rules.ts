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
 * every flow; there is no other kind of rule. The list says when each runs and what it does.
 */

type SourceTask = SourceFlow["tasks"][number];

export type StudioRecordRule = Readonly<{
  flowAlias: string;
  name: string;
  /** When it runs, in words: before the record is created, changed, or both. */
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

/** The rules of one record type of an owned module, in the order the module holds them. */
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
  return module.flows.flatMap((flow) => {
    const trigger = beforeSaveTrigger(flow, recordKey);
    if (trigger === undefined || trigger.type !== "BeforeSave") return [];
    const create = trigger.operations.some((operation) => operation.kind === "create");
    const update = trigger.operations.some((operation) => operation.kind === "update");
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
        when:
          create && update
            ? "Before a record is created or changed"
            : create
              ? "Before a record is created"
              : update
                ? "Before a record is changed"
                : "Before a named action moves a record on",
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
  return { kind: "deleted", source: candidate };
};
