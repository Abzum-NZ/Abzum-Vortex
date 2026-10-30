import {
  fieldInputPayloadSchema,
  isRecord,
  readCompiledItemSettings,
  walkPageComposition,
} from "@vortex/platform/schema";
import type {
  createPlatformComponentRegistryForReleases,
  FieldInputControlReleaseMap,
} from "@vortex/ui";

import type { ControlDrafts } from "../../../_components/application-frame-state";

/** Current visible controls and the value contract of each one. */
export function draftControls(
  content: Readonly<Record<string, unknown>>,
  registry: ReturnType<typeof createPlatformComponentRegistryForReleases>,
  fieldReleases: FieldInputControlReleaseMap,
) {
  const controls: Record<string, { kind: string; payloadKind: string }> = {};
  walkPageComposition(
    content.composition,
    ({ placementId, props, vortex }, available: boolean) => {
      if (!available || vortex.availability === "unavailable") return false;
      const block = vortex.block;
      if (
        !isRecord(block) ||
        typeof block.blockId !== "string" ||
        typeof block.releaseVersion !== "string"
      )
        return true;
      const registration = registry.get(block.blockId, block.releaseVersion);
      if (
        registration === undefined ||
        !registration.metadata.supportedEvents.includes("field_changed")
      )
        return true;
      let release = registration.metadata;
      const settings = readCompiledItemSettings(props, release);
      if (release.rendererKey === "platform.renderer.field_input") {
        const control = settings.control;
        if (control?.kind !== "choice") return true;
        release = fieldReleases[control.value as keyof FieldInputControlReleaseMap]!;
        if (release === undefined) return true;
      }
      const payloadKind = release.rendererKey.replace(/^platform\.renderer\./, "");
      if (
        ![
          "text_input",
          "number_input",
          "boolean_input",
          "date_input",
          "date_time_input",
          "choice_input",
          "several_choices_input",
          "rich_text_input",
          "table_input",
          "link_input",
          "attachment_input",
        ].includes(payloadKind)
      )
        return true;
      const valueType = release.value_type;
      const selectedType =
        valueType?.kind === "boolean_setting" ? settings[valueType.setting] : undefined;
      controls[placementId] = {
        kind: JSON.stringify([payloadKind, valueType, selectedType]),
        payloadKind,
      };
      return true;
    },
    true,
  );
  return controls;
}

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
      delete store.values[id];
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
      delete store.values[id];
    }
  }
}
