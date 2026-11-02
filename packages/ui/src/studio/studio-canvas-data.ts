import type { Data, UiState } from "@puckeditor/core";
import {
  canonicalJson,
  compiledItemSlots,
  readRecordDetailContract,
  readSourceItem,
  releaseSettingDeclarations,
  storedItemRelease,
  validateStoredZone,
  type CompiledItem,
  type ImmutablePlatformBlockCatalogue,
  type SourceItem,
  type SourcePageZone,
} from "@vortex/platform/schema";
import type { StudioCompositionDestination } from "./application-composition-commands";

/** One compiled content area: its items, exactly as the published definition holds them. */
export type StudioCanvasCompiledSlot = readonly CompiledItem[];
export type StudioCanvasSourceSlot = SourcePageZone;
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

/** Puck's name of the root zone, which holds a page's top-level blocks. */
const ROOT_ZONE = "root:default-zone";

/** Puck's name of the zone a place for a new block is: its root zone, or `<block name>:<slot key>`. */
export const zoneOfDestination = (destination: StudioCompositionDestination): string =>
  destination.kind === "root" ? ROOT_ZONE : `${destination.parentAlias}:${destination.slotKey}`;

/** The place for a new block that a Puck zone is: the inverse of `zoneOfDestination`. */
export const destinationOfZone = (zone: string): StudioCompositionDestination => {
  if (zone === ROOT_ZONE) return { kind: "root" };
  const separator = zone.lastIndexOf(":");
  return {
    kind: "child",
    parentAlias: zone.slice(0, separator),
    slotKey: zone.slice(separator + 1),
  };
};

/** Whether Puck items hold the block named `alias`, at any depth. */
export const puckItemsHold = (items: readonly unknown[], alias: string): boolean =>
  findPuckItem(items, alias) !== undefined;

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

/** The block name Puck's item selector points at in its data, or `null` when it points at no block. */
export const puckSelectedAlias = (
  content: readonly unknown[],
  selector: StudioPuckSelector | null | undefined,
): string | null => {
  if (selector === null || selector === undefined) return null;
  const zone = selector.zone ?? ROOT_ZONE;
  let items: readonly unknown[] | undefined = content;
  if (zone !== ROOT_ZONE) {
    const separator = zone.lastIndexOf(":");
    const holder = findPuckItem(content, zone.slice(0, separator));
    const slot = holder?.[zone.slice(separator + 1)];
    items = Array.isArray(slot) ? slot : undefined;
  }
  const item = items?.[selector.index];
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
export const zoneJson = (zone: StudioCanvasSourceSlot): string =>
  canonicalJson(JSON.parse(JSON.stringify(zone)) as unknown);

/**
 * Why a content area is not editable on the canvas: its stored data does not pass the stored
 * composition check, or its compiled version does not match it. Such a content area is shown
 * read-only rather than risking a silent change to the definition.
 */
export const storedDataProblem = (
  catalogue: ImmutablePlatformBlockCatalogue,
  slot: StudioCanvasSourceSlot,
): string | undefined => {
  try {
    const checked = validateStoredZone(catalogue, slot);
    return zoneJson(checked) === zoneJson(slot)
      ? undefined
      : "STUDIO_CANVAS_STORED_DATA_MISMATCH: the stored content reads back differently";
  } catch (error: unknown) {
    return `STUDIO_CANVAS_STORED_DATA_REFUSED: ${error instanceof Error ? error.message : String(error)}`;
  }
};
