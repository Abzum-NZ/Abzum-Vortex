import {
  applicationUses,
  describeApplicationUsers,
  sourceItemTree,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
  type SourceItem,
} from "@vortex/platform/schema";
import { itemSlots, regions, releaseFor } from "./application-composition-regions";
import { studioLayoutOutletPlacementUses } from "./application-layout-outlets";
import {
  studioPlacementReferenceSentence,
  studioPlacementRemovalReference,
} from "./composition-references";
import {
  holdsForm,
  studioFormChangeRefusal,
  studioFormChangeRefusalSentence,
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

/** Build the references once for a draft; the values are plain metadata. */
export const studioCanvasReferences = (
  source: ApplicationSourceDocument,
  catalogue: ImmutablePlatformBlockCatalogue,
): StudioCanvasReferences => {
  const allRegions = regions(source);
  const aliases = new Set(
    allRegions.flatMap((region) => sourceItemTree(region.zone.items).map((item) => item.props.id)),
  );
  const result: Record<string, Partial<Record<StudioCanvasAction, string>>> = {};
  for (const region of allRegions) {
    const without = (items: readonly SourceItem[], alias: string): SourceItem[] =>
      items
        .filter((item) => item.props.id !== alias)
        .map((item) => {
          const copy = structuredClone(item);
          for (const [key, slot] of itemSlots(catalogue, item))
            copy.props[key] = without(slot.items, alias);
          return copy;
        });
    const visit = (items: readonly SourceItem[], required: boolean) => {
      for (const item of items) {
        const id = item.props.id;
        const descendants = sourceItemTree([item]);
        const removed = new Set(descendants.map((child) => child.props.id));
        const reasons: Partial<Record<StudioCanvasAction, string>> = {};
        const release = releaseFor(catalogue, item);
        if (holdsForm(catalogue, [item]))
          reasons.duplicate = "A form cannot be duplicated because its field inputs cannot be.";
        if (
          descendants.some((child) => {
            const childRelease = releaseFor(catalogue, child);
            return (
              childRelease?.paletteGroup === "input" &&
              childRelease.properties.some(
                (property) => property.key === "name" || property.key === "field",
              )
            );
          })
        )
          reasons.duplicate ??= "A field input cannot be duplicated. Add another field instead.";
        const outlets = studioLayoutOutletPlacementUses(source, id);
        if (outlets.length > 0) {
          reasons.delete = `This block holds ${describeApplicationUsers(outlets)}. Retarget the outlet first.`;
          reasons.drag = reasons.delete;
        }
        for (const child of descendants) {
          const users = [
            ...applicationUses(source, { kind: "placement", placementAlias: child.props.id }),
            ...applicationUses(source, { kind: "message_target", placementAlias: child.props.id }),
          ].filter(
            (place) => place.open.kind !== "placement" || !removed.has(place.open.placementAlias),
          );
          if (users.length > 0)
            reasons.delete ??= `This block is used by ${describeApplicationUsers(users)}. Change that reference first.`;
          const flow = studioPlacementRemovalReference(source, child.props.id, aliases);
          if (flow !== undefined) reasons.delete ??= studioPlacementReferenceSentence(flow);
        }
        if (required && items.length === 1) reasons.delete ??= "This block fills a required slot.";
        const broken = studioFormChangeRefusal(
          catalogue,
          source,
          region.zone.items,
          without(region.zone.items, id),
        );
        if (broken !== undefined)
          reasons.delete ??= studioFormChangeRefusalSentence(
            broken,
            studioPlacementReferenceSentence,
          );
        result[id] = reasons;
        for (const [key, slot] of itemSlots(catalogue, item)) {
          const declaration = release?.slots.find((entry) => entry.key === key);
          visit(slot.items, declaration?.required === true);
        }
      }
    };
    visit(region.zone.items, false);
  }
  return result;
};
