import { useCallback, useEffect, useRef } from "react";
import { toast } from "@vortex/ui/components/sonner";
import type { DisplaySemanticEvent } from "@vortex/ui";
import { readRecordsTableQueryState, type GridLayoutCommitResult } from "@vortex/platform/schema";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import { commitGridLayout } from "../../grid-layout-action";
import { tablePayloadFor } from "./placement-helpers";
import type { TableContinuationTarget } from "./types";

const UNAVAILABLE: GridLayoutCommitResult = Object.freeze({ outcome: "unavailable" });

/**
 * Stores each data grid's layout for the person. A committed layout gesture is one scoped write and
 * never a route refresh; it reads no records, except that a layout showing a column the page was
 * read without rereads that one grid at its current page, once, after the write. A conflict (a
 * newer layout from another tab) and a failed write are told in a notice. A stored layout the
 * current release can no longer apply is removed once, with a notice saying why.
 */
export function useGridLayout({
  model,
  currentData,
  refreshPlacements,
}: Readonly<{
  model: ApplicationPageModel;
  currentData: ApplicationPageModel["data"];
  refreshPlacements: (
    placementIds: readonly string[],
    tableContinuation?: TableContinuationTarget,
  ) => Promise<void>;
}>) {
  const { tenantShortName, organizationShortName, applicationKey, pageKey } = model.invocation;
  const address = useRef({ tenantShortName, organizationShortName, applicationKey, pageKey });
  address.current = { tenantShortName, organizationShortName, applicationKey, pageKey };

  const commitLayout = useCallback(
    async (placementId: string, event: DisplaySemanticEvent): Promise<GridLayoutCommitResult> => {
      if (event.event !== "columns_changed") return UNAVAILABLE;
      // Nothing stored and nothing to store: the authored layout is already the stored state.
      const result: GridLayoutCommitResult =
        event.layout === null && event.expectedRevision === null
          ? { outcome: "reset" }
          : await commitGridLayout(
              address.current,
              event.layout === null
                ? { kind: "reset", placementId, expectedRevision: event.expectedRevision }
                : {
                    kind: "write",
                    placementId,
                    queryId: event.queryId,
                    expectedRevision: event.expectedRevision,
                    layout: event.layout,
                  },
            ).catch((error: unknown) => {
              console.error("[page] grid layout not stored", error);
              return UNAVAILABLE;
            });
      if (result.outcome === "conflict")
        toast.info("This layout was changed in another tab. The latest layout is shown.");
      if (result.outcome === "unavailable")
        toast.error("Your layout could not be saved. It stays as it is on this screen.");
      if ((result.outcome === "saved" || result.outcome === "reset") && event.read) {
        // A column the page was read without: read this grid again, at the page it shows.
        const state = readRecordsTableQueryState(placementId, [
          ...new URLSearchParams(window.location.search),
        ]);
        await refreshPlacements([placementId], {
          placementId,
          fromAddress: true,
          request: (state.kind === "valid" ? state.state.page : undefined) ?? {
            page: 1,
            pageDirection: "forward",
          },
        });
      }
      return result;
    },
    [refreshPlacements],
  );

  // A stored layout the release no longer allows (a column was removed, or the grid reads another
  // query) was not applied: say so once, and remove it so the authored layout is the stored state.
  const noticed = useRef(new Set<string>());
  useEffect(() => {
    for (const [placementId, data] of Object.entries(currentData)) {
      const layout = tablePayloadFor(data)?.layout;
      if (layout === undefined || !layout.reset || !layout.persisted || layout.revision === null)
        continue;
      const key = `${placementId.toLowerCase()}:${layout.revision}`;
      if (noticed.current.has(key)) continue;
      noticed.current.add(key);
      toast.info("The saved layout was reset because a column is no longer available.");
      void commitGridLayout(address.current, {
        kind: "reset",
        placementId,
        expectedRevision: layout.revision,
      }).catch((error: unknown) => console.error("[page] obsolete grid layout not removed", error));
    }
  }, [currentData]);

  return { commitLayout };
}
