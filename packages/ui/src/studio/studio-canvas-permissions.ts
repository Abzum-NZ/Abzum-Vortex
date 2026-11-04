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
  PUBLISHED_PAGE_ADD_REASON,
  publishedPage,
  removalRule,
  regions,
  slotDeclaration,
  releaseFor,
  type Region,
} from "./application-composition-regions";
import { studioLayoutOutletPlacementUses } from "./application-layout-outlets";
import {
  studioPlacementReferenceSentence,
  studioPlacementRemovalReferences,
  type StudioPlacementReference,
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

/** The reason is read by the action bar and by the canvas's removal guard. */
export const studioCanvasPermissionReason = (
  references: StudioCanvasReferences,
  alias: string,
  action: StudioCanvasAction,
): string | undefined => references[alias]?.[action];

/** What still refers to a block, other than blocks that leave with it: query inputs and message targets. */
const studioPlacementReferrers = (
  source: ApplicationSourceDocument,
  alias: string,
  leaving: ReadonlySet<string>,
) =>
  [
    ...applicationUses(source, { kind: "placement", placementAlias: alias }),
    ...applicationUses(source, { kind: "message_target", placementAlias: alias }),
  ].filter((place) => place.open.kind !== "placement" || !leaving.has(place.open.placementAlias));

const studioPlacementUsersSentence = (users: string): string =>
  `This block is used by ${users}. Change that reference first.`;

/**
 * Why a block cannot be duplicated, or undefined: a form, or a block holding a field input, because
 * its field inputs cannot be copied. The one rule for the bar's and the Outline's Duplicate and
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

/** Why a block cannot be removed from where it sits, by `removalRule`. */
const REMOVAL_RULE_REASONS = {
  page_kind:
    "Blocks can only be removed from a layout or from the content of a list, detail, form or dashboard page.",
  public_page: "This page is published at a public address, so its blocks can't be removed.",
  repeating_slot: "This block sits in a repeating area and can't be removed here.",
} as const;

const REQUIRED_SLOT_REASON = "This block fills a required slot.";

/**
 * Why a block cannot be removed or moved because it holds a layout's content outlet (the outlet
 * reserves it or a block inside it), or undefined. It names the outlets themselves, not every page
 * bound to them, and covers the block's subtree, so it is asked of the top block only.
 */
const studioOutletHostRefusal = (
  source: ApplicationSourceDocument,
  alias: string,
): string | undefined => {
  const outlets = studioLayoutOutletPlacementUses(source, alias).filter(
    (place) => place.open.kind === "shell",
  );
  return outlets.length === 0
    ? undefined
    : `This block holds ${describeApplicationUsers(outlets)}. Retarget the outlet first.`;
};

/** The release a block uses, as the draft's block dependencies name it. */
export const releaseKey = (block: { block_id: string; release_version: string }): string =>
  `${block.block_id}@${block.release_version}`;

/**
 * What a removal reads from the whole application, built once per source: every block name and how
 * many blocks there are (more than names when one name is used twice), how many blocks use each
 * release, the flow steps that name a block, the layout outlets a block holds, and the forms of a
 * content area (read only for an area that holds a form, and once per area).
 */
export type StudioRemovalIndex = Readonly<{
  aliases: ReadonlySet<string>;
  placed: number;
  releaseUses: ReadonlyMap<string, number>;
  /** The sentence for a block that holds a layout outlet, or undefined; read once per block. */
  host: (alias: string) => string | undefined;
  flowReference: (alias: string) => StudioPlacementReference | undefined;
  /** Keyed by the area's `zone.items`: separate `regions()` calls share it, not the region. */
  forms: (region: Region) => ReturnType<typeof studioRegionForms> | undefined;
}>;

export const studioRemovalIndex = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
): StudioRemovalIndex => {
  const aliases = new Set<string>();
  const releaseUses = new Map<string, number>();
  let placed = 0;
  for (const region of regions(source))
    for (const item of sourceItemTree(region.zone.items)) {
      placed += 1;
      aliases.add(item.props.id);
      const key = releaseKey(item.props.vortex.block);
      releaseUses.set(key, (releaseUses.get(key) ?? 0) + 1);
    }
  const hosts = new Map<string, string | null>();
  const read = new WeakMap<readonly SourceItem[], ReturnType<typeof studioRegionForms> | null>();
  return {
    aliases,
    placed,
    releaseUses,
    host: (alias) => {
      let held = hosts.get(alias);
      if (held === undefined) held = studioOutletHostRefusal(source, alias) ?? null;
      hosts.set(alias, held);
      return held ?? undefined;
    },
    // The flows are scanned once for every block, not once per block.
    flowReference: studioPlacementRemovalReferences(source, aliases),
    forms: (region) => {
      const items = region.zone.items;
      let held = read.get(items);
      if (held === undefined) {
        held = holdsForm(catalogue, items) ? studioRegionForms(catalogue, items) : null;
        read.set(items, held);
      }
      return held ?? undefined;
    },
  };
};

/**
 * Why one removed block, with everything inside it (`removed`), cannot leave the place it is in,
 * or undefined. The one place a removal sentence is made, with one order of checks for the action
 * bar, the Delete key, the Outline, the canvas reasons, the canvas change and the agent: the
 * removal rule (page kind, public address, repeating area), a layout outlet the block holds, a
 * required slot it fills, a flow step that names it (it says which step), the queries and
 * messages that use it, and a form that would lose an input it needs.
 */
export const studioRemovalRefusalAt = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
  place: Readonly<{
    region: Region;
    /** The removed block that is not inside another removed block. */
    alias: string;
    repeating: boolean;
    /** Whether the slot the block sits in must keep a block. */
    required: boolean;
    siblings: readonly SourceItem[];
  }>,
  removed: ReadonlySet<string>,
  index: StudioRemovalIndex,
): string | undefined => {
  const rule = removalRule(regionRemovalCause(source, place.region), place.repeating);
  if (rule !== undefined) return REMOVAL_RULE_REASONS[rule];
  const host = index.host(place.alias);
  if (host !== undefined) return host;
  if (place.required && place.siblings.every((sibling) => removed.has(sibling.props.id)))
    return REQUIRED_SLOT_REASON;
  for (const alias of removed) {
    const flow = index.flowReference(alias);
    if (flow !== undefined) return studioPlacementReferenceSentence(flow);
  }
  const users = [...removed].flatMap((alias) => studioPlacementReferrers(source, alias, removed));
  if (users.length > 0) return studioPlacementUsersSentence(describeApplicationUsers(users));
  const forms = index.forms(place.region);
  const broken =
    forms === undefined ? undefined : studioRemovalFormRefusal(catalogue, source, forms, removed);
  return broken === undefined
    ? undefined
    : studioFormChangeRefusalSentence(broken, studioPlacementReferenceSentence);
};

/**
 * Why the blocks in `removed` cannot leave the application as it is, or undefined. For a change
 * that carries a removal (the canvas change): one walk finds the place of each removed block that
 * is not inside another removed block, so a block the references do not know yet (just restored,
 * copied or added) is held too. A removed block is not entered.
 */
export const studioRemovalRefusal = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
  removed: ReadonlySet<string>,
  index: StudioRemovalIndex = studioRemovalIndex(catalogue, source),
): string | undefined => {
  for (const region of regions(source)) {
    const visit = (
      items: readonly SourceItem[],
      required: boolean,
      repeating: boolean,
    ): string | undefined => {
      for (const item of items) {
        if (removed.has(item.props.id)) {
          const refusal = studioRemovalRefusalAt(
            catalogue,
            source,
            { region, alias: item.props.id, repeating, required, siblings: items },
            removed,
            index,
          );
          if (refusal !== undefined) return refusal;
          continue;
        }
        const release = releaseFor(catalogue, item);
        for (const [key, slot] of itemSlots(catalogue, item)) {
          const declaration = slotDeclaration(release, key);
          const found = visit(
            slot.items,
            declaration?.required === true,
            repeating || declaration?.repeats !== undefined,
          );
          if (found !== undefined) return found;
        }
      }
      return undefined;
    };
    const found = visit(region.zone.items, false, false);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** Build the references once for a draft; the values are plain metadata. */
export const studioCanvasReferences = (
  source: ApplicationSourceDocument,
  catalogue: ImmutablePlatformBlockCatalogue,
): StudioCanvasReferences => {
  const index = studioRemovalIndex(catalogue, source);
  const result: Record<string, Partial<Record<StudioCanvasAction, string>>> = {};
  for (const region of regions(source)) {
    const published =
      region.shell === undefined && region.page !== undefined && publishedPage(source, region.page);
    const visit = (items: readonly SourceItem[], required: boolean, repeating: boolean) => {
      for (const item of items) {
        const id = item.props.id;
        const descendants = sourceItemTree([item]);
        const removed = new Set(descendants.map((child) => child.props.id));
        const reasons: Partial<Record<StudioCanvasAction, string>> = {};
        const release = releaseFor(catalogue, item);
        const duplicate = studioDuplicateRefusal(catalogue, item, descendants);
        if (duplicate !== undefined) reasons.duplicate = duplicate;
        else if (published) reasons.duplicate = PUBLISHED_PAGE_ADD_REASON;
        const host = index.host(id);
        if (host !== undefined) reasons.drag = host;
        const refusal = studioRemovalRefusalAt(
          catalogue,
          source,
          { region, alias: id, repeating, required, siblings: items },
          removed,
          index,
        );
        if (refusal !== undefined) reasons.delete = refusal;
        result[id] = reasons;
        for (const [key, slot] of itemSlots(catalogue, item)) {
          const declaration = slotDeclaration(release, key);
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
