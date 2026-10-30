import type { PageIntentStepType } from "../workflows/flow-task-registry-data";
import type { FlowInterfaceIntent } from "./flow-interpreter-core";
import type { FlowRuntimeValue } from "./flow-formula";
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
} as const satisfies Record<PageIntentStepType, FlowInterfaceIntent["kind"]>;

/** Whether `value` may be written to a page value held as `declared` (same type, valid shape). */
export const pageValueAcceptsWrite = (
  declared: FlowRuntimeValue | undefined,
  value: FlowRuntimeValue | undefined,
): value is FlowRuntimeValue =>
  declared !== undefined &&
  value !== undefined &&
  value.type === declared.type &&
  (value.value === null ||
    (flowValueMatchesType(value.value, declared.type) &&
      (declared.type !== "json" || Array.isArray(value.value))));

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
