import { isRecord } from "../catalogue/runtime-primitives";
import { sameId } from "../catalogue/runtime-primitives";
import { projectedUseAvailability } from "./placement-read/shared";
import { walkPlacementData, type VisitedPlacement } from "./placement-walk";

/**
 * Why a placement is not usable on the addressed page: it is not on the page as projected for the
 * person now (absent, hidden from them, or named more than once), or it is on the page but its
 * operation is unavailable to them.
 */
export type ProjectedPlacementRefusal = "placement_not_on_page" | "placement_not_usable";

export type ProjectedPlacementGate =
  | Readonly<{ kind: "on_page"; placement: VisitedPlacement }>
  | Readonly<{ kind: "refused"; reason: ProjectedPlacementRefusal }>;

/**
 * The one gate between a request that names a placement (a Records table, a form, a button) and the
 * page it claims to be on: the placement must be on the projected page exactly once and usable by
 * the person now. The projection is the person's own, so a control another page carries, or one a
 * visibility condition or a permission removed for them, is refused. On a guided page each step is
 * one layout: a shell placement repeats in every step, so it must be in some step and at most once
 * in each. The caller logs the reason; the client only learns that the request is refused.
 */
export const requireProjectedPlacement = (
  projectedPage: Readonly<Record<string, unknown>>,
  placementId: string,
): ProjectedPlacementGate => {
  const composition = projectedPage.composition;
  const layouts =
    isRecord(composition) && isRecord(composition.stepContent)
      ? Object.values(composition.stepContent)
      : [composition];
  let placement: VisitedPlacement | undefined;
  for (const layout of layouts) {
    const found: VisitedPlacement[] = [];
    walkPlacementData(layout, (visited) => {
      if (sameId(visited.placementId, placementId)) found.push(visited);
      return undefined;
    });
    if (found.length > 1) return { kind: "refused", reason: "placement_not_on_page" };
    placement ??= found[0];
  }
  if (placement === undefined) return { kind: "refused", reason: "placement_not_on_page" };
  if (projectedUseAvailability(placement) !== "available")
    return { kind: "refused", reason: "placement_not_usable" };
  return { kind: "on_page", placement };
};
