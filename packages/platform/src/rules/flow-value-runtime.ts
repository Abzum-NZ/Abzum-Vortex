import type { JsonValue } from "../catalogue/common";
import type { FlowValue } from "../workflows/flow-values";
import { evaluateFlowFormula, type FlowFormulaScope, type FlowRuntimeValue } from "./flow-formula";

/** Resolves the one flow value language against the host's typed scope. */
export function resolveFlowValue(
  value: FlowValue,
  scope: FlowFormulaScope,
): FlowRuntimeValue | undefined {
  if (value.kind === "literal") return { type: value.literal.type, value: value.literal.value };
  if (value.kind === "reference") return scope.reference(value.reference);
  if (value.kind === "formula") return evaluateFlowFormula(value.formula, scope);
  if (value.kind === "map") {
    const entries: Record<string, JsonValue> = {};
    for (const [name, entry] of Object.entries(value.entries)) {
      const resolved = resolveFlowValue(entry, scope);
      if (resolved === undefined) return undefined;
      entries[name] = resolved.value;
    }
    return { type: "json", value: entries };
  }
  const items: JsonValue[] = [];
  for (const item of value.items) {
    const resolved = resolveFlowValue(item, scope);
    if (resolved === undefined) return undefined;
    items.push(resolved.value);
  }
  return { type: "json", value: items };
}
