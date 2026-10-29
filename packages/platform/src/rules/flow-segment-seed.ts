import type { JsonValue } from "../catalogue/common";
import type { FlowDefinition } from "../workflows/flow-contracts";
import { typedValueMatchesType } from "./condition-types";
import { failed, initialVariables } from "./flow-interpreter-state";
import type { FlowRuntimeValue } from "./flow-formula";

/** Parse exactly the page-held reads declared by this segment; server inputs stay with the host. */
export const parseFlowSegmentSeed = (
  flow: FlowDefinition,
  declarations: Readonly<Record<string, string>>,
  seed: Readonly<Record<string, unknown>>,
): Readonly<{
  variables: Record<string, FlowRuntimeValue>;
  outputs: Record<string, Record<string, FlowRuntimeValue>>;
  forms: Record<string, Record<string, FlowRuntimeValue>>;
}> => {
  const variables: Record<string, FlowRuntimeValue> = Object.assign(
    Object.create(null) as Record<string, FlowRuntimeValue>,
    initialVariables(flow),
  );
  const outputs: Record<string, Record<string, FlowRuntimeValue>> = Object.create(null);
  const forms: Record<string, Record<string, FlowRuntimeValue>> = Object.create(null);
  const expected = Object.entries(declarations).filter(([name]) =>
    ["vars.", "outputs.", "forms."].some((prefix) => name.startsWith(prefix)),
  );
  if (
    Object.keys(seed).length !== expected.length ||
    Object.keys(seed).some((name) => !expected.some(([key]) => key === name))
  )
    failed("inputs_invalid", "refused", undefined, "segment seed has undeclared or missing values");
  for (const [name, type] of expected) {
    const parts = name.split(".");
    if (
      parts.some((part) => part.length === 0) ||
      (parts[0] === "vars" ? parts.length !== 2 : parts.length !== 3)
    )
      failed("inputs_invalid", "refused", undefined, `segment input ${name} has an invalid key`);
    const candidate = seed[name];
    if (candidate !== null && !typedValueMatchesType(candidate, type, "flow"))
      failed(
        "inputs_invalid",
        "refused",
        undefined,
        `segment input ${name} is not a valid ${type} value`,
      );
    const value: FlowRuntimeValue = { type, value: candidate as JsonValue };
    if (parts[0] === "vars") variables[parts[1]!] = value;
    else {
      const target = parts[0] === "outputs" ? outputs : forms;
      (target[parts[1]!] ??= Object.create(null))[parts[2]!] = value;
    }
  }
  return { variables, outputs, forms };
};
