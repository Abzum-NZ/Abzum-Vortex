import type { DisplaySemanticEvent, DisplayTablePayload } from "@vortex/ui";
import {
  containedComponentIdSchema,
  searchWithoutRecordsTableState,
  type RecordsTablePageRequest,
} from "@vortex/platform/schema";
import type { usePlacementActions } from "./use-placement-actions";

type Pagination = Pick<
  Parameters<typeof usePlacementActions>[0],
  | "commitTablePage"
  | "currentSearch"
  | "navigationKey"
  | "tableQueryPending"
  | "tableContinuationScopeRef"
>;

/** Read only the requested table page under the current query and viewer authority. */
export async function continueTablePage(
  {
    commitTablePage,
    currentSearch,
    navigationKey,
    tableQueryPending,
    tableContinuationScopeRef,
  }: Pagination,
  placementId: string,
  event: DisplaySemanticEvent,
  table: DisplayTablePayload,
): Promise<void> {
  if (
    event.event !== "page_changed" ||
    "columns" in event ||
    !Number.isSafeInteger(event.page) ||
    event.page < 1 ||
    event.page > 100_000 ||
    table.page === undefined
  )
    return;
  const parsedId = containedComponentIdSchema.safeParse(placementId);
  // The shown page was read for an earlier sort, filter, search or column state: its tokens
  // belong to that state, so a page move waits for the new state's page.
  if (!parsedId.success || tableQueryPending(parsedId.data)) return;

  const scopeKey = `${navigationKey}\u0000${searchWithoutRecordsTableState(currentSearch)}`;
  let scope = tableContinuationScopeRef.current;
  if (scope.scopeKey !== scopeKey) {
    scope = { scopeKey, inFlight: new Set() };
    tableContinuationScopeRef.current = scope;
  }
  const placementKey = parsedId.data.toLowerCase();
  const direction = event.direction;
  const continuationToken =
    direction === "next"
      ? table.nextContinuationToken
      : direction === "previous"
        ? table.previousContinuationToken
        : undefined;
  if (
    // First needs only a later page: an empty continuation page has no previous anchor.
    (direction === "first" && (event.page !== 1 || table.page <= 1)) ||
    (direction === "last" && (table.hasNextPage !== true || event.page !== 2)) ||
    (direction === "next" &&
      (table.hasNextPage !== true ||
        event.page !== 2 ||
        continuationToken === undefined ||
        event.continuationToken !== continuationToken)) ||
    (direction === "previous" &&
      (table.hasPreviousPage !== true ||
        event.page !== 2 ||
        continuationToken === undefined ||
        event.continuationToken !== continuationToken))
  )
    return;
  const requestKey = `${placementKey}\u0000${direction}`;
  if (scope.inFlight.has(requestKey)) return;
  scope.inFlight.add(requestKey);
  try {
    const request: RecordsTablePageRequest = {
      page: event.page,
      pageDirection: direction === "previous" || direction === "last" ? "backward" : "forward",
      ...(continuationToken === undefined ? {} : { continuationToken }),
    };
    // One read of the requested page under the viewer's current access; no page is replayed.
    await commitTablePage(parsedId.data, request);
  } finally {
    scope.inFlight.delete(requestKey);
  }
}
