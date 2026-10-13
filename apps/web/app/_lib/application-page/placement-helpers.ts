import type { InstalledRuntimeContext } from "@web/platform-server";
import {
  BOARD_BLOCK_RELEASE,
  TABLE_BLOCK_RELEASE,
  FIELD_INPUT_BLOCK_RELEASE,
  FIELD_INPUT_CONTROL_RELEASES,
  FORM_CONTAINER_BLOCK_RELEASE,
} from "@vortex/platform/server";
import {
  type PageDefinition,
  type ApplicationShell,
  type FlowTask,
  flowTaskChildLists,
  isRecord,
  sameId,
  walkPageComposition,
} from "@vortex/platform/schema";
import { hasReferenceChoiceSource } from "../reference-choices";
import type { InstalledFlow, ModuleRelease, ModuleField } from "./types";

/**
 * The page address parameter that carries a detail page's subject record id, the same name the
 * component event vocabulary uses for a record identity. It is only a candidate: the record read
 * path decides whether the viewer may read that record.
 */
export const pageSubjectParameter = "record_id";

export const first = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === "string" ? value : value?.[0];

/** Reads only the projected body; shell chrome and permission reasons do not count as content. */
export const projectedBodyContentAvailable = (
  definition: Exclude<PageDefinition, { type: "guided_form" }>,
  shells: readonly ApplicationShell[],
  projected: Readonly<Record<string, unknown>>,
): boolean => {
  type Slot = ApplicationShell["layout"];
  const breakpoints = ["desktop", "tablet", "phone"] as const;
  type Visibility = Record<(typeof breakpoints)[number], boolean>;
  // The stored Page service has already parsed and projected this canonical composition.
  const main = (projected.composition as { main: Slot }).main;
  const visibleContent = (slot: Slot, ancestors: Visibility): boolean =>
    Object.values(slot.placements).some((placement) =>
      breakpoints.some((breakpoint) =>
        ancestors[breakpoint] && placement.responsive[breakpoint].visible,
      ),
    );
  const visible: Visibility = { desktop: true, tablet: true, phone: true };
  const composition = definition.composition;
  if (composition.shellKind === "default") return visibleContent(main, visible);

  const shell = shells.find((candidate) => candidate.shellId === composition.shellId);
  if (shell === undefined) throw new Error("Page body composition unavailable");
  const targets = new Map<string, Set<string>>();
  for (const binding of shell.contentSlots) {
    if (!Object.hasOwn(composition.content, String(binding.slotId))) continue;
    const id = String(binding.parentPlacementId).toLowerCase();
    const slots = targets.get(id) ?? new Set<string>();
    slots.add(binding.parentSlotKey);
    targets.set(id, slots);
  }
  const visit = (slot: Slot, ancestors: Visibility): boolean =>
    Object.entries(slot.placements).some(([placementId, placement]) => {
      const effective: Visibility = {
        desktop: ancestors.desktop && placement.responsive.desktop.visible,
        tablet: ancestors.tablet && placement.responsive.tablet.visible,
        phone: ancestors.phone && placement.responsive.phone.visible,
      };
      return Object.entries(placement.slots).some(([slotKey, child]) =>
        (targets.get(placementId.toLowerCase())?.has(slotKey) === true &&
          visibleContent(child, effective)) || visit(child, effective),
      );
    });
  return visit(main, visible);
};

export const isBoardPlacement = (placement: unknown): boolean => {
  if (!isRecord(placement) || !isRecord(placement.block)) return false;
  return (
    typeof placement.block.blockId === "string" &&
    sameId(placement.block.blockId, BOARD_BLOCK_RELEASE.blockId) &&
    placement.block.releaseVersion === BOARD_BLOCK_RELEASE.releaseVersion
  );
};

export const isTablePlacement = (placement: unknown): boolean =>
  isRecord(placement) &&
  isRecord(placement.block) &&
  typeof placement.block.blockId === "string" &&
  sameId(placement.block.blockId, TABLE_BLOCK_RELEASE.blockId);

export const projectedUseAvailability = (placement: unknown): "available" | "unavailable" | "invalid" => {
  if (!isRecord(placement)) return "invalid";
  const hasAvailability = Object.hasOwn(placement, "availability");
  const hasReason = Object.hasOwn(placement, "unavailableReason");
  if (!hasAvailability && !hasReason) return "available";
  if (
    hasAvailability &&
    hasReason &&
    placement.availability === "unavailable" &&
    placement.unavailableReason === "operation_unavailable"
  )
    return "unavailable";
  return "invalid";
};

export const isUnboundReferenceChoicePlacement = (placement: Readonly<Record<string, unknown>>): boolean => {
  if (!hasReferenceChoiceSource(placement) || !isRecord(placement.settings)) return false;
  const source = placement.settings.choice_source;
  return isRecord(source) && isRecord(source.properties) && !Object.hasOwn(source.properties, "input");
};

export const isEditFieldPlacement = (placement: Readonly<Record<string, unknown>>): boolean => {
  const block = placement.block;
  return (
    isUnboundReferenceChoicePlacement(placement) ||
    (isRecord(block) &&
      typeof block.blockId === "string" &&
      (sameId(block.blockId, FIELD_INPUT_BLOCK_RELEASE.blockId) ||
        Object.values(FIELD_INPUT_CONTROL_RELEASES).some((release) =>
          sameId(release.blockId, block.blockId as string),
        )))
  );
};

/** The record-reference inputs that the installed flow uses for selected-field reads. */
export const selectedReadInputTypes = (flow: InstalledFlow): ReadonlyMap<string, string> => {
  const inputTypes = new Map<string, string | null>();
  const visit = (tasks: readonly FlowTask[]): void => {
    for (const task of tasks) {
      if (task.type === "record.read_fields") {
        const properties = "properties" in task ? task.properties : undefined;
        const recordType = properties?.record_type;
        const recordTypeId =
          isRecord(recordType) &&
          recordType.kind === "literal" &&
          isRecord(recordType.literal) &&
          recordType.literal.type === "text" &&
          typeof recordType.literal.value === "string"
            ? recordType.literal.value
            : undefined;
        const record = properties?.record;
        const reference =
          isRecord(record) && record.kind === "reference" ? record.reference : undefined;
        const inputName =
          isRecord(reference) &&
          reference.source === "input" &&
          typeof reference.name === "string"
            ? reference.name
            : undefined;
        const declaration = inputName === undefined ? undefined : flow.inputs[inputName];
        if (
          inputName !== undefined &&
          recordTypeId !== undefined &&
          declaration?.type === "record_reference" &&
          declaration.recordTypeIds?.length === 1 &&
          sameId(declaration.recordTypeIds[0]!, recordTypeId)
        ) {
          const previous = inputTypes.get(inputName);
          inputTypes.set(
            inputName,
            previous === undefined || (previous !== null && sameId(previous, recordTypeId))
              ? recordTypeId
              : null,
          );
        }
      }
      for (const child of flowTaskChildLists(task)) visit(child.tasks);
    }
  };
  visit([...flow.tasks, ...flow.errors, ...flow.finally]);
  return new Map(
    [...inputTypes].flatMap(([inputName, recordTypeId]) =>
      recordTypeId === null ? [] : [[inputName, recordTypeId] as const],
    ),
  );
};

export const fieldForPlacement = (
  placement: Readonly<Record<string, unknown>>,
  modules: InstalledRuntimeContext["releaseSet"]["modules"],
): Readonly<{ module: ModuleRelease; field: ModuleField }> | undefined => {
  const settings = placement.settings;
  if (!isRecord(settings) || !isRecord(settings.field)) return undefined;
  const reference = settings.field;
  if (reference.kind !== "field_reference" || typeof reference.fieldId !== "string")
    return undefined;
  for (const module of modules)
    for (const recordType of module.content.recordTypes) {
      const field = recordType.fields.find((candidate) =>
        sameId(String(candidate.fieldId), reference.fieldId as string),
      );
      if (field !== undefined) return { module, field };
    }
  return undefined;
};

export const fieldControl = (placement: Readonly<Record<string, unknown>>): string | undefined => {
  const settings = placement.settings;
  const block = placement.block;
  return isRecord(settings) && isRecord(block) &&
    typeof block.blockId === "string" &&
    sameId(block.blockId, FIELD_INPUT_BLOCK_RELEASE.blockId) &&
    isRecord(settings.control) && settings.control.kind === "choice" &&
    typeof settings.control.value === "string"
    ? settings.control.value
    : undefined;
};

/** Every placement of the projected page with its stable identity, in document order. */
export const collectPlacements = (
  projected: Readonly<Record<string, unknown>>,
): Array<
  Readonly<{ placementId: string; placement: Record<string, unknown>; formId?: string }>
> => {
  const found: Array<{ placementId: string; placement: Record<string, unknown>; formId?: string }> =
    [];
  walkPageComposition(
    projected.composition,
    ({ placementId, placement }, formId: string | undefined) => {
      const block = placement.block;
      const owner =
        isRecord(block) &&
        typeof block.blockId === "string" &&
        sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId)
          ? placementId
          : formId;
      found.push({ placementId, placement, ...(owner === undefined ? {} : { formId: owner }) });
      return owner;
    },
  );
  return found;
};
