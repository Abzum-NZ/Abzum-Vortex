import "server-only";

import { describeFailure, sameId, type JsonValue, type RecordsTableBoardMode } from "../../schema";
import { projectBoardPlacement } from "../board-query";
import { logPlacementFailure, type PlacementReadEntry } from "./shared";
import type { PlacementReadInput } from "./types";

/**
 * A Records table placement in Board mode: its columns for its resolved inputs, or the next page of
 * one column.
 */
export const readBoard = async (
  read: PlacementReadInput,
  placement: PlacementReadEntry,
  board: RecordsTableBoardMode,
  inputValues: Readonly<Record<string, JsonValue>>,
): Promise<void> => {
  const { placementId } = placement;
  const continuation =
    read.boardContinuation !== undefined && sameId(read.boardContinuation.placementId, placementId)
      ? read.boardContinuation.request
      : undefined;
  const projection = await projectBoardPlacement({
    context: read.context,
    session: read.session,
    selection: read.selection,
    placement: placement.item as unknown as Parameters<
      typeof projectBoardPlacement
    >[0]["placement"],
    inputValues,
    queries: read.services.queries,
    board,
    ...(continuation === undefined ? {} : { continuation }),
  });
  if (projection.outcome === "ready") {
    try {
      read.data[placementId] = read.services.boardData(projection.values);
    } catch (error) {
      logPlacementFailure(
        read.address,
        placementId,
        "board_payload_invalid",
        describeFailure(error),
      );
      read.data[placementId] = { status: "error" };
    }
    return;
  }
  logPlacementFailure(read.address, placementId, projection.cause, projection.detail);
  read.data[placementId] =
    projection.outcome === "unavailable"
      ? { status: "error" }
      : { status: "refused", reason: "not_permitted" };
};
