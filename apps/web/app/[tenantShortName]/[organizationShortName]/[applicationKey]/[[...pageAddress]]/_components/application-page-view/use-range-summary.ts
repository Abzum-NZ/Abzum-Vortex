import { useCallback, useMemo } from "react";
import {
  parseRecordsTablePagePosition,
  type RecordsRangeSummaryResult,
} from "@vortex/platform/schema";
import type { DisplaySemanticEvent, TablePayload } from "@vortex/ui";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";

/** The page position of a table's placement in the address: where the shown page was read from. */
const pagePositionOf = (placementId: string) => {
  for (const [name, value] of new URLSearchParams(window.location.search))
    if (name.toLowerCase() === `page.${placementId.toLowerCase()}`)
      return parseRecordsTablePagePosition(value);
  return undefined;
};

/**
 * The totals behind a Records table's spreadsheet status bar: one request per settled range. The
 * request names the page the rows were shown on (its sealed read and its address position) and the
 * selected identities and columns; the server reads that page once and answers. The browser sends
 * no value and totals nothing. An abort ends the request in flight.
 */
export function useRangeSummary({ model }: Readonly<{ model: ApplicationPageModel }>) {
  const eventsFor = useCallback(
    (placementId: string, table: TablePayload) => ({
      range_summary_requested: async (
        event: DisplaySemanticEvent,
      ): Promise<RecordsRangeSummaryResult> => {
        if (event.event !== "range_summary_requested" || table.selectionToken === undefined)
          return { kind: "refused" };
        const page = pagePositionOf(placementId);
        const response = await fetch("/api/records-table/range-summary", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          signal: event.signal,
          body: JSON.stringify({
            tenantShortName: model.invocation.tenantShortName,
            organizationShortName: model.invocation.organizationShortName,
            applicationKey: model.invocation.applicationKey,
            pageKey: model.invocation.pageKey,
            placementId,
            token: table.selectionToken,
            ...(page === undefined
              ? {}
              : {
                  page: {
                    pageDirection: page.pageDirection,
                    ...(page.continuationToken === undefined
                      ? {}
                      : { continuationToken: page.continuationToken }),
                  },
                }),
            recordIds: event.recordIds,
            fieldIds: event.fieldIds,
          }),
        });
        return (await response.json()) as RecordsRangeSummaryResult;
      },
    }),
    [model],
  );
  return useMemo(() => ({ eventsFor }), [eventsFor]);
}
