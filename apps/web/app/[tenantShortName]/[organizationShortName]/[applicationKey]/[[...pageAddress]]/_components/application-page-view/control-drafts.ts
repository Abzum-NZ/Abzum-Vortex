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
        !payloadKind.endsWith("_input") ||
        !(fieldInputControlKeys as readonly string[]).includes(payloadKind.slice(0, -6))
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
