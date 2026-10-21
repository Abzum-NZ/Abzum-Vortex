import { useCallback, useRef } from "react";
import {
  applyRecordsTableGroupExpansion,
  type RecordsTableQueryChange,
} from "@vortex/platform/schema";
import type { DisplaySemanticEvent } from "@vortex/ui";
import type { RowDetailLoadResult } from "../../../../../../_lib/application-page/row-detail";
import { readRowDetail } from "../../row-detail-action";

/** The address without the open group: opening or closing a group changes nothing the read depends on. */
const queryOf = (search: string, placementId: string): string => {
  const parameters = new URLSearchParams(search);
  applyRecordsTableGroupExpansion(parameters, placementId, null);
  return parameters.toString();
};

type Address = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
  applicationKey: string;
  installationRevision: number;
}>;

/**
 * Reads the members of a grouped table's open group, one server read per opening and per page of
 * it, and keeps the open group in the address without reading the table again: the groups were
 * counted by the page read, and closing or switching a group changes only what is shown. Each
 * table keeps a generation: a reply that arrives after a later read for the same table started is
 * dropped (resolved as undefined), so an older group never replaces a newer one. A read of a
 * release this page no longer shows refreshes the page.
 */
export function useGroupMembers({
  application,
  currentPageKey,
  currentSearch,
  onReload,
  changeTableQuery,
}: Readonly<{
  application: Address;
  /** Undefined while the page is not one of the application's pages; nothing is read then. */
  currentPageKey: string | undefined;
  currentSearch: string;
  onReload: () => void;
  changeTableQuery: (
    placementId: string,
    change: Exclude<RecordsTableQueryChange, { kind: "page" }>,
  ) => void;
}>) {
  const generations = useRef(new Map<string, number>());
  const address = useRef({ application, currentPageKey, currentSearch, onReload });
  address.current = { application, currentPageKey, currentSearch, onReload };

  const readGroupPage = useCallback(
    async (placementId: string, event: DisplaySemanticEvent): Promise<unknown> => {
      if (event.event !== "group_requested") return undefined;
      const key = placementId.toLowerCase();
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
          groupKey: event.key,
          ...(event.direction === undefined ? {} : { direction: event.direction }),
          ...(event.continuationToken === undefined
            ? {}
            : { continuationToken: event.continuationToken }),
        });
      } catch (error) {
        console.error("[page] a group's members could not be read", error);
        result = { kind: "temporarily_unavailable" };
      }
      const latest = address.current;
      if (
        generations.current.get(key) !== generation ||
        latest.currentPageKey !== current.currentPageKey ||
        queryOf(latest.currentSearch, placementId) !==
          queryOf(current.currentSearch, placementId) ||
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
    // Everything the read needs is taken from the latest address when it runs, so the handler
    // keeps one identity and an address write never restarts a read.
    [],
  );

  /**
   * Keeps the open group (or none) in the address without a history entry and without reading the
   * table again. Closing a group also ends any member read still on its way.
   */
  const commitGroupOpen = useCallback((placementId: string, groupKey: string | null) => {
    if (groupKey === null)
      generations.current.set(
        placementId.toLowerCase(),
        (generations.current.get(placementId.toLowerCase()) ?? 0) + 1,
      );
    const parameters = new URLSearchParams(window.location.search);
    applyRecordsTableGroupExpansion(parameters, placementId, groupKey);
    const query = parameters.toString();
    window.history.replaceState(null, "", query === "" ? window.location.pathname : `?${query}`);
  }, []);

  /**
   * The events a grouped table reports: grouping on or off, or another page of the groups (an
   * address change that reads the groups once), one page of an open group's members, and the open group (kept in the address).
   * The grouping field is the table's own, as the server projected it, never one the browser names.
   */
  const eventsFor = useCallback(
    (placementId: string, fieldId: string) => ({
      group_changed: (event: DisplaySemanticEvent) => {
        if (event.event !== "group_changed") return;
        changeTableQuery(placementId, { kind: "group", fieldId: event.grouped ? fieldId : null });
      },
      group_page_changed: (event: DisplaySemanticEvent) => {
        if (event.event !== "group_page_changed") return;
        changeTableQuery(placementId, { kind: "groupPage", fieldId, after: event.after });
      },
      group_requested: (event: DisplaySemanticEvent) => readGroupPage(placementId, event),
      group_opened: (event: DisplaySemanticEvent) => {
        if (event.event !== "group_opened") return;
        commitGroupOpen(placementId, event.key);
      },
    }),
    [changeTableQuery, readGroupPage, commitGroupOpen],
  );

  return { groupEventsFor: eventsFor };
}
