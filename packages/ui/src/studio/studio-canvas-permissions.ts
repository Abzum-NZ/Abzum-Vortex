import {
  applicationUses,
  describeApplicationUsers,
  sourceItemTree,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
  type SourceItem,
} from "@vortex/platform/schema";
import {
  itemSlots,
  regionRemovalCause,
  regions,
  releaseFor,
} from "./application-composition-regions";
import { studioLayoutOutletPlacementUses } from "./application-layout-outlets";
import {
  studioPlacementReferenceSentence,
  studioPlacementRemovalReferences,
} from "./composition-references";
import {
  holdsForm,
  studioFormChangeRefusalSentence,
  studioRegionForms,
  studioRemovalFormRefusal,
} from "./application-composition-forms";

export type StudioCanvasAction = "delete" | "drag" | "duplicate";
export type StudioCanvasReferences = Readonly<
  Record<string, Readonly<Partial<Record<StudioCanvasAction, string>>>>
>;

/** The same reason is available to Puck's permissions and the action bar. */
export const studioCanvasPermissionReason = (
  references: StudioCanvasReferences,
  alias: string,
  action: StudioCanvasAction,
): string | undefined => references[alias]?.[action];

/** What still refers to a block, other than blocks that leave with it: query inputs and message targets. */
export const studioPlacementReferrers = (
  source: ApplicationSourceDocument,
  alias: string,
  leaving: ReadonlySet<string>,
) =>
  [
    ...applicationUses(source, { kind: "placement", placementAlias: alias }),
    ...applicationUses(source, { kind: "message_target", placementAlias: alias }),
  ].filter((place) => place.open.kind !== "placement" || !leaving.has(place.open.placementAlias));

/**
 * Why a block cannot be duplicated, or undefined: a form, or a block holding a field input, because
 * its field inputs cannot be copied. The one rule for Puck's Duplicate button (the references) and
 * for the canvas change that carries a duplicate (`applyPageDataChange`).
 */
export const studioDuplicateRefusal = (
  catalogue: ImmutablePlatformBlockCatalogue,
  item: SourceItem,
  descendants: readonly SourceItem[] = sourceItemTree([item]),
): string | undefined => {
  if (holdsForm(catalogue, [item]))
    return "A form cannot be duplicated because its field inputs cannot be.";
  return descendants.some((child) => {
    const childRelease = releaseFor(catalogue, child);
    return (
      childRelease?.paletteGroup === "input" &&
      childRelease.properties.some(
        (property) => property.key === "name" || property.key === "field",
      )
    );
  })
    ? "A field input cannot be duplicated. Add another field instead."
    : undefined;
};

/** Why a page's blocks cannot be removed, by `regionRemovalCause`. */
const REGION_REMOVAL_REASONS = {
  page_kind:
    "Blocks can only be removed from a layout or from the content of a list, detail, form or dashboard page.",
  public_page: "This page is published at a public address, so its blocks can't be removed.",
} as const;

/** Build the references once for a draft; the values are plain metadata. */
export const studioCanvasReferences = (
  source: ApplicationSourceDocument,
  catalogue: ImmutablePlatformBlockCatalogue,
): StudioCanvasReferences => {
  const allRegions = regions(source);
  const aliases = new Set(
    allRegions.flatMap((region) => sourceItemTree(region.zone.items).map((item) => item.props.id)),
  );
  // The flows are scanned once for every block, not once per block.
  const flowReference = studioPlacementRemovalReferences(source, aliases);
  const result: Record<string, Partial<Record<StudioCanvasAction, string>>> = {};
  for (const region of allRegions) {
    // Only a page that holds a form can break one by removing a block; its forms are read once.
    const regionHoldsForm = holdsForm(catalogue, region.zone.items);
    const forms = regionHoldsForm ? studioRegionForms(catalogue, region.zone.items) : undefined;
    const regionCause = regionRemovalCause(source, region);
    const visit = (items: readonly SourceItem[], required: boolean, repeating: boolean) => {
      for (const item of items) {
        const id = item.props.id;
        const descendants = sourceItemTree([item]);
        const removed = new Set(descendants.map((child) => child.props.id));
        const reasons: Partial<Record<StudioCanvasAction, string>> = {};
        const release = releaseFor(catalogue, item);
        const duplicate = studioDuplicateRefusal(catalogue, item, descendants);
        if (duplicate !== undefined) reasons.duplicate = duplicate;
        // The tooltip names the outlets themselves, not every page bound to them.
        const outlets = studioLayoutOutletPlacementUses(source, id).filter(
          (place) => place.open.kind === "shell",
        );
        if (outlets.length > 0) {
          reasons.delete = `This block holds ${describeApplicationUsers(outlets)}. Retarget the outlet first.`;
          reasons.drag = reasons.delete;
        }
        for (const child of descendants) {
          const flow = flowReference(child.props.id);
          if (flow !== undefined) reasons.delete ??= studioPlacementReferenceSentence(flow);
          const users = studioPlacementReferrers(source, child.props.id, removed);
          if (users.length > 0)
            reasons.delete ??= `This block is used by ${describeApplicationUsers(users)}. Change that reference first.`;
        }
        if (required && items.length === 1) reasons.delete ??= "This block fills a required slot.";
        if (regionCause !== undefined) reasons.delete ??= REGION_REMOVAL_REASONS[regionCause];
        if (repeating)
          reasons.delete ??= "This block sits in a repeating area and can't be removed here.";
        const broken =
          forms === undefined
            ? undefined
            : studioRemovalFormRefusal(catalogue, source, forms, removed);
        if (broken !== undefined)
          reasons.delete ??= studioFormChangeRefusalSentence(
            broken,
            studioPlacementReferenceSentence,
          );
        result[id] = reasons;
        for (const [key, slot] of itemSlots(catalogue, item)) {
          const declaration = release?.slots.find((entry) => entry.key === key);
          visit(
            slot.items,
            declaration?.required === true,
            repeating || declaration?.repeats !== undefined,
          );
        }
      }
    };
    visit(region.zone.items, false, false);
  }
  return result;
};
