import { useCallback, useMemo } from "react";
import {
  readRecordsTablePagePosition,
  recordsRangeSummaryResultSchema,
  type RecordsRangeSummaryResult,
} from "@vortex/platform/schema";
import type { DisplaySemanticEvent, TablePayload } from "@vortex/ui";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import type { PageAddress } from "./page-address";
import { recordsTableAddress } from "./records-table-address";

/**
 * The totals behind a Records table's spreadsheet status bar: one request per settled range. The
 * request names the page the rows were shown on (its sealed read and its address position) and the
 * selected identities and columns; the server reads that page once and answers. The browser sends
 * no value and totals nothing. An abort ends the request in flight.
 */
export function useRangeSummary({
  model,
  address,
}: Readonly<{ model: ApplicationPageModel; address: PageAddress }>) {
  const eventsFor = useCallback(
    (placementId: string, table: TablePayload) => ({
      range_summary_requested: async (
        event: DisplaySemanticEvent,
      ): Promise<RecordsRangeSummaryResult> => {
        if (event.event !== "range_summary_requested" || table.selectionToken === undefined)
          return { kind: "refused", reason: "not_available" };
        // The page position of the table in the address: where the shown page was read from.
        const page = readRecordsTablePagePosition(
          placementId,
          new URLSearchParams(address.search()),
        );
        const response = await fetch("/api/records-table/range-summary", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          signal: event.signal,
          body: JSON.stringify({
            ...recordsTableAddress(model),
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
        // The answer is parsed, never trusted: an unreadable one is logged and shown as refused.
        const answer = recordsRangeSummaryResultSchema.safeParse(await response.json());
        if (answer.success) return answer.data;
        console.error(
          `[page] range summary answer unreadable: status=${response.status}`,
          answer.error,
        );
        return { kind: "refused", reason: "not_available" };
      },
    }),
    [address, model],
  );
  return useMemo(() => ({ eventsFor }), [eventsFor]);
}
