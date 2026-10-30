import type { PageIntentStepType } from "../workflows/flow-task-registry-data";
import type { FlowInterfaceIntent } from "./flow-interpreter-core";

/**
 * The intent the page performs for each registered page step. Adding a page implementation flag
 * requires its corresponding intent here.
 */
export const pageStepIntents = {
  "interface.show_message": "show_message",
  "interface.show_form": "show_form",
  "interface.confirm": "confirm",
  "interface.navigate": "navigate",
  "interface.refresh": "refresh",
  "interface.set_panel": "set_panel",
  "interface.set_filter": "set_filter",
} as const satisfies Record<PageIntentStepType, FlowInterfaceIntent["kind"]>;
