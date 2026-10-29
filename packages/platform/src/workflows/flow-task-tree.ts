import type { FlowTask } from "./flow-contracts";

export const flowControlTaskTypeKeys = [
  "if",
  "switch",
  "for_each",
  "sequential",
  "run_flow",
  "stop",
] as const;

export const isFlowControlTask = (task: FlowTask): boolean =>
  (flowControlTaskTypeKeys as readonly string[]).includes(task.type);

/** The nested task lists a task owns, with the path segments that reach each. */
export const flowTaskChildLists = (
  task: FlowTask,
): { path: (string | number)[]; tasks: FlowTask[] }[] => {
  const lists: { path: (string | number)[]; tasks: FlowTask[] }[] = [];
  if (!isFlowControlTask(task)) return lists;
  const control = task as Extract<FlowTask, { type: (typeof flowControlTaskTypeKeys)[number] }>;
  switch (control.type) {
    case "if":
      lists.push({ path: ["then"], tasks: control.then });
      if (control.else) lists.push({ path: ["else"], tasks: control.else });
      break;
    case "switch":
      control.cases.forEach((entry, index) =>
        lists.push({ path: ["cases", index, "tasks"], tasks: entry.tasks }),
      );
      if (control.default) lists.push({ path: ["default"], tasks: control.default });
      break;
    case "for_each":
    case "sequential":
      lists.push({ path: ["tasks"], tasks: control.tasks });
      break;
    default:
      break;
  }
  return lists;
};
