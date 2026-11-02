import { recordIdSchema } from "@vortex/platform/schema";
import type { PlacementFlowBinding } from "@vortex/ui";

/**
 * What a gesture supplies to its bound flow, by the caller input names the binding declares. A
 * record the gesture is about fills each selected-read input the binding names, as the record
 * reference the flow declares; the server checks its exact type against the installed read
 * projection before accepting it. Everything the binding does not declare is dropped, and the
 * endpoint refuses anything else.
 */
export const bindingCallerInputs = (
  binding: PlacementFlowBinding,
  supplied: Readonly<Record<string, unknown>>,
  selectedRecordId?: string,
): Record<string, unknown> => {
  const callerInputs: Record<string, unknown> = { ...supplied };
  for (const selectedReadInput of binding.selectedReadInputs ?? []) {
    // A link field already supplies its selected record reference.
    if (binding.event === "field_changed") continue;
    delete callerInputs[selectedReadInput.callerInputName];
    if (
      binding.recordTypeId === undefined ||
      binding.recordTypeId.toLowerCase() !== selectedReadInput.recordTypeId.toLowerCase()
    )
      continue;
    const parsedRecordId = recordIdSchema.safeParse(selectedRecordId);
    if (!parsedRecordId.success) continue;
    callerInputs[selectedReadInput.callerInputName] = {
      recordTypeId: binding.recordTypeId,
      recordId: parsedRecordId.data,
    };
  }
  return Object.fromEntries(
    Object.entries(callerInputs).filter(([name]) => binding.callerInputs.includes(name)),
  );
};
