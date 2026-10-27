import type { AnyPageComposition, CompiledItem, PageComposition } from "./page-composition";

/*
 * Walking a compiled page: its items, slots, zones and frame, apart from the page composition
 * contracts, so the renderer walks a page without loading those contracts.
 */

/** The props of an item that are neither settings nor child slots. */
export const compiledItemReservedProps: ReadonlySet<string> = new Set(["id", "vortex"]);

/**
 * The item's child slots: exactly the slots its compiled metadata orders, in that order. The
 * compiler orders every slot it fills from the release's slot declarations, so no prop is taken
 * for a slot by its shape; an empty list setting is never a slot.
 */
export const compiledItemSlots = (item: CompiledItem): [string, CompiledItem[]][] =>
  Object.keys(item.props.vortex.slotOrders).map((key): [string, CompiledItem[]] => [
    key,
    item.props[key] as CompiledItem[],
  ]);

/** Every item in the list and their descendants, depth first in desktop order. */
export const compiledItemTree = (
  items: readonly CompiledItem[],
  result: CompiledItem[] = [],
): CompiledItem[] => {
  for (const item of items) {
    result.push(item);
    for (const [, children] of compiledItemSlots(item)) compiledItemTree(children, result);
  }
  return result;
};

/** The compiled root zone of a layout. */
export const compiledRootZone = "content";

/** The root slots of compiled page data: every root prop but `vortex`. */
export const compiledPageRootSlots = (data: PageComposition): [string, CompiledItem[]][] =>
  Object.entries(data.root.props).flatMap(([key, value]): [string, CompiledItem[]][] =>
    key === "vortex" ? [] : [[key, value as CompiledItem[]]],
  );

/** Every zone of compiled page data with its items: `content` in the default frame, else root slots. */
export const compiledPageZones = (data: PageComposition): [string, CompiledItem[]][] =>
  data.root.props.vortex.shellId === null
    ? [[compiledRootZone, data.content]]
    : compiledPageRootSlots(data);

/** The compiled Puck data of every step of a guided form, or the page's one data otherwise. */
export const compiledPageDataOf = (composition: AnyPageComposition): PageComposition[] =>
  "stepContent" in composition ? Object.values(composition.stepContent) : [composition];

/** The application shell a page's frame uses, or null for the platform default frame. */
export const compiledPageShellId = (composition: AnyPageComposition): string | null =>
  compiledPageDataOf(composition)[0]?.root.props.vortex.shellId ?? null;

/** Every item a page places, in every step and zone, depth first. */
export const compiledPageItems = (composition: AnyPageComposition): CompiledItem[] =>
  compiledPageDataOf(composition).flatMap((data) =>
    compiledPageZones(data).flatMap(([, items]) => compiledItemTree(items)),
  );
