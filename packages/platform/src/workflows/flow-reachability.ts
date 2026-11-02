import { isRecord } from "../catalogue/runtime-primitives";
import type { FlowTask } from "./flow-contracts";
import { flowMessageActionFlowName, readFlowMessageActions } from "./flow-message-actions";
import { flowTaskChildLists } from "./flow-task-tree";

/** The page-bound flows reachable through message actions, once each. */
export function reachablePageFlows(
  roots: readonly string[],
  flows: readonly unknown[],
): readonly Record<string, unknown>[] {
  const byName = new Map<string, Record<string, unknown>>();
  for (const flow of flows) {
    if (!isRecord(flow) || typeof flow.id !== "string") continue;
    byName.set(flow.id, flow);
    if (typeof flow.key === "string") byName.set(flow.key, flow);
  }
  const reached = new Set<Record<string, unknown>>();
  const pending = [...roots];
  const visitTasks = (tasks: readonly FlowTask[]) => {
    for (const task of tasks) {
      if (task.type === "interface.show_message") {
        for (const action of readFlowMessageActions(task.properties.actions) ?? []) {
          const name = flowMessageActionFlowName(action);
          if (name !== undefined) pending.push(name);
        }
      }
      for (const child of flowTaskChildLists(task)) visitTasks(child.tasks);
    }
  };
  while (pending.length > 0) {
    const flow = byName.get(pending.pop()!);
    if (flow === undefined || reached.has(flow)) continue;
    reached.add(flow);
    for (const key of ["tasks", "errors", "finally"])
      if (Array.isArray(flow[key])) visitTasks(flow[key] as FlowTask[]);
  }
  return [...reached];
}
