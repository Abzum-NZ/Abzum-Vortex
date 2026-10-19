import type { InstalledRuntimeContext } from "@vortex/platform/server";
import {
  TABLE_BLOCK_RELEASE,
  FIELD_INPUT_BLOCK_RELEASE,
  FIELD_INPUT_CONTROL_RELEASES,
  FORM_CONTAINER_BLOCK_RELEASE,
  placementSettings,
} from "@vortex/platform/server";
import {
  type PageDefinition,
  type ApplicationShell,
  type CompiledItem,
  type CompiledLayout,
  type FlowTask,
  compiledItemSlots,
  compiledPageRootSlots,
  compiledPageShellId,
  flowTaskChildLists,
  isRecord,
  sameId,
  walkPageComposition,
} from "@vortex/platform/schema";
import type { InstalledFlow, ModuleRelease, ModuleField } from "./types";

export { isBoardPlacement, projectedUseAvailability } from "@vortex/platform/server";

/**
 * The page address parameter that carries a detail page's subject record id, the same name the
 * component event vocabulary uses for a record identity. It is only a candidate: the record read
 * path decides whether the viewer may read that record.
 */
export const pageSubjectParameter = "record_id";

export const first = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === "string" ? value : value?.[0];

/**
 * One placed item of a projected page: the item itself and, read from it, its props, its Vortex
 * metadata (`props.vortex`) and its typed settings, read by its block release's declaration.
 */
type PlacedItem = Readonly<{
  placementId: string;
  item: Record<string, unknown>;
  props: Record<string, unknown>;
  vortex: Record<string, unknown>;
  settings: Record<string, unknown>;
  formId?: string;
}>;

/** The parts of a placed item the placement predicates read. */
type PlacedItemParts = Pick<PlacedItem, "vortex" | "props" | "settings">;

/** Reads only the projected body; shell chrome and permission reasons do not count as content. */
export const projectedBodyContentAvailable = (
  definition: Exclude<PageDefinition, { type: "guided_form" }>,
  shells: readonly ApplicationShell[],
  projected: Readonly<Record<string, unknown>>,
): boolean => {
  const breakpoints = ["desktop", "tablet", "phone"] as const;
  type Visibility = Record<(typeof breakpoints)[number], boolean>;
  // The stored Page service has already parsed and projected this canonical composition.
  const layout = projected.composition as CompiledLayout;
  const visibleContent = (items: readonly CompiledItem[], ancestors: Visibility): boolean =>
    items.some((item) =>
      breakpoints.some(
        (breakpoint) => ancestors[breakpoint] && item.props.vortex.responsive[breakpoint].visible,
      ),
    );
  const visible: Visibility = { desktop: true, tablet: true, phone: true };
  const composition = definition.composition;
  const shellId = compiledPageShellId(composition);
  if (shellId === null) return visibleContent(layout.content, visible);

  const shell = shells.find((candidate) => candidate.shellId === shellId);
  if (shell === undefined) throw new Error("Page body composition unavailable");
  const filled = new Set(compiledPageRootSlots(composition).map(([slotId]) => slotId));
  const targets = new Map<string, Set<string>>();
  for (const binding of shell.contentSlots) {
    if (!filled.has(String(binding.slotId))) continue;
    const id = String(binding.parentPlacementId).toLowerCase();
    const slots = targets.get(id) ?? new Set<string>();
    slots.add(binding.parentSlotKey);
    targets.set(id, slots);
  }
  const visit = (items: readonly CompiledItem[], ancestors: Visibility): boolean =>
    items.some((item) => {
      const responsive = item.props.vortex.responsive;
      const effective: Visibility = {
        desktop: ancestors.desktop && responsive.desktop.visible,
        tablet: ancestors.tablet && responsive.tablet.visible,
        phone: ancestors.phone && responsive.phone.visible,
      };
      return compiledItemSlots(item).some(
        ([slotKey, children]) =>
          (targets.get(item.props.id.toLowerCase())?.has(slotKey) === true &&
            visibleContent(children, effective)) ||
          visit(children, effective),
      );
    });
  return visit(layout.content, visible);
};

export const isTablePlacement = ({ vortex }: Pick<PlacedItem, "vortex">): boolean =>
  isRecord(vortex.block) &&
  typeof vortex.block.blockId === "string" &&
  sameId(vortex.block.blockId, TABLE_BLOCK_RELEASE.blockId);

export const isEditFieldPlacement = (placement: PlacedItemParts): boolean => {
  const block = placement.vortex.block;
  return (
    isRecord(block) &&
    typeof block.blockId === "string" &&
    (sameId(block.blockId, FIELD_INPUT_BLOCK_RELEASE.blockId) ||
      Object.values(FIELD_INPUT_CONTROL_RELEASES).some((release) =>
        sameId(release.blockId, block.blockId as string),
      ))
  );
};

/**
 * A link field's input: an automatic field input whose derived control is a link, or a link
 * input placed on its own. Either is the one record picker.
 */
export const isLinkInputPlacement = ({ vortex, settings }: PlacedItemParts): boolean => {
  const block = vortex.block;
  if (!isRecord(block) || typeof block.blockId !== "string") return false;
  if (sameId(block.blockId, FIELD_INPUT_CONTROL_RELEASES.link.blockId)) return true;
  const control = settings.control;
  return (
    sameId(block.blockId, FIELD_INPUT_BLOCK_RELEASE.blockId) &&
    isRecord(control) &&
    control.kind === "choice" &&
    control.value === "link"
  );
};

/** The record types a link input may point at, as the installed release resolved them. */
export const linkInputTargets = (
  settings: Readonly<Record<string, unknown>>,
): readonly Readonly<{ moduleRootId: string; recordTypeId: string }>[] => {
  const targets = settings.record_types;
  if (!isRecord(targets) || targets.kind !== "list" || !Array.isArray(targets.items)) return [];
  return targets.items.flatMap((item: unknown) =>
    isRecord(item) &&
    item.kind === "record_type_reference" &&
    isRecord(item.recordType) &&
    item.recordType.state === "resolved" &&
    typeof item.recordType.moduleRootId === "string" &&
    typeof item.recordType.recordTypeId === "string"
      ? [{ moduleRootId: item.recordType.moduleRootId, recordTypeId: item.recordType.recordTypeId }]
      : [],
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
          isRecord(reference) && reference.source === "input" && typeof reference.name === "string"
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
  placement: PlacedItemParts,
  modules: InstalledRuntimeContext["releaseSet"]["modules"],
): Readonly<{ module: ModuleRelease; field: ModuleField }> | undefined => {
  const settings = placement.settings;
  if (!isRecord(settings.field)) return undefined;
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

export const fieldControl = (placement: PlacedItemParts): string | undefined => {
  const settings = placement.settings;
  const block = placement.vortex.block;
  return isRecord(block) &&
    typeof block.blockId === "string" &&
    sameId(block.blockId, FIELD_INPUT_BLOCK_RELEASE.blockId) &&
    isRecord(settings.control) &&
    settings.control.kind === "choice" &&
    typeof settings.control.value === "string"
    ? settings.control.value
    : undefined;
};

/** Every placed item of the projected page with its stable identity, in document order. */
export const collectPlacements = (projected: Readonly<Record<string, unknown>>): PlacedItem[] => {
  const found: PlacedItem[] = [];
  walkPageComposition(
    projected.composition,
    ({ placementId, item, props, vortex }, formId: string | undefined) => {
      const block = vortex.block;
      const owner =
        isRecord(block) &&
        typeof block.blockId === "string" &&
        sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId)
          ? placementId
          : formId;
      found.push({
        placementId,
        item,
        props,
        vortex,
        settings: placementSettings(props),
        ...(owner === undefined ? {} : { formId: owner }),
      });
      return owner;
    },
  );
  return found;
};
