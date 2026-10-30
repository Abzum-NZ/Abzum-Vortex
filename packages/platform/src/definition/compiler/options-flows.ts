import {
  flowTaskChildLists,
  type FlowDefinition,
  type FlowTask,
} from "../../workflows/flow-contracts";
import { flowTaskRuns } from "../../workflows/flow-task-registry-data";
import { compileFlowPlans, FlowPlanError } from "../../workflows/flow-plan";
import { DefinitionCompilationError } from "../compilation-error";
import type { JsonObject } from "./shared";

/**
 * Refuses a field whose options a flow works out when that flow cannot be an options source: it
 * must be interactive, hold only pure and read steps, and declare the `options` output the field
 * reads. It refuses a step that runs only in the page and any step that changes data.
 */
const holdsPageOnlyStep = (tasks: readonly FlowTask[]): boolean =>
  tasks.some((task) => {
    const runs = (flowTaskRuns as Readonly<Record<string, { server: boolean } | undefined>>)[
      task.type
    ];
    return (
      (runs !== undefined && !runs.server) ||
      flowTaskChildLists(task).some((child) => holdsPageOnlyStep(child.tasks))
    );
  });

export const validateFieldOptionsFlows = (
  recordTypes: readonly JsonObject[],
  flows: readonly FlowDefinition[],
  moduleKey: string,
): void => {
  const refuse = (field: JsonObject, reason: string): never => {
    throw new DefinitionCompilationError(
      "vortex.definition.unsupported_workflow_node",
      "unsupported_choice",
      undefined,
      undefined,
      `Field ${String(field.key)}: the options flow ${reason}`,
    );
  };
  for (const recordType of recordTypes)
    for (const field of recordType.fields as JsonObject[]) {
      const settings = field.settings as JsonObject | undefined;
      const source = settings?.optionsSource as JsonObject | undefined;
      if (source?.kind !== "flow") continue;
      const flow = flows.find((candidate) => String(candidate.id) === String(source.flowId));
      if (flow === undefined) {
        refuse(field, "is not a flow of this Module");
        continue;
      }
      if (flow.execution !== "interactive") refuse(field, "must be an interactive flow");
      if (flow.outputs.options === undefined) refuse(field, "must declare an 'options' output");
      try {
        const plan = compileFlowPlans(flows, undefined, undefined, undefined, moduleKey).plans.get(
          String(flow.id),
        );
        if (plan === undefined || plan.changes || holdsPageOnlyStep(flow.tasks))
          refuse(field, "only reads: it can hold no page steps and no changes");
      } catch (error) {
        if (!(error instanceof FlowPlanError)) throw error;
        refuse(field, `cannot be planned: ${error.reason}`);
      }
    }
};
