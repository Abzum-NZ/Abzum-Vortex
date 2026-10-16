import { isRecord } from "../catalogue/runtime-primitives";
import { compiledPropsSettings } from "../definition/application-composition/page-composition";

/** One compiled item met while walking a projected layout: its placement identity and props. */
export type VisitedPlacement = Readonly<{
  placementId: string;
  /** The item itself: `{ type, props }`. */
  item: Record<string, unknown>;
  /** The item's Puck props: `id`, `vortex`, its settings and its child slots. */
  props: Record<string, unknown>;
  /** The item's `props.vortex`: block release, bindings, layout and slot orders. */
  vortex: Record<string, unknown>;
  /** The item's settings: every prop holding a typed canonical setting value. */
  settings: Record<string, unknown>;
}>;

/**
 * Receives each placement with the value its parent returned. Return the value the placement's
 * child slots inherit, or `false` to skip them.
 */
export type PlacementVisitor<Inherited> = (
  visited: VisitedPlacement,
  inherited: Inherited,
) => Inherited | false;

const reservedProps = new Set(["id", "vortex"]);

/** The child slots of one item's props: every array prop but `id` and `vortex`. */
export const itemPropSlots = (props: Record<string, unknown>): [string, unknown[]][] =>
  Object.entries(props).flatMap(([key, value]): [string, unknown[]][] =>
    reservedProps.has(key) || !Array.isArray(value) ? [] : [[key, value]],
  );

/**
 * Visits every item of one item list, in desktop order, descending through each item's slots.
 * Entries that are not items are skipped.
 */
export const walkPlacements = <Inherited = undefined>(
  items: unknown,
  visit: PlacementVisitor<Inherited>,
  inherited?: Inherited,
): void => {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!isRecord(item) || !isRecord(item.props)) continue;
    const props = item.props;
    const vortex = isRecord(props.vortex) ? props.vortex : {};
    const next = visit(
      {
        placementId: String(props.id),
        item,
        props,
        vortex,
        settings: compiledPropsSettings(props),
      },
      inherited as Inherited,
    );
    if (next === false) continue;
    for (const [, child] of itemPropSlots(props)) walkPlacements(child, visit, next);
  }
};

/** Visits every item of one Puck data tree: its root slots, then its content. */
export const walkPlacementData = <Inherited = undefined>(
  data: unknown,
  visit: PlacementVisitor<Inherited>,
  inherited?: Inherited,
): void => {
  if (!isRecord(data)) return;
  const rootProps = isRecord(data.root) && isRecord(data.root.props) ? data.root.props : {};
  for (const [key, value] of Object.entries(rootProps))
    if (key !== "vortex") walkPlacements(value, visit, inherited);
  walkPlacements(data.content, visit, inherited);
};

/** Walks the placements of a page composition: its one data, or every step's data. */
export const walkPageComposition = <Inherited = undefined>(
  composition: unknown,
  visit: PlacementVisitor<Inherited>,
  inherited?: Inherited,
): void => {
  if (!isRecord(composition)) return;
  if (isRecord(composition.stepContent))
    for (const data of Object.values(composition.stepContent))
      walkPlacementData(data, visit, inherited);
  else walkPlacementData(composition, visit, inherited);
};
