import { isRecord, sameId } from "../catalogue/runtime-primitives";
import {
  CONTROL_BLOCK_RELEASES,
  FORM_CONTAINER_BLOCK_RELEASE,
  placementSettings,
} from "../definition/application-composition-catalogue";
import type { SystemApplicationBoundReleaseSetResult } from "../definition/definition-consumer-read";
import { walkPageComposition, walkPlacementData } from "../pages/placement-walk";
import { flowRuntimeValueOf } from "../rules/flow-runtime-value";

/** Declared field types under the permanent identities of installed form placements. */
export type FlowFormTypes = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** Derives form types from the installed release, never from a submitted field value. */
export const installedFlowFormTypes = (
  releaseSet: SystemApplicationBoundReleaseSetResult,
): FlowFormTypes => {
  const forms: Record<string, Record<string, string>> = {};
  const fields = releaseSet.modules.flatMap((module) =>
    module.content.recordTypes.flatMap((record) => record.fields),
  );
  const visit = (
    {
      placementId,
      props,
      vortex,
    }: { placementId: string; props: Record<string, unknown>; vortex: Record<string, unknown> },
    inherited: string | undefined,
  ): string | undefined => {
    const block = vortex.block;
    if (
      !isRecord(block) ||
      typeof block.blockId !== "string" ||
      typeof block.releaseVersion !== "string"
    )
      return inherited;
    if (
      sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId) &&
      block.releaseVersion === FORM_CONTAINER_BLOCK_RELEASE.releaseVersion
    ) {
      forms[placementId] ??= {};
      return placementId;
    }
    if (inherited === undefined) return inherited;
    const release = CONTROL_BLOCK_RELEASES.find(
      (candidate) =>
        sameId(candidate.blockId, block.blockId as string) &&
        candidate.releaseVersion === block.releaseVersion,
    );
    if (release === undefined) return inherited;
    const settings = placementSettings(props);
    const name = settings.name;
    if (name?.kind !== "text" || name.value === "") return inherited;
    const reference = settings.field;
    let type: string | undefined;
    if (reference?.kind === "field_reference") {
      const matching = fields.filter((field) => sameId(field.fieldId, reference.fieldId));
      if (matching.length !== 1) return inherited;
      const field = matching[0]!;
      const settings = field.settings;
      const resultType =
        isRecord(settings) && "resultType" in settings && typeof settings.resultType === "string"
          ? settings.resultType
          : undefined;
      type = flowRuntimeValueOf(field.type, null, resultType).type;
    } else if (release.value_type?.kind === "fixed") type = release.value_type.type;
    else if (release.value_type?.kind === "boolean_setting") {
      const setting = settings[release.value_type.setting];
      type =
        setting?.kind === "boolean" && setting.value
          ? release.value_type.when_true
          : release.value_type.when_false;
    }
    if (type === undefined) return inherited;
    const previous = forms[inherited]![name.value];
    if (previous !== undefined && previous !== type)
      throw new Error("FLOW_FORM_FIELD_TYPE_AMBIGUOUS");
    forms[inherited]![name.value] = type;
    return inherited;
  };
  for (const page of releaseSet.application.content.pages)
    walkPageComposition(page.composition, visit);
  for (const shell of releaseSet.application.content.shells) walkPlacementData(shell.layout, visit);
  return forms;
};
