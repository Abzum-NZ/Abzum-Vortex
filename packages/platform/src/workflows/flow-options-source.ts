import { flowTaskRegistry } from "./flow-task-registry";
import type { FlowTaskTypeKey } from "./flow-task-registry-data";

/**
 * What makes a flow an options source for a choice or link field (Studio flows design §2): it is
 * interactive, it works out the list from records it only reads, every step runs on the server, and
 * it declares the `options` output the field reads. One rule serves the field's picker and the
 * compiler, so Studio offers exactly the flows a publish accepts.
 */

/** A flow as Studio's draft and the compiler hold it; only what decides an options source is read. */
type OptionsFlowTaskShape = Readonly<{
  id: string;
  type: string;
  then?: readonly OptionsFlowTaskShape[] | undefined;
  else?: readonly OptionsFlowTaskShape[] | undefined;
  cases?: readonly Readonly<{ tasks: readonly OptionsFlowTaskShape[] }>[] | undefined;
  default?: readonly OptionsFlowTaskShape[] | undefined;
  tasks?: readonly OptionsFlowTaskShape[] | undefined;
}>;

type OptionsFlowShape = Readonly<{
  execution: string;
  outputs: Readonly<Record<string, unknown>>;
  tasks: readonly OptionsFlowTaskShape[];
}>;

const stepsOf = (tasks: readonly OptionsFlowTaskShape[]): readonly OptionsFlowTaskShape[] =>
  tasks.flatMap((task) => [
    task,
    ...(task.tasks ?? []),
    ...(task.then ?? []),
    ...(task.else ?? []),
    ...(task.default ?? []),
    ...(task.cases ?? []).flatMap((entry) => entry.tasks),
  ]);

const definitionOf = (task: OptionsFlowTaskShape) =>
  Object.hasOwn(flowTaskRegistry, task.type)
    ? flowTaskRegistry[task.type as FlowTaskTypeKey]
    : undefined;

/** The step's name as the builder sees it: its title and its id. */
const namedStep = (task: OptionsFlowTaskShape, title: string): string =>
  `"${title}" (${task.id})`;

/** Why a flow cannot be a field's options source; undefined when it can. */
export const optionsFlowRefusal = (flow: OptionsFlowShape): string | undefined => {
  if (flow.execution !== "interactive") return "must be an interactive flow";
  if (flow.outputs.options === undefined) return "must declare an 'options' output";
  for (const task of stepsOf(flow.tasks)) {
    const definition = definitionOf(task);
    if (definition === undefined)
      return `holds the step ${namedStep(task, task.type)}, which is not a step this version runs`;
    if (definition.effect === "change" || definition.effect === "background_start")
      return `changes data with the step ${namedStep(task, definition.title)}; an options flow only reads`;
    // A pure step (Build list, Calculate) runs wherever its inputs are; only a page step is refused.
    if (definition.effect === "interface")
      return `runs the step ${namedStep(task, definition.title)} in the page; an options flow works out its list on the server`;
  }
  return undefined;
};

/** Whether a flow can be the options source of a field. */
export const isOptionsFlowSource = (flow: OptionsFlowShape): boolean =>
  optionsFlowRefusal(flow) === undefined;
