import type { ComponentFlowBinding } from "./application-flow-bindings";
import { defaultFlowBindingSettings } from "./component-semantic-events";
import { derivedDefinitionId } from "./derived-definition-id";
import type { FlowDefinition, FlowTask } from "../workflows/flow-contracts";
import { flowTaskChildLists } from "../workflows/flow-task-tree";
import { reachablePageFlows } from "../workflows/flow-reachability";

export type MessageActionBinding = Readonly<{
  binding: ComponentFlowBinding;
  authoredBindingId: string;
  sourceFlowId: string;
  taskId: string;
}>;

/** Derives finite message-action bindings from the installed flows and an authored binding. */
export function messageActionBindings(
  origin: ComponentFlowBinding,
  flows: readonly FlowDefinition[],
): readonly MessageActionBinding[] {
  const byId = new Map(flows.map((flow) => [String(flow.id), flow]));
  const result: MessageActionBinding[] = [];
  for (const reached of reachablePageFlows([String(origin.flow.flowId)], flows)) {
    const source = byId.get(String(reached.id));
    if (source === undefined) continue;
    const visit = (tasks: readonly FlowTask[]): void => {
      for (const task of tasks) {
        if (task.type === "interface.show_message") {
          const action = task.properties.action_flow;
          const target =
            action?.kind === "literal" && typeof action.literal.value === "string"
              ? byId.get(action.literal.value)
              : undefined;
          if (target !== undefined) {
            const mapped = task.properties.action_inputs;
            const names = mapped?.kind === "map" ? Object.keys(mapped.entries) : [];
            result.push({
              authoredBindingId: String(origin.bindingId),
              sourceFlowId: String(source.id),
              taskId: task.id,
              binding: {
                bindingId: derivedDefinitionId([
                  "message_action_binding",
                  String(origin.bindingId).toLowerCase(),
                  String(source.id).toLowerCase(),
                  task.id,
                ]) as ComponentFlowBinding["bindingId"],
                controlId: origin.controlId,
                eventId: origin.eventId,
                event: "action",
                flow: {
                  flowId: target.id,
                  inputs: Object.fromEntries(names.map((name) => [name, { kind: "caller", name }])),
                },
                settings: defaultFlowBindingSettings("action"),
              },
            });
          }
        }
        for (const child of flowTaskChildLists(task)) visit(child.tasks);
      }
    };
    visit([...source.tasks, ...source.errors, ...source.finally]);
  }
  return result;
}

/** The installed authored bindings and their derived message actions. */
export function bindingsWithMessageActions(
  bindings: readonly ComponentFlowBinding[],
  flows: readonly FlowDefinition[],
): readonly ComponentFlowBinding[] {
  return [
    ...bindings,
    ...bindings.flatMap((binding) =>
      messageActionBindings(binding, flows).map((item) => item.binding),
    ),
  ];
}
