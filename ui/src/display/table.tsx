import type { ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import { DisplayCellView } from "./cell";
import {
  DisplayHeader,
  PaginationControl,
  resolveDisplayContext,
  RowActionControl,
  rowName,
  SelectionControl,
} from "./controls";
import { DisplayStateContainer } from "./display-state-container";

/**
 * Shared browser-safe display component for tabular data.
 * Renders only declared columns and permitted rows, preserving stable identities and declared events.
 * Never executes or fetches a Query.
 */
export function TableDisplay(props: PlatformBlockRenderProps): ReactElement {
  const { placementId, availability } = props;
  const { title, accessibleName, values, state, events } = resolveDisplayContext(
    props,
    "table",
    (table) => table.rows.length === 0,
  );

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={availability}
      projectedData={state}
      emptyMessage="No records to show"
    >
      {values === undefined ? null : (
        <div
          data-vortex-display="table"
          data-vortex-placement-id={placementId}
          className="vortex-display-table"
        >
          <DisplayHeader title={title} accessibleName={accessibleName} events={events} />
          <table className="vortex-table" aria-label={accessibleName}>
            <thead>
              <tr className="vortex-table-header-row">
                {events?.selection_changed === undefined ? null : (
                  <th scope="col" className="vortex-table-col-select">
                    <span className="vortex-sr-only">Selected</span>
                  </th>
                )}
                {values.columns.map((column) => {
                  const direction =
                    values.sort?.columnKey === column.key ? values.sort.direction : undefined;
                  const onSort = events?.sort_changed;
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      aria-sort={direction ?? "none"}
                      className="vortex-table-header-cell"
                    >
                      {onSort === undefined ? (
                        column.label
                      ) : (
                        <button
                          type="button"
                          className="vortex-sort-button"
                          onClick={() =>
                            onSort({
                              event: "sort_changed",
                              columnKey: column.key,
                              direction: direction === "ascending" ? "descending" : "ascending",
                            })
                          }
                        >
                          {column.label}
                          {direction === undefined ? null : (
                            <span aria-hidden="true">
                              {direction === "ascending" ? " ▲" : " ▼"}
                            </span>
                          )}
                        </button>
                      )}
                    </th>
                  );
                })}
                {events?.row_action === undefined ? null : (
                  <th scope="col" className="vortex-table-col-actions">
                    <span className="vortex-sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {values.rows.map((row) => {
                const name = rowName(row, values.columns[0]?.key);
                return (
                  <tr
                    key={row.recordId}
                    data-vortex-record-id={row.recordId}
                    className="vortex-table-row"
                  >
                    {events?.selection_changed === undefined ? null : (
                      <td className="vortex-table-cell-select">
                        <SelectionControl
                          row={row}
                          name={name}
                          selected={values.selectedRecordIds?.includes(row.recordId) ?? false}
                          events={events}
                        />
                      </td>
                    )}
                    {values.columns.map((column) => (
                      <td key={column.key} className="vortex-table-cell">
                        <DisplayCellView value={row.cells[column.key] ?? { kind: "empty" }} />
                      </td>
                    ))}
                    {events?.row_action === undefined ? null : (
                      <td className="vortex-table-cell-action">
                        <RowActionControl recordId={row.recordId} name={name} events={events} />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <PaginationControl
            page={values.page}
            pageCount={values.pageCount}
            accessibleName={accessibleName}
            events={events}
          />
        </div>
      )}
    </DisplayStateContainer>
  );
}
