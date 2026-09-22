import type { ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import { DisplayCellView } from "./cell";
import { DisplayStateContainer, getAccessibleName } from "./display-state-container";
import { DefinitionRenderError } from "../definition-error";

/**
 * Shared browser-safe display component for tabular data.
 * Renders only declared columns and permitted rows, preserving stable identities and declared events.
 * Never executes or fetches a Query.
 */
export function TableDisplay({
  placementId,
  settings,
  projectedData,
  displayEvents,
  availability,
  unavailableReason,
}: PlatformBlockRenderProps): ReactElement {
  const accessibleName = getAccessibleName(settings, "Table");

  if (projectedData?.status === "ready" && projectedData.values.kind !== "table") {
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      `Table component expected 'table' projected values, got '${projectedData.values.kind}'`,
      { placementId },
    );
  }

  const tableValues = projectedData?.status === "ready" ? projectedData.values : undefined;
  const rows = tableValues?.rows ?? [];
  const columns = tableValues?.columns ?? [];

  const effectiveProjectedData =
    projectedData ?? { status: "empty" };

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={availability}
      unavailableReason={unavailableReason}
      projectedData={rows.length === 0 && effectiveProjectedData.status === "ready" ? { status: "empty" } : effectiveProjectedData}
      emptyMessage="No table records"
    >
      {tableValues ? (
        <div
          data-vortex-display="table"
          data-vortex-placement-id={placementId}
          className="vortex-display-table"
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
          <table className="vortex-table" aria-label={accessibleName}>
            <thead>
              <tr className="vortex-table-header-row">
                {displayEvents?.selection_changed ? (
                  <th scope="col" className="vortex-table-col-select">
                    <span className="vortex-sr-only">Select</span>
                  </th>
                ) : null}
                {columns.map((column) => {
                  const isSorted = tableValues.sort?.columnKey === column.key;
                  const sortDirection = isSorted ? tableValues.sort!.direction : "none";
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      aria-sort={sortDirection}
                      className="vortex-table-header-cell"
                    >
                      {displayEvents?.sort_changed ? (
                        <button
                          type="button"
                          className="vortex-sort-button"
                          aria-label={`Sort by ${column.label}`}
                          onClick={() => {
                            const nextDirection =
                              isSorted && tableValues.sort!.direction === "ascending"
                                ? "descending"
                                : "ascending";
                            displayEvents.sort_changed?.({
                              event: "sort_changed",
                              columnKey: column.key,
                              direction: nextDirection,
                            });
                          }}
                        >
                          {column.label}
                          {isSorted ? (tableValues.sort!.direction === "ascending" ? " ▲" : " ▼") : ""}
                        </button>
                      ) : (
                        column.label
                      )}
                    </th>
                  );
                })}
                {displayEvents?.row_action ? (
                  <th scope="col" className="vortex-table-col-actions">
                    <span className="vortex-sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isSelected = tableValues.selectedRecordIds?.includes(row.recordId) ?? false;
                return (
                  <tr
                    key={row.recordId}
                    data-vortex-record-id={row.recordId}
                    className="vortex-table-row"
                  >
                    {displayEvents?.selection_changed ? (
                      <td className="vortex-table-cell-select">
                        <input
                          type="checkbox"
                          className="vortex-selection-checkbox"
                          aria-label={`Select row ${row.recordId}`}
                          checked={isSelected}
                          onChange={(e) =>
                            displayEvents.selection_changed?.({
                              event: "selection_changed",
                              recordId: row.recordId,
                              selected: e.target.checked,
                            })
                          }
                        />
                      </td>
                    ) : null}
                    {columns.map((column) => (
                      <td key={column.key} className="vortex-table-cell">
                        <DisplayCellView value={row.cells[column.key] ?? { kind: "empty" }} />
                      </td>
                    ))}
                    {displayEvents?.row_action ? (
                      <td className="vortex-table-cell-action">
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
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {tableValues.page !== undefined && tableValues.pageCount !== undefined ? (
            <nav className="vortex-pagination" aria-label={`Pagination for ${accessibleName}`}>
              <span className="vortex-pagination-info">
                Page {tableValues.page} of {tableValues.pageCount}
              </span>
              <button
                type="button"
                className="vortex-pagination-prev"
                disabled={tableValues.page <= 1}
                aria-label="Previous page"
                onClick={() =>
                  displayEvents?.page_changed?.({
                    event: "page_changed",
                    page: tableValues.page! - 1,
                  })
                }
              >
                Previous
              </button>
              <button
                type="button"
                className="vortex-pagination-next"
                disabled={tableValues.page >= tableValues.pageCount}
                aria-label="Next page"
                onClick={() =>
                  displayEvents?.page_changed?.({
                    event: "page_changed",
                    page: tableValues.page! + 1,
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
