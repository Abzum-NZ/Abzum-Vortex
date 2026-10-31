import type { FlowDefinition, FlowTask } from "../../workflows/flow-contracts";
import { optionsFlowRefusal } from "../../workflows/flow-options-source";
import { compileFlowPlans, FlowPlanError } from "../../workflows/flow-plan";
import { DefinitionCompilationError } from "../compilation-error";
import type { JsonObject } from "./shared";

/**
 * Refuses a field whose options a flow works out when that flow cannot be an options source: it
 * must be interactive, hold only pure and read steps, declare the `options` output the field
 * reads, and plan as one that only reads. The sentence names the field, the flow and the step, so
 * the builder sees what to change.
 */
export const validateFieldOptionsFlows = (
  recordTypes: readonly JsonObject[],
  flows: readonly FlowDefinition[],
  moduleKey: string,
): void => {
  const refuse = (field: JsonObject, flow: FlowDefinition, reason: string): never => {
    const name = flow.labels?.name ?? flow.key;
    throw new DefinitionCompilationError(
      "vortex.definition.unsupported_workflow_node",
      "unsupported_choice",
      undefined,
      undefined,
      `Field ${String(field.key)}: the options flow "${name}" ${reason}`,
    );
  };
  const planned = (flow: FlowDefinition, moduleKey: string, field: JsonObject) => {
    try {
      const plan = compileFlowPlans(flows, undefined, undefined, undefined, moduleKey).plans.get(
        String(flow.id),
      );
      if (plan === undefined) {
        refuse(field, flow, "cannot be planned as an options source");
        return;
      }
      if (plan.changes) refuse(field, flow, "changes data; an options flow only reads");
    } catch (error) {
      if (!(error instanceof FlowPlanError)) throw error;
      const step = flow.tasks.find((task: FlowTask) => task.id === error.taskId);
      refuse(
        field,
        flow,
        error.taskId === undefined || step === undefined
          ? `cannot be planned: ${error.reason}`
          : `cannot be planned at the step "${step.id}" (${step.type}): ${error.reason}`,
      );
    }
  };
  for (const recordType of recordTypes)
    for (const field of recordType.fields as JsonObject[]) {
      const settings = field.settings as JsonObject | undefined;
      const source = settings?.optionsSource as JsonObject | undefined;
      if (source?.kind !== "flow") continue;
      const flow = flows.find((candidate) => String(candidate.id) === String(source.flowId));
      if (flow === undefined) {
        throw new DefinitionCompilationError(
          "vortex.definition.unsupported_workflow_node",
          "unsupported_choice",
          undefined,
          undefined,
          `Field ${String(field.key)}: the options flow is not a flow of this Module`,
        );
      }
      const refusal = optionsFlowRefusal(flow);
      if (refusal !== undefined) refuse(field, flow, refusal);
      planned(flow, moduleKey, field);
    }
};
