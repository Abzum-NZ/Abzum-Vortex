import { logPlacementFailure, runtimeDatabasePoolSize } from "@vortex/platform/server";
import { describeFailure } from "@vortex/platform/schema";
import type { collectPlacements } from "./placement-helpers";
import { readPlacement, type PlacementReaderInput } from "./placement-reader";
import type { ApplicationPageLoaderAddress, PageDataState } from "./types";

/**
 * Starts the reads of the placements a page streams, each limited by the request pool so they
 * never starve the page's own reads, and marks each as loading in `data` until its read settles.
 * A failed read shows its placement's error state and is logged with its cause; it never fails
 * the page or goes unobserved.
 */
export const startStreamedPlacementReads = (
  input: Readonly<{
    streamed: readonly ReturnType<typeof collectPlacements>[number][];
    placementReaderInput: PlacementReaderInput;
    address: ApplicationPageLoaderAddress;
    data: Record<string, PageDataState>;
  }>,
): Record<string, Promise<PageDataState>> => {
  const { streamed, placementReaderInput, address, data } = input;
  const streamedData: Record<string, Promise<PageDataState>> = {};
  const streamedSlots = new Array<() => void>();
  const streamedLimit = runtimeDatabasePoolSize();
  let streamedRunning = 0;
  const nextStreamedSlot = (): Promise<void> =>
    streamedRunning < streamedLimit
      ? ((streamedRunning += 1), Promise.resolve())
      : new Promise<void>((resolve) => streamedSlots.push(resolve));
  const releaseStreamedSlot = (): void => {
    const next = streamedSlots.shift();
    if (next === undefined) streamedRunning -= 1;
    else next();
  };
  for (const entry of streamed) {
    const own: Record<string, PageDataState> = {};
    streamedData[entry.placementId] = nextStreamedSlot()
      .then(() => readPlacement({ ...placementReaderInput, data: own }, entry))
      .then(() => {
        const state = own[entry.placementId];
        if (state === undefined) throw new Error("PLACEMENT_DATA_NOT_PRODUCED");
        return state;
      })
      .catch((error: unknown): PageDataState => {
        logPlacementFailure(
          address,
          entry.placementId,
          "placement_read_failed",
          describeFailure(error),
        );
        // A defect in data the platform produced is surfaced in development; production degrades
        // to the placement's error state.
        if (process.env.NODE_ENV !== "production") throw error;
        return { status: "error" };
      })
      .finally(releaseStreamedSlot);
    data[entry.placementId] = { status: "loading" };
  }
  return streamedData;
};
