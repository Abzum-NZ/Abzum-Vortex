import {
  fieldInputControlKeys,
  isRecord,
  readCompiledItemSettings,
  walkPageComposition,
} from "@vortex/platform/schema";
import type {
  createPlatformComponentRegistryForReleases,
  FieldInputControlReleaseMap,
} from "@vortex/ui";

/** Current visible controls and the value contract of each one. */
export function draftControls(
  content: Readonly<Record<string, unknown>>,
  registry: ReturnType<typeof createPlatformComponentRegistryForReleases>,
  fieldReleases: FieldInputControlReleaseMap,
) {
  const controls: Record<string, { kind: string; payloadKind: string; fieldKey: string }> = {};
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
      if (release.rendererKey === "platform.renderer.field_input") {
        const control = readCompiledItemSettings(props, release).control;
        if (control?.kind !== "choice") return true;
        release = fieldReleases[control.value as keyof FieldInputControlReleaseMap]!;
        if (release === undefined) return true;
      }
      const payloadKind = release.rendererKey.replace(/^platform\.renderer\./, "");
      if (!fieldInputControlKeys.some((key) => payloadKind === `${key}_input`)) return true;
      const valueType = release.value_type;
      const valueKind =
        valueType?.kind === "boolean_setting"
          ? props[valueType.setting]
            ? valueType.when_true
            : valueType.when_false
          : valueType?.type;
      if (typeof props.name !== "string") return true;
      controls[placementId] = {
        fieldKey: props.name,
        kind: `${payloadKind}:${valueKind ?? ""}`,
        payloadKind,
      };
      return true;
    },
    true,
  );
  return controls;
}
