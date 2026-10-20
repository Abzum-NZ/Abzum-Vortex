import { useCallback, useRef } from "react";
import type { DisplaySemanticEvent } from "@vortex/ui";
import type { PivotLoadResult } from "../../../../../../_lib/application-page/pivot";
import { readPivot } from "../../pivot-action";

type Address = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
  applicationKey: string;
  installationRevision: number;
}>;

/**
 * Reads a table's pivot, one server read per opening, per change of the table's search or filters
 * and per page of rows. Each table keeps a generation: a reply that arrives after a later read for
 * the same table started is dropped (resolved as undefined), so an older pivot never replaces a
 * newer one. A read of a release this page no longer shows refreshes the page.
 */
export function usePivot({
  application,
  currentPageKey,
  currentSearch,
  onReload,
}: Readonly<{
  application: Address;
  /** Undefined while the page is not one of the application's pages; nothing is read then. */
  currentPageKey: string | undefined;
  currentSearch: string;
  onReload: () => void;
}>) {
  const generations = useRef(new Map<string, number>());
  const address = useRef({ application, currentPageKey, currentSearch, onReload });
  address.current = { application, currentPageKey, currentSearch, onReload };

  const readPivotPage = useCallback(
    async (placementId: string, event: DisplaySemanticEvent): Promise<unknown> => {
      if (event.event !== "pivot_requested") return undefined;
      const key = placementId.toLowerCase();
      const generation = (generations.current.get(key) ?? 0) + 1;
      generations.current.set(key, generation);
      const current = address.current;
      if (current.currentPageKey === undefined) return { status: "error" };
      let result: PivotLoadResult;
      try {
        result = await readPivot({
          tenantShortName: current.application.tenantShortName,
          organizationShortName: current.application.organizationShortName,
          applicationKey: current.application.applicationKey,
          pageKey: current.currentPageKey,
          installationRevision: current.application.installationRevision,
          search: current.currentSearch,
          placementId,
          ...(event.cursor === undefined ? {} : { cursor: event.cursor }),
        });
      } catch (error) {
        console.error("[page] pivot could not be read", error);
        result = { kind: "temporarily_unavailable" };
      }
      const latest = address.current;
      if (
        generations.current.get(key) !== generation ||
        latest.currentPageKey !== current.currentPageKey ||
        latest.application.tenantShortName !== current.application.tenantShortName ||
        latest.application.organizationShortName !== current.application.organizationShortName ||
        latest.application.applicationKey !== current.application.applicationKey ||
        latest.application.installationRevision !== current.application.installationRevision
      )
        return undefined;
      switch (result.kind) {
        case "available":
          return result.pivot;
        case "reload":
          address.current.onReload();
          return { status: "error" };
        case "unavailable":
          return { status: "refused", message: "This pivot is not available." };
        case "temporarily_unavailable":
          return { status: "error" };
      }
    },
    // Everything the read needs is taken from the latest address when it runs, so the handler
    // keeps one identity and an address write never restarts a read.
    [],
  );

  return { readPivotPage };
}
