import { isRecord } from "../catalogue/runtime-primitives";

/** One authored placement met while walking a projected slot tree. */
export type VisitedPlacement = Readonly<{
  placementId: string;
  placement: Record<string, unknown>;
}>;

/**
 * Receives each placement with the value its parent returned. Return the value the placement's
 * child slots inherit, or `false` to skip them.
 */
export type PlacementVisitor<Inherited> = (
  visited: VisitedPlacement,
  inherited: Inherited,
) => Inherited | false;

/**
 * Visits every placement below a projected slot, in document order, descending through each
 * placement's slots. A value that is not a slot but holds slots (such as the step content map) is
 * walked through its values. Entries that are not records are not placements and are skipped.
 */
export const walkPlacements = <Inherited = undefined>(
  slot: unknown,
  visit: PlacementVisitor<Inherited>,
  inherited?: Inherited,
): void => {
  if (!isRecord(slot)) return;
  if (!isRecord(slot.placements)) {
    for (const child of Object.values(slot)) walkPlacements(child, visit, inherited);
    return;
  }
  for (const [placementId, placement] of Object.entries(slot.placements)) {
    if (!isRecord(placement)) continue;
    const next = visit({ placementId, placement }, inherited as Inherited);
    if (next === false || !isRecord(placement.slots)) continue;
    for (const child of Object.values(placement.slots)) walkPlacements(child, visit, next);
  }
};

/** Walks the placements of a projected page composition: its main slot, else every step's content. */
export const walkPageComposition = <Inherited = undefined>(
  composition: unknown,
  visit: PlacementVisitor<Inherited>,
  inherited?: Inherited,
): void => {
  if (!isRecord(composition)) return;
  if ("main" in composition) walkPlacements(composition.main, visit, inherited);
  else if (isRecord(composition.stepContent))
    for (const root of Object.values(composition.stepContent))
      walkPlacements(root, visit, inherited);
};
