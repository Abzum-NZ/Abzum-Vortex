import {
  flowTaskChildLists,
  flowTaskRegistry,
  isFlowControlTask,
  type FlowDefinition,
  type FlowTask,
} from "@vortex/contracts";
import type { FlowLibrary } from "@vortex/rule";

const runsInBrowser = (task: FlowTask, library: FlowLibrary, seen: Set<string>): boolean => {
  const definition = (
    flowTaskRegistry as Readonly<Record<string, { runLocations: readonly string[]; effect: string }>>
  )[task.type];
  if (definition === undefined) return false;
  if (!definition.runLocations.includes("browser")) return false;
  if (definition.effect !== "pure" && definition.effect !== "interface") return false;
  if (task.type === "run_flow") {
    const target = (task as Extract<FlowTask, { type: "run_flow" }>).flowId;
    if (!flowRunsOnlyInBrowser(target, library, seen)) return false;
  }
  return isFlowControlTask(task)
    ? flowTaskChildLists(task).every((list) => list.tasks.every((child) => runsInBrowser(child, library, seen)))
    : true;
};

/**
 * True only when the flow and every flow it can reach through Run flow is an interactive flow whose
 * every task (including error and finally tasks) is a pure or interface task the registry allows
 * in the browser. Any other flow, an unknown flow or a flow that holds a protected task is driven
 * by the server from its first task. A flow the page does not hold is never guessed browser-only.
 */
export function flowRunsOnlyInBrowser(
  flowId: string,
  library: FlowLibrary,
  seen: Set<string> = new Set(),
): boolean {
  if (seen.has(flowId)) return true;
  const flow: FlowDefinition | undefined = library(flowId);
  if (flow === undefined || flow.execution !== "interactive") return false;
  seen.add(flowId);
  return [flow.tasks, flow.errors, flow.finally].every((list) =>
    list.every((task) => runsInBrowser(task, library, seen)),
  );
}
