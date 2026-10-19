import { useCallback, useRef } from "react";
import type { DisplaySemanticEvent } from "@vortex/ui";
import type { RowDetailLoadResult } from "../../../../../../_lib/application-page/row-detail";
import { readRowDetail } from "../../row-detail-action";

type Address = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
  applicationKey: string;
  installationRevision: number;
}>;

/**
 * Reads an expanded row's related records, one server read per expand and per "Show more". Each
 * row keeps a generation: a reply that arrives after a later read for the same row started is
 * dropped (resolved as undefined), so a collapsed and reopened row never shows an older page. A
 * read of a release this page no longer shows refreshes the page.
 */
export function useRowDetail({
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

  const readDetail = useCallback(
    async (placementId: string, event: DisplaySemanticEvent): Promise<unknown> => {
      if (event.event !== "row_expanded") return undefined;
      const key = `${placementId.toLowerCase()}:${event.recordId.toLowerCase()}`;
      const generation = (generations.current.get(key) ?? 0) + 1;
      generations.current.set(key, generation);
      const current = address.current;
      if (current.currentPageKey === undefined) return { status: "error" };
      let result: RowDetailLoadResult;
      try {
        result = await readRowDetail({
          tenantShortName: current.application.tenantShortName,
          organizationShortName: current.application.organizationShortName,
          applicationKey: current.application.applicationKey,
          pageKey: current.currentPageKey,
          installationRevision: current.application.installationRevision,
          search: current.currentSearch,
          placementId,
          recordId: event.recordId,
          ...(event.continuationToken === undefined
            ? {}
            : { continuationToken: event.continuationToken }),
        });
      } catch (error) {
        console.error("[page] related records could not be read", error);
        result = { kind: "temporarily_unavailable" };
      }
      const latest = address.current;
      if (
        generations.current.get(key) !== generation ||
        latest.currentPageKey !== current.currentPageKey ||
        latest.currentSearch !== current.currentSearch ||
        latest.application.tenantShortName !== current.application.tenantShortName ||
        latest.application.organizationShortName !== current.application.organizationShortName ||
        latest.application.applicationKey !== current.application.applicationKey ||
        latest.application.installationRevision !== current.application.installationRevision
      )
        return undefined;
      switch (result.kind) {
        case "available":
          return result.detail;
        case "reload":
          address.current.onReload();
          return { status: "error" };
        case "unavailable":
          return { status: "refused" };
        case "temporarily_unavailable":
          return { status: "error" };
      }
    },
    [
      application.tenantShortName,
      application.organizationShortName,
      application.applicationKey,
      application.installationRevision,
      currentPageKey,
      currentSearch,
    ],
  );

  return { readDetail };
}
