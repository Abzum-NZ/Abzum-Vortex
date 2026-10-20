import type { DisplaySemanticEvent } from "@vortex/ui";
import type { PlacementFlowBinding } from "../../../../../../_lib/application-page";
import type { ComponentFlowBinding } from "./types";

export const asComponentBinding = (
  placementId: string,
  binding: PlacementFlowBinding,
): ComponentFlowBinding =>
  ({
    bindingId: binding.bindingId,
    // The placement id and the binding's control id are the same stable identity.
    controlId: placementId,
    eventId: binding.eventId,
    event: binding.event,
    flow: { flowId: binding.flowId, inputs: {} },
  }) as ComponentFlowBinding;

/**
 * What a component event supplies to its bound flow, by the caller input names the flow declares.
 * The vocabulary is closed and event-shaped: `record_id`, `revision`, `value` and `values` (the
 * one changed field of a moved board card or an inline edit, named by its field key and holding the
 * new stored value). A binding receives only the names it declares, and the endpoint refuses
 * anything else.
 *
 * A row action carries the row's server-projected current revision, so a command that changes one
 * existing row is bound at the revision the person actually saw. An inline edit carries its
 * revision as the gesture's subject. The revision comes from the
 * projected row, never from anything the person types.
 */
export const suppliedValues = (event: DisplaySemanticEvent): Record<string, unknown> => {
  switch (event.event) {
    case "row_clicked":
      return { record_id: event.recordId };
    case "row_action":
      return {
        record_id: event.recordId,
        ...(event.revision === undefined ? {} : { revision: event.revision }),
      };
    case "row_edit":
      return { record_id: event.recordId, values: event.values };
    case "inline_edit":
      return { record_id: event.recordId, values: { [event.field]: event.value } };
    case "card_moved":
      return {
        record_id: event.recordId,
        values: { [event.field]: event.value },
        value: event.value,
        ...(event.revision === undefined ? {} : { revision: event.revision }),
      };
    default:
      return {};
  }
};

/**
 * The one binding a control placement holds for an event its control emits without an event
 * identity. A placement that holds several for the same event names none, so nothing is guessed.
 */
export const bindingOfEvent = (
  bindings: readonly PlacementFlowBinding[],
  event: string,
): PlacementFlowBinding | undefined => {
  const ofKind = bindings.filter((binding) => binding.event === event);
  return ofKind.length === 1 ? ofKind[0] : undefined;
};

const eventIdOf = (event: DisplaySemanticEvent): string | undefined =>
  "eventId" in event ? event.eventId : undefined;

export const choiceScopeKey = (placementId: string, formId?: string): string =>
  formId === undefined ? placementId : `${formId}\u0000${placementId}`;

/**
 * Finds the binding an event identity names. A placement-level event matches only when the
 * placement declares exactly one binding of its kind, so it never guesses between several.
 */
export const bindingFor = (
  bindings: readonly PlacementFlowBinding[],
  event: DisplaySemanticEvent,
): PlacementFlowBinding | undefined => {
  const ofKind = bindings.filter((binding) => binding.event === event.event);
  const eventId = eventIdOf(event);
  if (eventId !== undefined) return ofKind.find((binding) => binding.eventId === eventId);
  return ofKind.length === 1 ? ofKind[0] : undefined;
};
