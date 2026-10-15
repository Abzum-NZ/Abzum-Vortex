import { useCallback, useEffect, useRef } from "react";
import {
  encodeTablePagePosition,
  isTablePageParameter,
  parseTablePagePosition,
  tablePageParameterName,
  type TablePageRequest,
} from "../../../../../../_lib/table-page-position";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import type { TableContinuationTarget } from "./types";

/**
 * Keeps each table's page position in the address without a server render: a page change adds a
 * history entry (shallow), and an address that moves to another position (Back, Forward) rereads
 * only that table. The frame stays mounted throughout.
 */
export function useTablePageAddress({
  model,
  currentSearch,
  refreshPlacements,
}: Readonly<{
  model: ApplicationPageModel;
  currentSearch: string;
  refreshPlacements: (
    placementIds: readonly string[],
    tableContinuation?: TableContinuationTarget,
  ) => Promise<void>;
}>) {
  // The positions the shown table data was read for; a new server model starts from its own.
  const shownRef = useRef<{ owner: ApplicationPageModel; positions: Map<string, string> }>({
    owner: model,
    positions: new Map(Object.entries(model.tablePositions)),
  });
  if (shownRef.current.owner !== model)
    shownRef.current = { owner: model, positions: new Map(Object.entries(model.tablePositions)) };

  /** Records a page the table is about to show and adds it to the address. */
  const commitTablePage = useCallback((placementId: string, request: TablePageRequest) => {
    const name = tablePageParameterName(placementId);
    const position = encodeTablePagePosition(request);
    const shown = shownRef.current.positions;
    if (shown.get(name) === position || (position === undefined && !shown.has(name))) return;
    if (position === undefined) shown.delete(name);
    else shown.set(name, position);
    const parameters = new URLSearchParams(window.location.search);
    if (position === undefined) parameters.delete(name);
    else parameters.set(name, position);
    const query = parameters.toString();
    window.history.pushState(null, "", query === "" ? window.location.pathname : `?${query}`);
  }, []);

  useEffect(() => {
    const shown = shownRef.current.positions;
    const parameters = new URLSearchParams(currentSearch);
    const names = new Set([
      ...[...parameters.keys()].filter(isTablePageParameter),
      ...shown.keys(),
    ]);
    for (const name of names) {
      const position = parameters.get(name) ?? undefined;
      if (shown.get(name) === position) continue;
      if (position === undefined) shown.delete(name);
      else shown.set(name, position);
      const placementId = Object.keys(model.data).find(
        (candidate) => tablePageParameterName(candidate).toLowerCase() === name.toLowerCase(),
      );
      if (placementId === undefined) continue;
      void refreshPlacements([placementId], {
        placementId,
        request: parseTablePagePosition(position) ?? { page: 1, pageDirection: "forward" },
      });
    }
  }, [currentSearch, model.data, refreshPlacements]);

  return { commitTablePage };
}
