import type { Data, UiState } from "@puckeditor/core";
import {
  canonicalJson,
  compiledItemSlots,
  readRecordDetailContract,
  readSourceItem,
  releaseSettingDeclarations,
  sourcePageZones,
  storedItemRelease,
  validateStoredZone,
  type CompiledItem,
  type ImmutablePlatformBlockCatalogue,
  type SourceItem,
  type SourcePageData,
  type SourcePageZone,
} from "@vortex/platform/schema";
import type { StudioCompositionDestination } from "./application-composition-commands";

/** One compiled zone of the page (a content slot, or the default zone): its items, exactly as the published definition holds them. */
export type StudioCanvasCompiledSlot = readonly CompiledItem[];
type StudioCanvasSourceSlot = SourcePageZone;
export type StudioCanvasCompiledSettings = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

/**
 * What a block's records depend on, by block name, at any depth: its release, its typed settings
 * and the query it reads. Records read for one spelling are shown only while the block still has it.
 */
export const recordKeys = (
  catalogue: ImmutablePlatformBlockCatalogue,
  items: readonly SourceItem[],
): Map<string, string> => {
  const keys = new Map<string, string>();
  const visit = (list: readonly SourceItem[]): void => {
    for (const item of list) {
      const release = storedItemRelease(catalogue, item);
      if (release === undefined) continue;
      const reading = readSourceItem(item, release);
      if (
        item.props.vortex.query !== undefined ||
        readRecordDetailContract(reading.settings) !== undefined
      )
        keys.set(
          item.props.id,
          canonicalJson([
            item.props.vortex.block,
            item.props.vortex.query ?? null,
            reading.settings,
          ]),
        );
      for (const [, slot] of reading.slots) if (slot.items !== undefined) visit(slot.items);
    }
  };
  visit(items);
  return keys;
};

/**
 * The settings of each block's last compiled version, by block name. The compiled slot holds the
 * compiled version of the same stored items, in the same desktop order and with the same slots,
 * so each stored item reads its compiled item at the same position.
 */
export const compiledSettingsFor = (
  catalogue: ImmutablePlatformBlockCatalogue,
  stored: readonly SourceItem[],
  compiled: StudioCanvasCompiledSlot,
): StudioCanvasCompiledSettings => {
  const result: Record<string, Readonly<Record<string, unknown>>> = {};
  const visit = (items: readonly SourceItem[], compiledItems: readonly CompiledItem[]): void => {
    if (items.length !== compiledItems.length)
      throw new TypeError("Compiled page placements do not match their stored page.");
    for (const [index, item] of items.entries()) {
      const compiledItem = compiledItems[index]!;
      const release = storedItemRelease(catalogue, item);
      if (release === undefined || item.type !== compiledItem.type)
        throw new TypeError("Compiled page placements do not match their stored page.");
      // Its settings are the props its release declares, as their plain values.
      result[item.props.id] = Object.fromEntries(
        releaseSettingDeclarations(release).flatMap((property) =>
          Object.hasOwn(compiledItem.props, property.key)
            ? [[property.key, compiledItem.props[property.key]]]
            : [],
        ),
      );
      const compiledSlots = new Map(compiledItemSlots(compiledItem));
      for (const [key, { items: children }] of readSourceItem(item, release).slots) {
        if (children === undefined) continue;
        const compiledChildren = compiledSlots.get(key);
        if (compiledChildren === undefined)
          throw new TypeError("Compiled page slots do not match their stored page.");
        visit(children, compiledChildren);
      }
    }
  };
  visit(stored, compiled);
  return result;
};

const isItemList = (value: unknown): value is SourceItem[] =>
  Array.isArray(value) &&
  value.every(
    (entry) => entry !== null && typeof entry === "object" && "type" in entry && "props" in entry,
  );

/** Whether a block named `alias` is in the items, at any depth. */
export const itemsHold = (items: readonly SourceItem[], alias: string): boolean =>
  items.some(
    (item) =>
      item.props.id === alias ||
      Object.values(item.props).some((value) => isItemList(value) && itemsHold(value, alias)),
  );

/** Where Puck says a block sits: its zone and its index in it. */
export type StudioPuckSelector = NonNullable<UiState["itemSelector"]>;

/** Puck's name of the page's default zone, which holds the blocks of a page in the default frame. */
const ROOT_ZONE = "root:default-zone";

/** Puck's name of the zone of a root slot, which holds the blocks of one content slot of the shell. */
const rootSlotZone = (slot: string): string => `root:${slot}`;

/** The root slot a Puck zone is, or `undefined` for the default zone and a block's slot. */
const slotOfZone = (zone: string): string | undefined =>
  zone !== ROOT_ZONE && zone.startsWith("root:") ? zone.slice("root:".length) : undefined;

/** Whether a Puck zone holds top-level blocks of the page: the default zone or a root slot. */
const isTopZone = (zone: string): boolean => zone === ROOT_ZONE || zone.startsWith("root:");

/** Every top-level zone of Puck's data with its blocks: the default zone, then each root slot. */
const topZones = (data: Data): readonly (readonly [string, readonly unknown[]])[] => [
  [ROOT_ZONE, data.content],
  ...Object.entries((data.root as { props?: Record<string, unknown> }).props ?? {}).flatMap(
    ([key, value]): [string, readonly unknown[]][] =>
      key !== "vortex" && Array.isArray(value) ? [[rootSlotZone(key), value]] : [],
  ),
];

/**
 * Puck's name of the zone a place for a new block is: the page's default zone, a root slot (the
 * shell content slot named `slot`), or `<block name>:<slot key>`.
 */
export const zoneOfDestination = (
  destination: StudioCompositionDestination,
  slot?: string,
): string =>
  destination.kind === "root"
    ? slot === undefined
      ? ROOT_ZONE
      : rootSlotZone(slot)
    : `${destination.parentAlias}:${destination.slotKey}`;

/** The place for a new block that a Puck zone is: the inverse of `zoneOfDestination`. */
export const destinationOfZone = (zone: string): StudioCompositionDestination => {
  if (isTopZone(zone)) return { kind: "root" };
  const separator = zone.lastIndexOf(":");
  return {
    kind: "child",
    parentAlias: zone.slice(0, separator),
    slotKey: zone.slice(separator + 1),
  };
};

/**
 * The root slot whose blocks hold the zone: the zone itself when it is a root slot, the slot of the
 * block that holds a block's slot, or `undefined` when the page's default zone holds it.
 */
export const rootSlotHolding = (data: Data, zone: string): string | undefined => {
  if (isTopZone(zone)) return slotOfZone(zone);
  const holder = zone.slice(0, zone.lastIndexOf(":"));
  const top = topZones(data).find(([, items]) => findPuckItem(items, holder) !== undefined);
  return top === undefined ? undefined : slotOfZone(top[0]);
};

/** Whether Puck's data holds the block named `alias`, at any depth. */
export const puckItemsHold = (data: Data, alias: string): boolean =>
  topZones(data).some(([, items]) => findPuckItem(items, alias) !== undefined);

/** The block named `alias` among Puck items, at any depth. */
const findPuckItem = (
  items: readonly unknown[],
  alias: string,
): Record<string, unknown> | undefined => {
  for (const entry of items) {
    if (entry === null || typeof entry !== "object") continue;
    const props = (entry as { props?: Record<string, unknown> }).props;
    if (props === undefined) continue;
    if (props.id === alias) return props;
    for (const value of Object.values(props)) {
      if (!Array.isArray(value)) continue;
      const found = findPuckItem(value, alias);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

/** The block named `alias` anywhere in Puck's data. */
const findInData = (data: Data, alias: string): Record<string, unknown> | undefined => {
  for (const [, items] of topZones(data)) {
    const found = findPuckItem(items, alias);
    if (found !== undefined) return found;
  }
  return undefined;
};

/**
 * Where the block named `alias` sits in Puck's data: read from the data itself, never from Puck's
 * index of it, which can lag behind data that was replaced from outside (an Undo, another page).
 */
export const puckSelectorOf = (
  data: Data,
  alias: string,
): Required<StudioPuckSelector> | undefined => {
  const search = (
    items: readonly unknown[],
    zone: string,
  ): Required<StudioPuckSelector> | undefined => {
    for (const [index, entry] of items.entries()) {
      const props = (entry as { props?: Record<string, unknown> } | null)?.props;
      if (props === undefined) continue;
      if (props.id === alias) return { index, zone };
      for (const [key, value] of Object.entries(props)) {
        if (!Array.isArray(value)) continue;
        const found = search(value, `${String(props.id)}:${key}`);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  for (const [zone, items] of topZones(data)) {
    const found = search(items, zone);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** The items of a Puck zone in its data: a top-level zone of the page or a block's slot. */
const puckZoneItems = (data: Data, zone: string): readonly unknown[] | undefined => {
  const top = topZones(data).find(([name]) => name === zone);
  if (top !== undefined) return top[1];
  if (isTopZone(zone)) return undefined;
  const separator = zone.lastIndexOf(":");
  const slot = findInData(data, zone.slice(0, separator))?.[zone.slice(separator + 1)];
  return Array.isArray(slot) ? slot : undefined;
};

/**
 * The block that takes the selection when the block at `selector` is removed: the next one beside
 * it, else the one before, else the block holding the slot (the page's own zones have none).
 */
export const puckNeighbourOf = (
  data: Data,
  selector: Required<StudioPuckSelector>,
): string | undefined => {
  const items = puckZoneItems(data, selector.zone) ?? [];
  const idOf = (entry: unknown): string | undefined => {
    const id = (entry as { props?: { id?: unknown } } | null)?.props?.id;
    return typeof id === "string" ? id : undefined;
  };
  const beside = idOf(items[selector.index + 1]) ?? idOf(items[selector.index - 1]);
  if (beside !== undefined) return beside;
  return isTopZone(selector.zone)
    ? undefined
    : selector.zone.slice(0, selector.zone.lastIndexOf(":"));
};

/** The block name Puck's item selector points at in its data, or `null` when it points at no block. */
export const puckSelectedAlias = (
  data: Data,
  selector: StudioPuckSelector | null | undefined,
): string | null => {
  if (selector === null || selector === undefined) return null;
  const item = puckZoneItems(data, selector.zone ?? ROOT_ZONE)?.[selector.index];
  const id =
    item !== null && typeof item === "object"
      ? (item as { props?: { id?: unknown } }).props?.id
      : undefined;
  return typeof id === "string" ? id : null;
};

/**
 * Puck's data as Studio's definition check reads it. Puck registers a legacy drop zone for a slot
 * it still draws after the block holding it has left its index (another page shown, or an Undo),
 * and writes it into its data as an empty `zones` entry until that block unmounts. Such an entry
 * holds no block and is Puck's own bookkeeping, so it is not part of the page. A zone that holds
 * blocks is page content Studio does not store, and is left in for the definition check to refuse.
 */
export const withoutEmptyPuckZones = (candidate: Data): Data => {
  const { zones, ...rest } = candidate;
  if (zones === undefined) return candidate;
  const held = Object.entries(zones).filter(
    ([, items]) => !Array.isArray(items) || items.length > 0,
  );
  return held.length === 0 ? rest : { ...rest, zones: Object.fromEntries(held) };
};

/**
 * The canonical form of an authored zone for comparison. A zone with no responsive order carries
 * `order: undefined`, and optional item metadata may be absent; JSON drops both, so equal zones
 * compare equal and canonicalJson never sees an undefined property.
 */
const zoneJson = (zone: StudioCanvasSourceSlot): string =>
  canonicalJson(JSON.parse(JSON.stringify(zone)) as unknown);

/** A page's (or guided step's) data as canonical text, to compare two of them. */
export const pageDataJson = (data: SourcePageData): string =>
  canonicalJson(JSON.parse(JSON.stringify(data)) as unknown);

/**
 * Why a page is not editable on the canvas: the stored data of one of its zones does not pass the
 * stored composition check, or its compiled version does not match it. Such a page is shown
 * read-only rather than risking a silent change to the definition.
 */
export const storedDataProblem = (
  catalogue: ImmutablePlatformBlockCatalogue,
  data: SourcePageData,
): string | undefined => {
  try {
    for (const [key, items] of sourcePageZones(data)) {
      const zone = { items, order: data.root.props.vortex.slot_orders[key] };
      if (zoneJson(validateStoredZone(catalogue, zone)) !== zoneJson(zone))
        return "STUDIO_CANVAS_STORED_DATA_MISMATCH: the stored content reads back differently";
    }
    return undefined;
  } catch (error: unknown) {
    return `STUDIO_CANVAS_STORED_DATA_REFUSED: ${error instanceof Error ? error.message : String(error)}`;
  }
};
