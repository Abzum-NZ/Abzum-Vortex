import type { JsonValue } from "../catalogue/json-value";
import type { BrowserFlowOutputValue, BrowserFlowPlan } from "../workflows/flow-plan";
import type { FlowDefinition } from "../workflows/flow-contracts";
import {
  flowRunStateVersion,
  pageFlowScope,
  type FlowFormReferenceResolver,
  type FlowOutputMemberTypeResolver,
  type FlowProgram,
  type FlowRunState,
} from "./flow-interpreter-core";
import type { FlowRuntimeValue } from "./flow-formula";
import { resolveFlowValue } from "./flow-value-runtime";
import { flowValueMatchesType } from "./flow-value-shapes";

const isPageOutputExpression = (
  value: BrowserFlowOutputValue,
): value is FlowDefinition["outputs"][string]["value"] =>
  value.kind !== "reference" || value.reference.source !== "final_output";

/** Resolves only the compiler-declared member types of protected segment outputs. */
export const browserFlowMemberTypeResolver = (
  plan: BrowserFlowPlan,
): FlowOutputMemberTypeResolver => {
  const members = new Map<string, string>();
  for (const segment of plan.segments) {
    if (segment.kind !== "server") continue;
    for (const [name, type] of Object.entries(segment.outputMembers)) {
      const previous = members.get(name);
      if (previous !== undefined && previous !== type)
        throw new Error("FLOW_PAGE_OUTPUT_MEMBER_TYPE_CONFLICT");
      members.set(name, type);
    }
  }
  return (_task, taskId, outputKey, path) => members.get([taskId, outputKey, ...path].join("."));
};

/** Builds exactly the page-held variable and task-output seed the server segment declares. */
export const pageFlowSegmentSeed = (
  state: FlowRunState,
  declarations: Readonly<Record<string, string>>,
): Readonly<Record<string, JsonValue>> => {
  const activation = state.activations[0];
  if (
    state.version !== flowRunStateVersion ||
    state.activations.length !== 1 ||
    state.awaiting !== undefined ||
    activation === undefined ||
    activation.frames.length !== 0
  )
    throw new Error("FLOW_PAGE_SEED_STATE_INVALID");
  const entries: [string, JsonValue][] = [];
  for (const [name, type] of Object.entries(declarations)) {
    const parts = name.split(".");
    const value =
      parts[0] === "vars" && parts.length === 2
        ? activation.variables[parts[1]!]
        : parts[0] === "outputs" && parts.length === 3
          ? activation.outputs[parts[1]!]?.[parts[2]!]
          : undefined;
    if (parts[0] !== "vars" && parts[0] !== "outputs") continue;
    if (value === undefined || value.type !== type) throw new Error("FLOW_PAGE_SEED_VALUE_INVALID");
    entries.push([name, value.value]);
  }
  return Object.fromEntries(entries);
};

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

/** Evaluates browser-visible outputs in the shared scope or takes the declared completion value. */
export const pageFlowFinalOutputs = (
  state: FlowRunState,
  program: FlowProgram,
  plan: BrowserFlowPlan,
  completion: Readonly<Record<string, unknown>>,
  resolveMember: FlowOutputMemberTypeResolver,
  resolveForm?: FlowFormReferenceResolver,
): Readonly<Record<string, JsonValue>> => {
  const scope = pageFlowScope(state, program, resolveMember, resolveForm);
  const values: Record<string, JsonValue> = {};
  const expected = new Set<string>();
  for (const [name, declaration] of Object.entries(plan.outputs)) {
    const expression = declaration.value;
    if (!isPageOutputExpression(expression)) {
      const completionName = expression.reference.name;
      expected.add(completionName);
      if (!Object.hasOwn(completion, completionName))
        throw new Error("FLOW_PAGE_FINAL_OUTPUT_MISSING");
      const result = completion[completionName];
      if (result !== null && !flowValueMatchesType(result, declaration.type))
        throw new Error("FLOW_PAGE_FINAL_OUTPUT_INVALID");
      values[name] = result as JsonValue;
      continue;
    }
    const result = resolveFlowValue(expression, scope);
    if (result === undefined || result.type !== declaration.type)
      throw new Error("FLOW_PAGE_FINAL_OUTPUT_UNRESOLVED");
    values[name] = result.value;
  }
  if (Object.keys(completion).some((name) => !expected.has(name)))
    throw new Error("FLOW_PAGE_FINAL_OUTPUT_UNDECLARED");
  return values;
};
