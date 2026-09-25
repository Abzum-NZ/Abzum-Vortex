import type { KeyboardEvent, ReactElement } from "react";
import {
  readRecordsTableContract,
  type RecordsTableActionContract,
  type RecordsTableColumnContract,
  type RecordsTableContract,
} from "@vortex/contracts";
import type { PlatformBlockRenderProps } from "../registry";
import { DisplayCellView } from "./cell";
import {
  BulkActionControl,
  DisplayHeader,
  FilterControl,
  type FilterInputKind,
  InlineEditCell,
  PaginationControl,
  resolveDisplayContext,
  RowActionControl,
  rowName,
  SearchControl,
  SelectAllControl,
  SelectionControl,
} from "./controls";
import { DisplayStateContainer } from "./display-state-container";
import type { DisplayCellValue, DisplayColumn, DisplayRow } from "./projected-data";

type RenderedColumn = Readonly<{
  key: string;
  label: string;
  declared: RecordsTableColumnContract | undefined;
}>;

/**
 * The columns to render. A placement that declares a data contract shows its declared columns in
 * declared order, but only those the permission projection supplies: a column whose field the
 * viewer cannot read is withheld from the projection and never rendered, not even as a heading.
 * The projected column supplies the label a declared column left unset. A placement without a
 * contract renders the projected columns as before.
 */
const renderedColumns = (
  contract: RecordsTableContract | undefined,
  projected: readonly DisplayColumn[],
): readonly RenderedColumn[] => {
  if (contract === undefined)
    return projected.map((column) => ({ key: column.key, label: column.label, declared: undefined }));
  const labels = new Map(projected.map((column) => [column.key, column.label]));
  return contract.columns.flatMap((column): RenderedColumn[] => {
    const projectedLabel = labels.get(column.field);
    return projectedLabel === undefined
      ? []
      : [{ key: column.field, label: column.label ?? projectedLabel, declared: column }];
  });
};

/** Declared presentation of one column, exposed as data attributes and an inline alignment. */
const columnAttributes = (
  column: RenderedColumn,
): {
  "data-vortex-column-width"?: string;
  "data-vortex-column-priority"?: string;
  style?: { textAlign: "start" | "center" | "end" };
} =>
  column.declared === undefined
    ? {}
    : {
        "data-vortex-column-width": column.declared.width,
        "data-vortex-column-priority": column.declared.priority,
        style: { textAlign: column.declared.alignment },
      };

/** Field identities compare without regard to case, as the Query engine keys them. */
const sameFieldKey = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

/** The filter control kind for a declared filterable field, from the column it is declared with. */
const filterInputKind = (
  contract: RecordsTableContract | undefined,
  field: string,
): FilterInputKind => {
  const declared = contract?.columns.find((column) => sameFieldKey(column.field, field));
  switch (declared?.format) {
    case "number":
    case "currency":
    case "percent":
      return "number";
    case "date":
    case "date_time":
      return "date";
    case "boolean":
      return "boolean";
    default:
      return "text";
  }
};

/**
 * Whether a row shows a declared command. A command that declares no capability (an open, read or
 * custom command) always shows; a command that declares one shows only when the row's per-row
 * capabilities include it, and never when the payload carries no capabilities. It only hides a
 * control; the server re-checks every action.
 */
const rowShowsAction = (
  row: DisplayRow,
  action: Pick<RecordsTableActionContract, "capability">,
): boolean =>
  action.capability === undefined ||
  row.capabilities?.actions.includes(action.capability) === true;

/**
 * Shared browser-safe display component for tabular data.
 * Renders only declared columns and permitted rows, preserving stable identities and declared events.
 * A Records table placement declares its columns, sortable and filterable fields, search, page size,
 * selection mode and row behaviours as settings. Every control reports a declared data event; the
 * component never sorts, filters or pages the returned rows itself.
 */
export function TableDisplay(props: PlatformBlockRenderProps): ReactElement {
  const { placementId, availability } = props;
  const { title, accessibleName, values, state, emptyMessage, refusedMessage, errorMessage, events } =
    resolveDisplayContext(props, "table", (table) => table.rows.length === 0, "No records to show");
  const contract = readRecordsTableContract(props.settings);
  const columns = values === undefined ? [] : renderedColumns(contract, values.columns);
  const rows = values?.rows ?? [];
  const sortable = (column: RenderedColumn): boolean =>
    contract === undefined || contract.sortableFields.includes(column.key);
  const selectionMode = contract?.selectionMode ?? "none";
  const selectable = events?.selection_changed !== undefined && contract?.selectionMode !== "none";

  // Filter controls and the search box report their declared data events; sorting already does the
  // same. The host sends each to the Query engine and returns a new page, so the component never
  // sorts, filters or searches the returned rows itself.
  const filterFields = contract?.filterableFields ?? [];
  const showFilters = events?.filter_changed !== undefined && filterFields.length > 0;
  const showSearch = contract?.search === true && events?.search_changed !== undefined;
  const filterLabel = (field: string): string =>
    columns.find((column) => sameFieldKey(column.key, field))?.label ?? field;

  // Configured row behaviours: a row click, named row actions, bulk actions over the selection and
  // inline edit of permitted fields. Each declared control carries the stable identity of its own
  // flow binding, so one table placement can run several different flows.
  const behaviours = contract?.rowBehaviours;
  const rowClickEventId = behaviours?.rowClick?.eventId;
  const onRowClick = rowClickEventId === undefined ? undefined : events?.row_clicked;
  const activateRow =
    onRowClick === undefined || rowClickEventId === undefined
      ? undefined
      : (recordId: string) =>
          onRowClick({ event: "row_clicked", eventId: rowClickEventId, recordId });
  const declaredRowActions = behaviours?.rowActions ?? [];
  const declaredBulkActions = behaviours?.bulkActions ?? [];
  const inlineEdit = behaviours?.inlineEdit;
  const inlineEventId = inlineEdit?.eventId;
  const onInlineEdit = inlineEdit === undefined ? undefined : events?.inline_edit;
  const inlineFields = inlineEdit?.fields ?? [];
  // Only a text, number or yes/no cell of a field the row may change has a closed value the editor
  // can commit without guessing; any other cell stays read-only. The row revision travels with the
  // commit so the server refuses a stale change.
  const editable = (row: DisplayRow, columnKey: string, value: DisplayCellValue): boolean =>
    onInlineEdit !== undefined &&
    inlineEventId !== undefined &&
    inlineFields.some((field) => sameFieldKey(field, columnKey)) &&
    row.capabilities !== undefined &&
    row.capabilities.actions.includes("update") &&
    row.capabilities.changeableFieldIds.some((fieldId) => sameFieldKey(fieldId, columnKey)) &&
    (value.kind === "text" || value.kind === "number" || value.kind === "boolean");
  const showActionsColumn = events?.row_action !== undefined;
  const selectedRecordIds = values?.selectedRecordIds ?? [];
  const pageRecordIds = rows.map((row) => row.recordId);
  const allSelected =
    pageRecordIds.length > 0 &&
    pageRecordIds.every((recordId) => selectedRecordIds.includes(recordId));
  const showBulkActions =
    selectable && declaredBulkActions.length > 0 && events?.bulk_action !== undefined;
  // A bulk command that declares a capability stays disabled unless every selected row reports it.
  const bulkCapable = (capability: RecordsTableActionContract["capability"]): boolean => {
    if (capability === undefined) return true;
    const required = capability;
    if (selectedRecordIds.length === 0) return false;
    return selectedRecordIds.every(
      (recordId) =>
        rows
          .find((row) => row.recordId === recordId)
          ?.capabilities?.actions.includes(required) === true,
    );
  };

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={availability}
      projectedData={state}
      emptyMessage={emptyMessage}
      {...(refusedMessage === undefined ? {} : { refusedMessage })}
      {...(errorMessage === undefined ? {} : { errorMessage })}
    >
      {values === undefined ? null : (
        <div
          data-vortex-display="table"
          data-vortex-placement-id={placementId}
          className="vortex-display-table"
        >
          <DisplayHeader title={title} accessibleName={accessibleName} events={events} />
          {!showSearch && !showFilters ? null : (
            <div className="vortex-table-controls">
              {!showSearch ? null : (
                <SearchControl accessibleName={accessibleName} events={events} />
              )}
              {!showFilters ? null : (
                <div
                  className="vortex-table-filters"
                  role="group"
                  aria-label={`Filters for ${accessibleName}`}
                >
                  {filterFields.map((field) => (
                    <FilterControl
                      key={field}
                      field={field}
                      label={filterLabel(field)}
                      input={filterInputKind(contract, field)}
                      events={events}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
          {!showBulkActions ? null : (
            <div
              className="vortex-table-bulk-actions"
              role="group"
              aria-label={`Bulk actions for ${accessibleName}`}
            >
              {declaredBulkActions.map((action) => (
                <BulkActionControl
                  key={action.eventId}
                  eventId={action.eventId}
                  label={action.label}
                  recordIds={selectedRecordIds}
                  capable={bulkCapable(action.capability)}
                  events={events}
                />
              ))}
            </div>
          )}
          <table className="vortex-table" aria-label={accessibleName}>
            <thead>
              <tr className="vortex-table-header-row">
                {!selectable ? null : (
                  <th scope="col" className="vortex-table-col-select">
                    {selectionMode === "multiple" ? (
                      <SelectAllControl
                        allSelected={allSelected}
                        recordIds={pageRecordIds}
                        accessibleName={accessibleName}
                        events={events}
                      />
                    ) : (
                      <span className="vortex-sr-only">Selected</span>
                    )}
                  </th>
                )}
                {columns.map((column) => {
                  const direction =
                    values.sort?.columnKey === column.key ? values.sort.direction : undefined;
                  const onSort = sortable(column) ? events?.sort_changed : undefined;
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      aria-sort={direction ?? "none"}
                      className="vortex-table-header-cell"
                      {...columnAttributes(column)}
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
                {!showActionsColumn ? null : (
                  <th scope="col" className="vortex-table-col-actions">
                    <span className="vortex-sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {values.rows.map((row) => {
                const name = rowName(row, columns[0]?.key);
                const activate = activateRow;
                const rowInteraction =
                  activate === undefined
                    ? {}
                    : {
                        tabIndex: 0,
                        onClick: () => activate(row.recordId),
                        // Only a key pressed on the focused row itself opens it; Enter or Space on
                        // a row command, selection checkbox or inline editor keeps its own meaning.
                        onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            activate(row.recordId);
                          }
                        },
                      };
                return (
                  <tr
                    key={row.recordId}
                    data-vortex-record-id={row.recordId}
                    className={
                      activate === undefined
                        ? "vortex-table-row"
                        : "vortex-table-row vortex-table-row-clickable"
                    }
                    {...rowInteraction}
                  >
                    {!selectable ? null : (
                      <td className="vortex-table-cell-select">
                        <SelectionControl
                          row={row}
                          name={name}
                          selected={selectedRecordIds.includes(row.recordId)}
                          mode={selectionMode === "single" ? "single" : "multiple"}
                          groupName={`vortex-selection-${placementId}`}
                          events={events}
                        />
                      </td>
                    )}
                    {columns.map((column) => {
                      const cell: DisplayCellValue = row.cells[column.key] ?? { kind: "empty" };
                      return (
                        <td
                          key={column.key}
                          className="vortex-table-cell"
                          {...columnAttributes(column)}
                        >
                          {editable(row, column.key, cell) &&
                          onInlineEdit !== undefined &&
                          inlineEventId !== undefined ? (
                            // Keyed by the projected value so a refreshed row resets the editor.
                            <InlineEditCell
                              key={JSON.stringify(cell)}
                              eventId={inlineEventId}
                              recordId={row.recordId}
                              {...(row.revision === undefined ? {} : { revision: row.revision })}
                              field={column.key}
                              label={column.label}
                              value={cell}
                              handler={onInlineEdit}
                            />
                          ) : (
                            <DisplayCellView value={cell} />
                          )}
                        </td>
                      );
                    })}
                    {!showActionsColumn ? null : (
                      <td className="vortex-table-cell-action">
                        {declaredRowActions.length === 0 ? (
                          <RowActionControl recordId={row.recordId} name={name} events={events} />
                        ) : (
                          declaredRowActions
                            .filter((action) => rowShowsAction(row, action))
                            .map((action) => (
                              <RowActionControl
                                key={action.eventId}
                                recordId={row.recordId}
                                name={name}
                                eventId={action.eventId}
                                label={action.label}
                                events={events}
                              />
                            ))
                        )}
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
