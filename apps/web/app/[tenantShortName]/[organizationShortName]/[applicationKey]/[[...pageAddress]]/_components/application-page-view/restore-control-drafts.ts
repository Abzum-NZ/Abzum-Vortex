import { fieldInputPayloadSchema, isRecord } from "@vortex/platform/schema";
import type { ControlDrafts } from "../../../_components/application-frame-state";
import type { draftControls } from "./control-drafts";

/** Restore only a still-visible control whose current parser accepts the remembered value. */
export function restoreDrafts(
  store: ControlDrafts,
  controls: ReturnType<typeof draftControls>,
  data: Readonly<Record<string, unknown>>,
) {
  store.restored = {};
  for (const [id, draft] of Object.entries(store.drafts)) {
    const control = controls[id];
    const current = data[id];
    if (
      control === undefined ||
      control.kind !== draft.kind ||
      (isRecord(current) && current.status !== "ready")
    ) {
      delete store.drafts[id];
      continue;
    }
    const currentValues = isRecord(current) && isRecord(current.values) ? current.values : {};
    const values = {
      ...currentValues,
      kind: control.payloadKind,
      value: draft.value,
      ...draft.display,
    };
    if (control.payloadKind === "link_input" && draft.value === null)
      delete (values as Record<string, unknown>).title;
    const parsed = fieldInputPayloadSchema.safeParse(values);
    if (parsed.success) store.restored[id] = { status: "ready", values: parsed.data };
    else {
      delete store.drafts[id];
    }
  }
}
