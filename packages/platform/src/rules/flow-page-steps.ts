import type { PageIntentStepType } from "../workflows/flow-task-registry-data";
import type { FlowInterfaceIntent } from "./flow-interpreter-core";
import type { FlowRuntimeValue } from "./flow-formula";
import { isMoneyValue } from "../records/module-field-value-predicates";
import { flowValueMatchesType } from "./flow-value-shapes";

/**
 * The intent the page performs for each registered page step. Adding a page implementation flag
 * requires its corresponding intent here.
 */
export const pageStepIntents = {
  "interface.show_message": "show_message",
  "interface.clear_message": "clear_message",
  "interface.show_form": "show_form",
  "interface.confirm": "confirm",
  "interface.navigate": "navigate",
  "interface.refresh": "refresh",
  "interface.set_panel": "set_panel",
  "interface.set_filter": "set_filter",
  "interface.set_value": "set_value",
  "interface.validate_form": "validate_form",
} as const satisfies Record<PageIntentStepType, FlowInterfaceIntent["kind"]>;

/**
 * The value a page value held as `declared` takes from a write, or undefined when the write is
 * refused (other type, invalid shape). A page holds money as its amount: a money value that carries
 * a currency, as record fields and calculations over them do, is written as its amount.
 */
export const pageValueWrite = (
  declared: FlowRuntimeValue | undefined,
  value: FlowRuntimeValue | undefined,
): FlowRuntimeValue | undefined => {
  if (declared === undefined || value === undefined || value.type !== declared.type)
    return undefined;
  const content =
    value.type === "money" && isMoneyValue(value.value) ? value.value.amount : value.value;
  return content === null ||
    (flowValueMatchesType(content, declared.type) &&
      (declared.type !== "json" || Array.isArray(content)))
    ? { type: value.type, value: content }
    : undefined;
};

/** The one intent that delivers a segment's final page values to the page store. */
export const pageWritesIntent = (
  writes: Readonly<Record<string, FlowRuntimeValue>>,
): FlowInterfaceIntent => ({
  kind: "set_value",
  taskId: "page_values",
  properties: {
    values: {
      type: "json",
      value: Object.fromEntries(Object.entries(writes).map(([key, value]) => [key, value.value])),
    },
  },
});
