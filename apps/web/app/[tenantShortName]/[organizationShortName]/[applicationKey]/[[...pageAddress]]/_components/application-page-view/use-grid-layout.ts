import { useCallback, useEffect, useRef } from "react";
import { toast } from "@vortex/ui/components/sonner";
import type { DisplaySemanticEvent } from "@vortex/ui";
import type { GridLayoutCommitResult } from "@vortex/platform/schema";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import { commitGridLayout } from "../../grid-layout-action";
import { tablePayloadFor } from "./placement-helpers";

const UNAVAILABLE: GridLayoutCommitResult = Object.freeze({ outcome: "unavailable" });

/**
 * Stores each data grid's layout for the person. A committed layout gesture is one scoped write and
 * never a route refresh; it reads no records. The grid requests its projection once its pending
 * writes have finished if it needs columns that are not loaded. A conflict (a
 * newer layout from another tab) and a failed write are told in a notice. A stored layout the
 * current release can no longer apply is reset through that same writer, with a notice saying why.
 */
export function useGridLayout({
  model,
  currentData,
}: Readonly<{
  model: ApplicationPageModel;
  currentData: ApplicationPageModel["data"];
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
      return result;
    },
    [],
  );

  // A stored layout the release no longer allows (a column was removed, or the grid reads another
  // query) was not applied: say so once. The grid resets it through its serial writer.
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
    }
  }, [currentData]);

  return { commitLayout };
}
