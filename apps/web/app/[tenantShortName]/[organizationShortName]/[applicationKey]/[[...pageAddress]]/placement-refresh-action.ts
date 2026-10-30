"use server";

import { rereadApplicationPlacements as readPlacements } from "../../../../_lib/placement-refresh";
import type { ApplicationPagePlacementReadResult } from "../../../../_lib/application-page";

/** Re-reads named placements for refresh and continuation events. */
export async function rereadApplicationPlacements(
  addressInput: unknown,
  placementIdsInput: unknown,
  boardReadsInput?: unknown,
  tableContinuationInput?: unknown,
  includeContentInput?: unknown,
): Promise<ApplicationPagePlacementReadResult> {
  return readPlacements(
    addressInput,
    placementIdsInput,
    boardReadsInput,
    tableContinuationInput,
    includeContentInput,
  );
}
