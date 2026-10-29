import type { JsonValue } from "../catalogue/json-value";
import { flowRunStateVersion, type FlowRunState } from "./flow-interpreter-core";
import type { FlowRuntimeValue } from "./flow-formula";
import { flowValueMatchesType } from "./flow-value-shapes";

/** Carries only declared server segment outputs into the page's typed interpreter activation. */
export const addPageFlowOutputs = (
  state: FlowRunState,
  declarations: Readonly<Record<string, string>>,
  values: Readonly<Record<string, unknown>>,
): FlowRunState => {
  const activation = state.activations[0];
  if (
    state.version !== flowRunStateVersion ||
    state.activations.length !== 1 ||
    state.awaiting !== undefined ||
    activation === undefined ||
    activation.frames.length !== 0
  )
    throw new Error("FLOW_PAGE_OUTPUT_STATE_INVALID");

  const outputs = { ...activation.outputs };
  for (const [name, value] of Object.entries(values)) {
    if (!Object.hasOwn(declarations, name)) throw new Error("FLOW_PAGE_OUTPUT_UNDECLARED");
    const [taskId, outputKey, ...rest] = name.split(".");
    const type = declarations[name]!;
    if (
      taskId === undefined ||
      taskId === "" ||
      outputKey === undefined ||
      outputKey === "" ||
      rest.length !== 0 ||
      (value !== null && !flowValueMatchesType(value, type))
    )
      throw new Error("FLOW_PAGE_OUTPUT_INVALID");
    const typed: FlowRuntimeValue = { type, value: value as JsonValue };
    Object.defineProperty(outputs, taskId, {
      value: { ...(Object.hasOwn(outputs, taskId) ? outputs[taskId] : {}), [outputKey]: typed },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { ...state, activations: [{ ...activation, outputs }] };
};
