import type { DisplayInlineEditResult, DisplaySemanticEvent } from "@vortex/ui";
import type { PlacementFlowBinding } from "../../../../../../_lib/application-page";
import type { useRuntimeInputs } from "./use-runtime-inputs";
import { bindingFor, suppliedValues } from "./event-values";
import { cancelledMoveNotice, unavailableNotice } from "./notices";

type Inputs = Parameters<typeof useRuntimeInputs>[0];
type Context = Pick<Inputs, "runBinding"> & {
  placementId: string;
  bindings: readonly PlacementFlowBinding[];
};

/** Commit a cell at its displayed revision. */
export async function inlineEdit(
  {
    placementId,
    bindings,
    runBinding,
    refreshPlacements,
  }: Context & Pick<Inputs, "refreshPlacements">,
  editEvent: "inline_edit" | "row_edit",
  event: DisplaySemanticEvent,
): Promise<DisplayInlineEditResult> {
  if (event.event !== editEvent || (event.event !== "inline_edit" && event.event !== "row_edit"))
    return { kind: "refused", message: unavailableNotice.text, changed: false };
  const binding = bindingFor(bindings, event);
  if (binding === undefined) {
    console.error(`[page] ${editEvent} has no binding: EDIT_BINDING_MISSING`);
    return { kind: "refused", message: unavailableNotice.text, changed: false };
  }
  const outcome = await runBinding(
    placementId,
    binding,
    suppliedValues(event),
    event.recordId,
    { recordId: event.recordId, revision: event.revision },
    undefined,
    event.commandId,
    "in_place",
  );
  // A neutral refusal may mean the viewer's access to the field ended: the table is read once more
  // so a field no longer editable, or no longer readable, loses its editor and its draft.
  // A changed record is already read again by the dispatch. Nothing here writes.
  if (!outcome.confirmed && !outcome.changed && outcome.notice === unavailableNotice)
    void refreshPlacements([placementId], undefined, { content: true });
  return outcome.confirmed
    ? { kind: "saved" }
    : {
        kind: "refused",
        message: outcome.notice?.text ?? unavailableNotice.text,
        changed: outcome.changed,
        ...(outcome.corrections === undefined ? {} : { corrections: outcome.corrections }),
      };
}

/** Run a card move through its bound flow. */
export async function cardMoved(
  {
    placementId,
    bindings,
    runBinding,
    showPageMessage,
    formCancelledRef,
  }: Context & Pick<Inputs, "showPageMessage" | "formCancelledRef">,
  event: DisplaySemanticEvent,
): Promise<boolean> {
  if (event.event !== "card_moved") return false;
  const binding = bindingFor(bindings, event);
  if (binding === undefined || event.revision === undefined) {
    console.error(
      `[page] card move has no binding or revision: ${binding === undefined ? "BOARD_CARD_MOVE_BINDING_MISSING" : "BOARD_CARD_MOVE_REVISION_MISSING"}`,
    );
    showPageMessage(unavailableNotice);
    return false;
  }
  let accepted = false;
  formCancelledRef.current = false;
  await runBinding(
    placementId,
    binding,
    suppliedValues(event),
    event.recordId,
    { recordId: event.recordId, revision: event.revision },
    async () => {
      // A flow whose form the person cancelled finishes as completed without saving, so
      // the move is not accepted and the card goes back to its column.
      if (formCancelledRef.current) return cancelledMoveNotice;
      accepted = true;
      return undefined;
    },
  );
  return accepted;
}

/** Run a card add through its bound flow. */
export async function cardAdded(
  { placementId, bindings, runBinding, showPageMessage }: Context & Pick<Inputs, "showPageMessage">,
  event: DisplaySemanticEvent,
): Promise<boolean> {
  if (event.event !== "card_added") return false;
  const binding = bindingFor(bindings, event);
  if (binding === undefined) {
    console.error("[page] card add has no binding: BOARD_CARD_ADD_BINDING_MISSING");
    showPageMessage(unavailableNotice);
    return false;
  }
  const outcome = await runBinding(placementId, binding, suppliedValues(event));
  return outcome.confirmed;
}
