import "server-only";

import type { JsonValue } from "../../schema";
import { QUERY_NOTICE_BLOCK_RELEASE } from "../../definition/index";
import { placementReleaseVersion, placementSettingsOf, type PlacementReadEntry } from "./shared";
import type { PlacementReadInput } from "./types";

/** A query notice placement: the notices its bound query returns for its resolved inputs. */
export const readQueryNotice = async (
  read: PlacementReadInput,
  placement: PlacementReadEntry,
  queryId: string,
  inputValues: Readonly<Record<string, JsonValue>>,
): Promise<void> => {
  if (placementReleaseVersion(placement) !== QUERY_NOTICE_BLOCK_RELEASE.releaseVersion) {
    read.data[placement.placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }
  read.data[placement.placementId] = await read.services.queryNotices.resolve(
    read.session,
    read.selection,
    read.context,
    queryId,
    placementSettingsOf(placement),
    inputValues,
  );
};
