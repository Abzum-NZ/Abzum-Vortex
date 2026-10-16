import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "./definition-error";

/**
 * The fixed availability state a permission projection may attach to a placement. A placement is
 * either plainly available, or marked unavailable for the one operation-unavailable reason; any
 * other combination is refused so a projection can never invent a state.
 */
export const projectedAvailability = (
  placement: Readonly<Record<string, unknown>>,
  location: DefinitionRenderErrorLocation,
): Readonly<{
  availability: "available" | "unavailable";
  unavailableReason?: "operation_unavailable";
}> => {
  const hasAvailability = "availability" in placement;
  const hasReason = "unavailableReason" in placement;
  if (!hasAvailability && !hasReason) return { availability: "available" };
  if (
    !hasAvailability ||
    placement.availability !== "unavailable" ||
    !hasReason ||
    placement.unavailableReason !== "operation_unavailable"
  ) {
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "Projected placement availability must use the fixed operation-unavailable state",
      location,
    );
  }
  return { availability: "unavailable", unavailableReason: "operation_unavailable" };
};
