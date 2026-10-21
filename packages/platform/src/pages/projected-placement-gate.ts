import { sameId } from "../schema";
import { projectedUseAvailability } from "./placement-read/shared";
import { walkPageComposition, type VisitedPlacement } from "./placement-walk";

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
 * visibility condition or a permission removed for them, is refused. The caller logs the reason; the
 * client only learns that the request is refused.
 */
export const requireProjectedPlacement = (
  projectedPage: Readonly<Record<string, unknown>>,
  placementId: string,
): ProjectedPlacementGate => {
  const found: VisitedPlacement[] = [];
  walkPageComposition(projectedPage.composition, (visited) => {
    if (sameId(visited.placementId, placementId)) found.push(visited);
    return undefined;
  });
  const placement = found.length === 1 ? found[0] : undefined;
  if (placement === undefined) return { kind: "refused", reason: "placement_not_on_page" };
  if (projectedUseAvailability(placement) !== "available")
    return { kind: "refused", reason: "placement_not_usable" };
  return { kind: "on_page", placement };
};
