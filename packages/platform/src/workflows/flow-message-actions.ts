import type { FlowValue } from "./flow-values";

/** A dialog offers at most this many actions; any other message target offers one. */
export const flowMessageActionLimits = Object.freeze({ dialog: 3, other: 1 });

/** One action a message offers: its label, the flow it starts and the inputs it gives that flow. */
export type FlowMessageActionSource = Readonly<{
  label: FlowValue;
  /** A literal text: the flow's name in the source, its identity once compiled. */
  flow: FlowValue;
  inputs: Readonly<Record<string, FlowValue>>;
}>;

const allowedKeys: ReadonlySet<string> = new Set(["label", "flow", "inputs"]);

/**
 * The actions of a Show message step's `actions` property: an array of maps with a `label`, a
 * `flow` and optional `inputs`. Undefined when the value is anything else, so every reader judges
 * the one shape the same way.
 */
export const readFlowMessageActions = (
  value: FlowValue | undefined,
): readonly FlowMessageActionSource[] | undefined => {
  if (value?.kind !== "array") return undefined;
  const actions: FlowMessageActionSource[] = [];
  for (const item of value.items) {
    if (item.kind !== "map") return undefined;
    const { label, flow, inputs } = item.entries;
    if (
      label === undefined ||
      flow === undefined ||
      Object.keys(item.entries).some((key) => !allowedKeys.has(key)) ||
      (inputs !== undefined && inputs.kind !== "map")
    )
      return undefined;
    actions.push({ label, flow, inputs: inputs?.kind === "map" ? inputs.entries : {} });
  }
  return actions;
};

/** The flow a literal-text `flow` value names, or undefined when it is anything else. */
export const flowMessageActionFlowName = (action: FlowMessageActionSource): string | undefined =>
  action.flow.kind === "literal" &&
  action.flow.literal.type === "text" &&
  typeof action.flow.literal.value === "string"
    ? action.flow.literal.value
    : undefined;
