import "server-only";

import type { JsonValue } from "../../schema";
import { placementSettingsOf, type PlacementReadEntry } from "./shared";
import type { PlacementReadInput } from "./types";

/** A link tiles placement: the tiles its bound query returns for its resolved inputs. */
export const readLinkTiles = async (
  read: PlacementReadInput,
  placement: PlacementReadEntry,
  queryId: string,
  inputValues: Readonly<Record<string, JsonValue>>,
): Promise<void> => {
  const result = await read.services.linkTiles.resolve(
    read.session,
    read.selection,
    read.context,
    queryId,
    placementSettingsOf(placement),
    inputValues,
  );
  read.data[placement.placementId] =
    result.status === "ready" && result.values.rows.length === 0 ? { status: "empty" } : result;
};
