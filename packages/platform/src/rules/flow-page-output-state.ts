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

/** Builds exactly the page-held input, variable, task-output and form seed the segment declares. */
export const pageFlowSegmentSeed = (
  state: FlowRunState,
  declarations: Readonly<Record<string, string>>,
  pageInputs: ReadonlySet<string>,
  carriedInputKeys: readonly string[],
  resolveForm?: FlowFormReferenceResolver,
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
  const carried = new Set(carriedInputKeys);
  for (const [name, type] of Object.entries(declarations)) {
    if (carried.has(name)) continue;
    const parts = name.split(".");
    // Server-resolved inputs are never released or supplied by the page.
    if (parts[0] === "inputs" && !pageInputs.has(parts[1] ?? "")) continue;
    const value =
      parts[0] === "inputs" && parts.length === 2
        ? activation.inputs[parts[1]!]
        : parts[0] === "vars" && parts.length === 2
          ? activation.variables[parts[1]!]
          : parts[0] === "outputs" && parts.length === 3
            ? activation.outputs[parts[1]!]?.[parts[2]!]
            : parts[0] === "forms" && parts.length === 3
              ? resolveForm?.({ source: "form", form: parts[1]!, field: parts[2]! })
              : undefined;
    if (
      parts[0] !== "inputs" &&
      parts[0] !== "vars" &&
      parts[0] !== "outputs" &&
      parts[0] !== "forms"
    )
      continue;
    // A task on another branch may not have run, and inputs and variables may be initialized by
    // the receiving interpreter. Preserve absence; its input validation still checks requirements.
    if (value === undefined && parts[0] !== "forms") continue;
    if (
      value === undefined ||
      value.type !== type ||
      (value.value !== null && !flowValueMatchesType(value.value, type))
    )
      throw new Error("FLOW_PAGE_SEED_VALUE_INVALID");
    entries.push([name, value.value]);
  }
  return Object.fromEntries(entries);
};

/** Carries declared server task outputs and variable writes into the page's typed activation. */
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
  const variables = { ...activation.variables };
  for (const [name, value] of Object.entries(values)) {
    if (!Object.hasOwn(declarations, name)) throw new Error("FLOW_PAGE_OUTPUT_UNDECLARED");
    const parts = name.split(".");
    const type = declarations[name]!;
    if (value !== null && !flowValueMatchesType(value, type))
      throw new Error("FLOW_PAGE_OUTPUT_INVALID");
    const typed: FlowRuntimeValue = { type, value: value as JsonValue };
    if (parts[0] === "vars" && parts.length === 2 && parts[1] !== "") {
      const variable = parts[1]!;
      if (!Object.hasOwn(variables, variable) || variables[variable]?.type !== type)
        throw new Error("FLOW_PAGE_OUTPUT_INVALID");
      Object.defineProperty(variables, variable, {
        value: typed,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      continue;
    }
    if (parts[0] !== "outputs" || parts.length !== 3 || parts[1] === "" || parts[2] === "")
      throw new Error("FLOW_PAGE_OUTPUT_INVALID");
    const taskId = parts[1]!;
    const outputKey = parts[2]!;
    Object.defineProperty(outputs, taskId, {
      value: { ...(Object.hasOwn(outputs, taskId) ? outputs[taskId] : {}), [outputKey]: typed },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { ...state, activations: [{ ...activation, variables, outputs }] };
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
