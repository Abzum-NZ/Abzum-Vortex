import type { DisplayInlineEditResult, DisplaySemanticEvent } from "@vortex/ui";
import type { PlacementFlowBinding } from "../../../../../../_lib/application-page";
import { bindingFor, suppliedValues } from "./event-values";
import { cancelledMoveNotice, unavailableNotice } from "./notices";
import type { useRuntimeInputs } from "./use-runtime-inputs";

type Dependencies = Pick<
  Parameters<typeof useRuntimeInputs>[0],
  "runBinding" | "refreshPlacements" | "setNotice" | "formCancelledRef"
> &
  Readonly<{
    placementId: string;
    bindings: readonly PlacementFlowBinding[];
  }>;

/** Run edits through the placement's existing binding and refresh path. */
export async function runInlineEdit(
  event: DisplaySemanticEvent,
  editEvent: "inline_edit" | "row_edit",
  { placementId, bindings, runBinding, refreshPlacements }: Dependencies,
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

/** Keep a moved card pending until its bound flow resolves. */
export async function runCardMove(
  event: DisplaySemanticEvent,
  { placementId, bindings, runBinding, setNotice, formCancelledRef }: Dependencies,
): Promise<boolean> {
  if (event.event !== "card_moved") return false;
  const binding = bindingFor(bindings, event);
  if (binding === undefined || event.revision === undefined) {
    console.error(
      `[page] card move has no binding or revision: ${binding === undefined ? "BOARD_CARD_MOVE_BINDING_MISSING" : "BOARD_CARD_MOVE_REVISION_MISSING"}`,
    );
    setNotice(unavailableNotice);
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

/** Add a card through its existing flow binding. */
export async function runCardAdd(
  event: DisplaySemanticEvent,
  { placementId, bindings, runBinding, setNotice }: Dependencies,
): Promise<boolean> {
  if (event.event !== "card_added") return false;
  const binding = bindingFor(bindings, event);
  if (binding === undefined) {
    console.error("[page] card add has no binding: BOARD_CARD_ADD_BINDING_MISSING");
    setNotice(unavailableNotice);
    return false;
  }
  const outcome = await runBinding(placementId, binding, suppliedValues(event));
  return outcome.confirmed;
}
