import type { ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import { DisplayCellView } from "./cell";
import { DisplayStateContainer, getAccessibleName } from "./display-state-container";
import { DefinitionRenderError } from "../definition-error";

/**
 * Shared browser-safe display component for lists of permission-projected records.
 * Preserves stable row identities and emits declared semantic events on explicit user interaction.
 * Never executes or fetches a Query.
 */
export function ListDisplay({
  placementId,
  settings,
  projectedData,
  displayEvents,
  availability,
  unavailableReason,
}: PlatformBlockRenderProps): ReactElement {
  const accessibleName = getAccessibleName(settings, "List");

  if (projectedData?.status === "ready" && projectedData.values.kind !== "list") {
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      `List component expected 'list' projected values, got '${projectedData.values.kind}'`,
      { placementId },
    );
  }

  const listValues = projectedData?.status === "ready" ? projectedData.values : undefined;
  const rows = listValues?.rows ?? [];

  const effectiveProjectedData =
    projectedData ?? { status: "empty" };

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={availability}
      unavailableReason={unavailableReason}
      projectedData={rows.length === 0 && effectiveProjectedData.status === "ready" ? { status: "empty" } : effectiveProjectedData}
      emptyMessage="No items in list"
    >
      {listValues ? (
        <div
          data-vortex-display="list"
          data-vortex-placement-id={placementId}
          className="vortex-display-list"
          aria-label={accessibleName}
        >
          <div className="vortex-display-header">
            <h2 className="vortex-display-title">{accessibleName}</h2>
            {displayEvents?.refresh ? (
              <button
                type="button"
                className="vortex-button-refresh"
                aria-label={`Refresh ${accessibleName}`}
                onClick={() => displayEvents.refresh?.({ event: "refresh" })}
              >
                Refresh
              </button>
            ) : null}
          </div>
          <ul role="list" className="vortex-list-items">
            {rows.map((row) => {
              const isSelected = listValues.selectedRecordIds?.includes(row.recordId) ?? false;
              const headingValue = row.cells[listValues.headingKey] ?? {
                kind: "text",
                text: row.recordId,
              };
              const secondaryValue =
                listValues.secondaryKey !== undefined
                  ? row.cells[listValues.secondaryKey]
                  : undefined;
              return (
                <li
                  key={row.recordId}
                  data-vortex-record-id={row.recordId}
                  className="vortex-list-item"
                >
                  {displayEvents?.selection_changed ? (
                    <input
                      type="checkbox"
                      className="vortex-selection-checkbox"
                      aria-label={`Select ${row.recordId}`}
                      checked={isSelected}
                      onChange={(e) =>
                        displayEvents.selection_changed?.({
                          event: "selection_changed",
                          recordId: row.recordId,
                          selected: e.target.checked,
                        })
                      }
                    />
                  ) : null}
                  <div className="vortex-list-content">
                    <span className="vortex-list-heading">
                      <DisplayCellView value={headingValue} />
                    </span>
                    {secondaryValue !== undefined ? (
                      <span className="vortex-list-secondary">
                        <DisplayCellView value={secondaryValue} />
                      </span>
                    ) : null}
                  </div>
                  {displayEvents?.row_action ? (
                    <button
                      type="button"
                      className="vortex-button-row-action"
                      aria-label={`Action for ${row.recordId}`}
                      onClick={() =>
                        displayEvents.row_action?.({
                          event: "row_action",
                          recordId: row.recordId,
                          action: "select",
                        })
                      }
                    >
                      Select
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {listValues.page !== undefined && listValues.pageCount !== undefined ? (
            <nav className="vortex-pagination" aria-label={`Pagination for ${accessibleName}`}>
              <span className="vortex-pagination-info">
                Page {listValues.page} of {listValues.pageCount}
              </span>
              <button
                type="button"
                className="vortex-pagination-prev"
                disabled={listValues.page <= 1}
                aria-label="Previous page"
                onClick={() =>
                  displayEvents?.page_changed?.({
                    event: "page_changed",
                    page: listValues.page! - 1,
                  })
                }
              >
                Previous
              </button>
              <button
                type="button"
                className="vortex-pagination-next"
                disabled={listValues.page >= listValues.pageCount}
                aria-label="Next page"
                onClick={() =>
                  displayEvents?.page_changed?.({
                    event: "page_changed",
                    page: listValues.page! + 1,
                  })
                }
              >
                Next
              </button>
            </nav>
          ) : null}
        </div>
      ) : null}
    </DisplayStateContainer>
  );
}
