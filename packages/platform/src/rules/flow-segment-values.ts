import { failed } from "./flow-interpreter-state";
import type { FlowRuntimeValue } from "./flow-formula";

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
