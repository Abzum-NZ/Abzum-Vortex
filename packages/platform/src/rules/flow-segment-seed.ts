import type { JsonValue } from "../catalogue/common";
import type { FlowDefinition } from "../workflows/flow-contracts";
import type { FlowServerSegment } from "../workflows/flow-plan";
import { typedValueMatchesType } from "./condition-types";
import { failed, initialVariables } from "./flow-interpreter-state";
import type { FlowRuntimeValue } from "./flow-formula";

/** Parse exactly the page-held reads declared by this segment; server inputs stay with the host. */
export const parseFlowSegmentSeed = (
  flow: FlowDefinition,
  segment: FlowServerSegment,
  seed: Readonly<Record<string, unknown>>,
  start: Readonly<{
    pageResolvedInputs?: readonly string[];
    carriedValues?: Readonly<Record<string, FlowRuntimeValue>>;
  }>,
): Readonly<{
  inputs: Record<string, unknown>;
  variables: Record<string, FlowRuntimeValue>;
  outputs: Record<string, Record<string, FlowRuntimeValue>>;
  forms: Record<string, Record<string, FlowRuntimeValue>>;
}> => {
  const inputs: Record<string, unknown> = Object.create(null);
  const variables: Record<string, FlowRuntimeValue> = Object.assign(
    Object.create(null) as Record<string, FlowRuntimeValue>,
    initialVariables(flow),
  );
  const outputs: Record<string, Record<string, FlowRuntimeValue>> = Object.create(null);
  const forms: Record<string, Record<string, FlowRuntimeValue>> = Object.create(null);
  const declarations = segment.inputs;
  const carriedDeclarations = segment.carriedInputs;
  const carried = start.carriedValues ?? {};
  const pageInputNames = new Set(start.pageResolvedInputs ?? []);
  const expected = Object.entries(declarations).filter(
    ([name]) =>
      !Object.hasOwn(carriedDeclarations, name) &&
      (["vars.", "outputs.", "forms."].some((prefix) => name.startsWith(prefix)) ||
        (name.startsWith("inputs.") && pageInputNames.has(name.slice("inputs.".length)))),
  );
  if (
    Object.keys(seed).length !== expected.length ||
    Object.keys(seed).some((name) => !expected.some(([key]) => key === name))
  )
    failed("inputs_invalid", "refused", undefined, "segment seed has undeclared or missing values");
  for (const [name, type] of Object.entries(carriedDeclarations)) {
    if (declarations[name] !== type || carried[name]?.type !== type)
      failed("inputs_invalid", "refused", undefined, `carried input ${name} is invalid`);
  }
  for (const [name, type] of [...expected, ...Object.entries(carriedDeclarations)]) {
    const parts = name.split(".");
    if (
      parts.some((part) => part.length === 0) ||
      (parts[0] === "vars" || parts[0] === "inputs" ? parts.length !== 2 : parts.length !== 3)
    )
      failed("inputs_invalid", "refused", undefined, `segment input ${name} has an invalid key`);
    if (
      parts[0] === "inputs" &&
      (!Object.hasOwn(flow.inputs, parts[1]!) || flow.inputs[parts[1]!]!.type !== type)
    )
      failed("inputs_invalid", "refused", undefined, `segment input ${name} has an invalid type`);
    const candidate = Object.hasOwn(carriedDeclarations, name) ? carried[name]!.value : seed[name];
    if (candidate !== null && !typedValueMatchesType(candidate, type, "flow"))
      failed(
        "inputs_invalid",
        "refused",
        undefined,
        `segment input ${name} is not a valid ${type} value`,
      );
    const value: FlowRuntimeValue = { type, value: candidate as JsonValue };
    if (parts[0] === "inputs") inputs[parts[1]!] = candidate;
    else if (parts[0] === "vars") variables[parts[1]!] = value;
    else {
      const target = parts[0] === "outputs" ? outputs : forms;
      (target[parts[1]!] ??= Object.create(null))[parts[2]!] = value;
    }
  }
  return { inputs, variables, outputs, forms };
};

/** Collect only declared segment values, preserving task and variable namespaces. */
export const flowSegmentValues = (
  declarations: Readonly<Record<string, string>>,
  variables: Readonly<Record<string, FlowRuntimeValue>>,
  outputs: Readonly<Record<string, Readonly<Record<string, FlowRuntimeValue>>>>,
): Record<string, FlowRuntimeValue> => {
  const result: Record<string, FlowRuntimeValue> = Object.create(null);
  for (const [name, type] of Object.entries(declarations)) {
    const parts = name.split(".");
    const value =
      parts[0] === "vars" && parts.length === 2
        ? variables[parts[1]!]
        : parts[0] === "outputs" && parts.length === 3
          ? outputs[parts[1]!]?.[parts[2]!]
          : failed("output_unresolved", "failed", undefined, `invalid segment output ${name}`);
    if (value !== undefined) {
      if (value.type !== type)
        failed(
          "output_unresolved",
          "failed",
          undefined,
          `segment output ${name} has an invalid type`,
        );
      result[name] = value;
    }
  }
  return result;
};
