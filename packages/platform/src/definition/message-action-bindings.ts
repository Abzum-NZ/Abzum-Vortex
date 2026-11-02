import type { ComponentFlowBinding } from "./application-flow-bindings";
import { defaultFlowBindingSettings } from "./component-semantic-events";
import { derivedDefinitionId } from "./derived-definition-id";
import type { FlowDefinition, FlowTask } from "../workflows/flow-contracts";
import { flowTaskChildLists } from "../workflows/flow-task-tree";
import {
  flowMessageActionFlowName,
  readFlowMessageActions,
} from "../workflows/flow-message-actions";
import { reachablePageFlows } from "../workflows/flow-reachability";

type MessageActionBinding = Readonly<{
  binding: ComponentFlowBinding;
  authoredBindingId: string;
  sourceFlowId: string;
  taskId: string;
}>;

/**
 * Derives finite message-action bindings from the installed flows and an authored binding, one per
 * action a message offers. A derived binding is gated by the control of the binding it came from;
 * it is never wider than what the person could already start from that control. What the target
 * flow changes is decided again by its protected operations for the person and the record (the
 * gate for Install or upgrade is the installation authority, not the button), and a shell that
 * knows an action is not the person's may leave it out of the message it shows.
 */
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
          for (const action of readFlowMessageActions(task.properties.actions) ?? []) {
            const name = flowMessageActionFlowName(action);
            const target = name === undefined ? undefined : byId.get(name);
            if (target === undefined) continue;
            const names = Object.keys(action.inputs);
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
                  String(target.id).toLowerCase(),
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
