import { fieldInputPayloadSchema, isRecord } from "@vortex/platform/schema";
import type { ControlDrafts } from "../../../_components/application-frame-state";
import type { draftControls } from "./control-drafts";

/** Restore only a still-visible control whose current parser accepts the remembered value. */
export function restoreDrafts(
  store: ControlDrafts,
  controls: ReturnType<typeof draftControls>,
  data: Readonly<Record<string, unknown>>,
  formOwners: Readonly<Record<string, string>>,
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
  for (const [formId, baseline] of Object.entries(store.baselines)) {
    if (!Object.values(store.drafts).some((draft) => draft.owner === formId)) {
      delete store.baselines[formId];
      delete store.baselineFields[formId];
      continue;
    }
    const oldFields = store.baselineFields[formId] ?? {};
    const fields = Object.fromEntries(
      Object.entries(controls).filter(([id]) => formOwners[id] === formId),
    );
    store.baselines[formId] = Object.fromEntries(
      Object.entries(fields).flatMap(([id, field]) => {
        const old = oldFields[id];
        return old?.kind === field.kind && Object.hasOwn(baseline, old.fieldKey)
          ? [[field.fieldKey, baseline[old.fieldKey]]]
          : [];
      }),
    );
    store.baselineFields[formId] = Object.fromEntries(
      Object.entries(fields).map(([id, field]) => [
        id,
        { kind: field.kind, fieldKey: field.fieldKey },
      ]),
    );
  }
}

/** Rebase each restored form after its controls have registered. */
export function restoreBaselines(
  store: ControlDrafts,
): NonNullable<ControlDrafts["restoreBaselines"]> {
  return (registry) => {
    for (const [id, draft] of Object.entries(store.drafts)) {
      const owner = draft.owner;
      const baseline = owner === undefined ? undefined : store.baselines[owner];
      const current = owner === undefined ? undefined : registry.valuesOf(owner);
      if (baseline !== undefined && current !== undefined && store.restored[id] !== undefined)
        registry.markSaved(owner!, { ...current, ...baseline });
    }
  };
}
