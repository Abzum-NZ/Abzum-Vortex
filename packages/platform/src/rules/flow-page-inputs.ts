import type { JsonValue } from "../catalogue/json-value";
import { isRecordLinkValue } from "../records/module-field-value-predicates";
import type { FlowBindingInput } from "../workflows/flow-contracts";
import type { FlowFormulaScope } from "./flow-formula";
import type { FlowProgram } from "./flow-interpreter-core";
import { resolveFlowValue } from "./flow-value-runtime";
import { flowValueMatchesType } from "./flow-value-shapes";

/** Resolves only the input declarations projected for a page from the validated binding map. */
export const resolvePageFlowInputs = (
  declarations: FlowProgram["inputs"],
  binding: Readonly<Record<string, FlowBindingInput>>,
  caller: Readonly<Record<string, unknown>>,
  scope: FlowFormulaScope,
): Readonly<Record<string, JsonValue>> => {
  const entries: [string, JsonValue][] = [];
  for (const [name, declaration] of Object.entries(declarations)) {
    const source = binding[name];
    if (source === undefined) continue;
    let value: unknown;
    if (source.kind === "caller") {
      if (!Object.hasOwn(caller, source.name)) throw new Error("FLOW_PAGE_CALLER_INPUT_MISSING");
      value = caller[source.name];
    } else {
      const resolved = resolveFlowValue(source, scope);
      if (resolved === undefined) throw new Error("FLOW_PAGE_INPUT_UNRESOLVED");
      value = resolved.value;
    }
    if (declaration.type === "record_reference" && typeof value === "object" && value !== null) {
      if (!isRecordLinkValue(value)) throw new Error("FLOW_PAGE_RECORD_INPUT_INVALID");
      const reference = value;
      if (
        declaration.recordTypeIds !== undefined &&
        !declaration.recordTypeIds.some(
          (id) => id.toLowerCase() === reference.recordTypeId.toLowerCase(),
        )
      )
        throw new Error("FLOW_PAGE_RECORD_INPUT_INVALID");
      value = reference.recordId;
    }
    if (value !== null && !flowValueMatchesType(value, declaration.type))
      throw new Error("FLOW_PAGE_INPUT_INVALID");
    entries.push([name, value as JsonValue]);
  }
  return Object.fromEntries(entries);
};
