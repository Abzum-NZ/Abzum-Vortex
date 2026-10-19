"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  readRecordsTableContract,
  recordsTableDensities,
  type RecordsTableActionContract,
  type RecordsTableDensity,
  type RecordsTableColumnContract,
  type RecordsTableContract,
} from "@vortex/platform/schema";
import { Button } from "../components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "../components/empty";
import { Icon } from "../icons/icon";
import { cellValueToText, DisplayCellView } from "./cell";
import {
  BulkActionsMenu,
  DisplayHeader,
  FilterControl,
  type FilterInputKind,
  InlineEditCell,
  PaginationControl,
  RecordsEmptyState,
  RowActionsMenu,
  SearchControl,
  SelectAllControl,
  SelectionControl,
} from "./controls";
import { resolveDisplayContext, rowName, type DisplayRenderProps } from "./context";
import { DisplayStateContainer } from "./display-state-container";
import type {
  DisplayCellValue,
  DisplayColumn,
  DisplayRow,
  TableNarrowing,
  TablePayload,
} from "./projected-data";
import { RecordsCards, type CardRenderers } from "./table-cards";
import { columnWidth, useTablePresentation } from "./table-geometry";
import { RecordsGrid, type GridRenderers } from "./table-grid";
import { useGridLayout, type GridColumn, type GridLayoutControls } from "./table-layout";
import { TableLoadingState, useLoadingReveal } from "./table-loading";

/** Field identities compare without regard to case, as the Query engine keys them. */
const sameFieldKey = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const narrowed = (narrowing: TableNarrowing | undefined): boolean =>
  narrowing !== undefined && (narrowing.search !== null || narrowing.filters.length > 0);

/**
 * The columns the page carries: the declared columns in declared order, but only those the read
 * requested. A column the read did not request has no values in the payload and is offered only
 * in the Columns menu. The projected column supplies the label a declared column left unset.
 */
const carriedColumns = (
  contract: RecordsTableContract,
  projected: readonly DisplayColumn[],
): GridColumn[] => {
  const labels = new Map(projected.map((column) => [column.key, column.label]));
  return contract.columns.flatMap((column): GridColumn[] => {
    const projectedLabel = labels.get(column.field);
    return projectedLabel === undefined
      ? []
      : [
          {
            key: column.field,
            label: column.label ?? projectedLabel,
            declared: column,
            sortable: contract.sortableFields.some((field) => sameFieldKey(field, column.field)),
            width: columnWidth(column),
          },
        ];
  });
};

/** The filter control kind for a declared filterable field, from the column it is declared with. */
const filterInputKind = (declared: RecordsTableColumnContract): FilterInputKind => {
  switch (declared.format) {
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
  action.capability === undefined || row.capabilities?.actions.includes(action.capability) === true;

/** A polite live region's message; the same text twice is still announced twice. */
const useAnnouncer = (): [string, (message: string) => void] => {
  const [message, setMessage] = useState("");
  const announce = useCallback(
    (next: string) =>
      setMessage((current) => (current === next ? `${next}${String.fromCharCode(160)}` : next)),
    [],
  );
  return [message, announce];
};

/**
 * Show and hide the declared columns, choose the row density, and reset the layout. Every choice
 * changes the grid at once and is stored as the person's own layout; none of them reads records,
 * except showing a column the page was read without, which reads the same page again with it. A
 * hidden column's values are never sent: the next read leaves it out.
 */
function ColumnsMenu({
  accessibleName,
  layout,
  loadedKeys,
  canRead,
  announce,
}: Readonly<{
  accessibleName: string;
  layout: GridLayoutControls;
  /** The columns the shown page carries values for, lower-cased. */
  loadedKeys: ReadonlySet<string>;
  /** Whether the host can read the page again, so a column it was read without can be shown. */
  canRead: boolean;
  announce: (message: string) => void;
}>): ReactElement {
  const shownCount = layout.entries.filter((entry) => entry.visible).length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" aria-label={`Columns of ${accessibleName}`} />}
      >
        <Icon name="sliders-horizontal" data-icon="inline-start" aria-hidden="true" />
        Columns
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Columns</DropdownMenuLabel>
          {layout.entries.map((entry) => (
            <DropdownMenuCheckboxItem
              key={entry.key}
              checked={entry.visible}
              // One column always stays shown; a column the page was read without needs a read.
              disabled={
                (entry.visible && shownCount <= 1) ||
                (!entry.visible && !loadedKeys.has(entry.key) && !canRead)
              }
              onCheckedChange={(checked: boolean) => {
                layout.setVisible(entry.key, checked);
                announce(`${entry.label} ${checked ? "shown" : "hidden"}`);
              }}
            >
              {entry.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Row density</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={layout.density}
            onValueChange={(value: unknown) => {
              const density = recordsTableDensities.find((candidate) => candidate === value);
              if (density === undefined) return;
              layout.setDensity(density);
              announce(`${DENSITY_LABELS[density]} rows`);
            }}
          >
            {recordsTableDensities.map((density) => (
              <DropdownMenuRadioItem key={density} value={density}>
                {DENSITY_LABELS[density]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!layout.arranged}
          onClick={() => {
            layout.reset();
            announce("Layout reset");
          }}
        >
          Reset layout
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const DENSITY_LABELS: Readonly<Record<RecordsTableDensity, string>> = Object.freeze({
  comfortable: "Comfortable",
  compact: "Compact",
});

/**
 * Shared browser-safe display component for tabular data: the one Records table block. It shows
 * exactly the permitted page the host read, as an accessible data grid on wide screens and, when
 * the definition asks for it, as cards on a phone; only the active presentation is mounted. Every
 * control reports a declared data event, and the host reads a new page on the server; the
 * component never sorts, filters, pages or fetches rows itself. Loading, empty, no-match, refused
 * and error states stay distinct, and search and filters stay usable when nothing matched.
 */
export function TableDisplay(props: DisplayRenderProps<TablePayload>): ReactElement {
  const { placementId, availability, settings } = props;
  const {
    title,
    accessibleName,
    values,
    state,
    emptyMessage,
    refusedMessage,
    errorMessage,
    events,
  } = resolveDisplayContext<TablePayload>(
    props,
    // A narrowed page or a later page that matched nothing keeps its controls and columns.
    (table) => table.rows.length === 0 && !narrowed(table.narrowing) && (table.page ?? 1) <= 1,
    "No records to show",
  );
  // Publication refuses a Records table without its contract, so a missing one is a definition
  // error: it renders the error state below, never a second way of choosing columns or controls.
  const contract = useMemo(() => readRecordsTableContract(settings), [settings]);
  const presentation = useTablePresentation(contract);
  const projectedColumns = values?.columns;
  const projectedHidden = values?.hiddenColumns;
  const columns = useMemo(
    () =>
      contract === undefined || projectedColumns === undefined
        ? []
        : carriedColumns(contract, projectedColumns),
    [contract, projectedColumns],
  );
  const declaredColumns = useMemo(
    () => [...(projectedColumns ?? []), ...(projectedHidden ?? [])],
    [projectedColumns, projectedHidden],
  );
  const layout = useGridLayout({
    contract,
    carried: columns,
    declared: declaredColumns,
    stored: values?.layout,
    events,
  });
  const loadedKeys = useMemo(
    () => new Set(columns.map((column) => column.key.toLowerCase())),
    [columns],
  );
  const rows = values?.rows ?? [];
  const selectionMode = contract?.selectionMode ?? "none";
  const selectable =
    events?.selection_changed !== undefined && contract !== undefined && selectionMode !== "none";
  const selectedRecordIds = values?.selectedRecordIds ?? [];
  const narrowing = values?.narrowing;
  const [message, announce] = useAnnouncer();
  const [clearCount, setClearCount] = useState(0);

  // Configured row behaviours: a row click, named row actions, bulk actions over the selection and
  // inline edit of permitted fields. Each declared control carries the stable identity of its own
  // flow binding, so one table placement can run several different flows.
  const behaviours = contract?.rowBehaviours;
  const rowClickEventId = behaviours?.rowClick?.eventId;
  const onRowClick = rowClickEventId === undefined ? undefined : events?.row_clicked;
  const activateRow = useMemo(
    () =>
      onRowClick === undefined || rowClickEventId === undefined
        ? undefined
        : (recordId: string): unknown =>
            onRowClick({ event: "row_clicked", eventId: rowClickEventId, recordId }),
    [onRowClick, rowClickEventId],
  );
  const declaredBulkActions = behaviours?.bulkActions ?? [];
  const showActions = (behaviours?.rowActions.length ?? 0) > 0 && events?.row_action !== undefined;
  const headingKey = layout.shown[0]?.key;

  // Cell, selection and command renderers shared by the grid and the cards. They change only with
  // the bindings and the heading column, so the grid's memoized rows keep their identity.
  const renderers = useMemo((): GridRenderers & CardRenderers => {
    const inlineEdit = behaviours?.inlineEdit;
    const onInlineEdit = inlineEdit === undefined ? undefined : events?.inline_edit;
    const rowActions = behaviours?.rowActions ?? [];
    // Only a text, link, number or yes/no cell of a field the row may change has a closed value
    // the editor can commit without guessing; any other cell stays read-only. The row revision
    // travels with the commit so the server refuses a stale change.
    const editable = (row: DisplayRow, columnKey: string, value: DisplayCellValue): boolean =>
      onInlineEdit !== undefined &&
      inlineEdit !== undefined &&
      inlineEdit.fields.some((field) => sameFieldKey(field, columnKey)) &&
      row.capabilities !== undefined &&
      row.capabilities.actions.includes("update") &&
      row.capabilities.changeableFieldIds.some((fieldId) => sameFieldKey(fieldId, columnKey)) &&
      (value.kind === "text" ||
        value.kind === "link" ||
        value.kind === "number" ||
        value.kind === "boolean");
    const value = (row: DisplayRow, column: GridColumn) => {
      const cell: DisplayCellValue = row.cells[column.key] ?? { kind: "empty" };
      return <DisplayCellView value={cell} />;
    };
    return {
      value,
      text: (row, column) => cellValueToText(row.cells[column.key] ?? { kind: "empty" }),
      cell: (row, column) => {
        const cell: DisplayCellValue = row.cells[column.key] ?? { kind: "empty" };
        if (
          onInlineEdit !== undefined &&
          inlineEdit !== undefined &&
          editable(row, column.key, cell)
        )
          return (
            // Keyed by the projected value so a refreshed row resets the editor.
            <InlineEditCell
              key={JSON.stringify(cell)}
              eventId={inlineEdit.eventId}
              recordId={row.recordId}
              {...(row.revision === undefined ? {} : { revision: row.revision })}
              field={column.key}
              label={column.label}
              value={cell.kind === "link" ? { kind: "text", text: cell.label } : cell}
              handler={onInlineEdit}
            />
          );
        return (
          <span className="min-w-0 truncate">
            <DisplayCellView value={cell} />
          </span>
        );
      },
      select: (row, selected) => (
        <SelectionControl
          row={row}
          name={rowName(row, headingKey)}
          selected={selected}
          mode={selectionMode === "single" ? "single" : "multiple"}
          groupName={`vortex-selection-${placementId}`}
          events={events}
        />
      ),
      selectAll: () => null,
      actions: (row) => (
        <RowActionsMenu
          recordId={row.recordId}
          {...(row.revision === undefined ? {} : { revision: row.revision })}
          name={rowName(row, headingKey)}
          actions={rowActions.filter((action) => rowShowsAction(row, action))}
          events={events}
        />
      ),
    };
  }, [behaviours, events, headingKey, placementId, selectionMode]);

  const pageRecordIds = rows.map((row) => row.recordId);
  const allSelected =
    pageRecordIds.length > 0 &&
    pageRecordIds.every((recordId) => selectedRecordIds.includes(recordId));
  const gridRenderers = useMemo(
    (): GridRenderers => ({
      ...renderers,
      selectAll: () => (
        <SelectAllControl
          allSelected={allSelected}
          recordIds={pageRecordIds}
          accessibleName={accessibleName}
          events={events}
        />
      ),
    }),
    // The page's record identities are part of `allSelected` and the rows' own identity.
    [renderers, allSelected, pageRecordIds.join("\u0000"), accessibleName, events],
  );

  // A bulk command that declares a capability stays disabled unless every selected row reports it.
  const bulkCapable = (capability: RecordsTableActionContract["capability"]): boolean => {
    if (capability === undefined) return true;
    if (selectedRecordIds.length === 0) return false;
    return selectedRecordIds.every(
      (recordId) =>
        rows
          .find((row) => row.recordId === recordId)
          ?.capabilities?.actions.includes(capability) === true,
    );
  };

  // Announcements: a new order or page of rows, and the selection count.
  const sortKeys = values?.sort?.keys;
  const sortSignature = JSON.stringify(sortKeys ?? []);
  const rowSignature = pageRecordIds.join("\u0000");
  const announced = useRef<{ sort: string; rows: string; selected: number } | undefined>(undefined);
  useEffect(() => {
    if (values === undefined) return;
    const previous = announced.current;
    announced.current = {
      sort: sortSignature,
      rows: rowSignature,
      selected: selectedRecordIds.length,
    };
    if (previous === undefined) return;
    const parts: string[] = [];
    if (previous.sort !== sortSignature) {
      const keys = sortKeys ?? [];
      const label = (fieldId: string): string =>
        columns.find((column) => sameFieldKey(column.key, fieldId))?.label ?? "another field";
      parts.push(
        keys.length === 0
          ? "Default order."
          : `Sorted by ${keys.map((key) => `${label(key.fieldId)}, ${key.direction}`).join(", then ")}.`,
      );
    }
    if (previous.rows !== rowSignature || previous.sort !== sortSignature)
      parts.push(rows.length === 1 ? "1 row shown." : `${rows.length} rows shown.`);
    if (previous.selected !== selectedRecordIds.length)
      parts.push(
        selectedRecordIds.length === 0
          ? "Selection cleared."
          : `${selectedRecordIds.length} selected.`,
      );
    if (parts.length > 0) announce(parts.join(" "));
  }, [
    values,
    sortSignature,
    rowSignature,
    selectedRecordIds.length,
    sortKeys,
    columns,
    rows.length,
    announce,
  ]);

  const revealed = useLoadingReveal(state.status === "loading");
  const showSearch = contract?.search === true && events?.search_changed !== undefined;
  // A filter is offered only for a configured filterable field the viewer can read: a field
  // withheld from the projection has no carried column, so it gets no control and its identity is
  // never shown as a label.
  const filterColumns =
    contract === undefined
      ? []
      : contract.filterableFields.flatMap((field) => {
          const column = layout.shown.find((candidate) => sameFieldKey(candidate.key, field));
          return column === undefined ? [] : [column];
        });
  const showFilters = events?.filter_changed !== undefined && filterColumns.length > 0;

  if (contract === undefined) {
    console.error("[display] Records table settings do not declare a readable contract", {
      placementId,
    });
    return (
      <DisplayStateContainer
        accessibleName={accessibleName}
        availability={availability}
        projectedData={{ status: "error" }}
        emptyMessage={emptyMessage}
        {...(errorMessage === undefined ? {} : { errorMessage })}
      >
        {null}
      </DisplayStateContainer>
    );
  }

  const ready = state.status === "ready" && values !== undefined;
  // The search and filter controls start from what the first shown page was read with, and start
  // again when the person clears them; their own commits keep the controls (and their focus).
  const controlsKey = `${clearCount}:${values === undefined ? "reading" : "read"}`;
  const filterValue = (key: string): string =>
    narrowing?.filters.find((filter) => sameFieldKey(filter.fieldId, key))?.value ?? "";
  const toolbar =
    !showSearch && !showFilters && !(ready && rows.length > 0) ? null : (
      <div className="mb-2 flex flex-wrap items-end gap-2" key={controlsKey}>
        {!showSearch ? null : (
          <SearchControl
            accessibleName={accessibleName}
            initialQuery={narrowing?.search ?? ""}
            events={events}
          />
        )}
        {!showFilters || state.status === "empty" ? null : (
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label={`Filters for ${accessibleName}`}
          >
            {filterColumns.map((column) => (
              <FilterControl
                key={column.key}
                field={column.key}
                label={column.label}
                input={filterInputKind(column.declared)}
                initialValue={filterValue(column.key)}
                events={events}
              />
            ))}
          </div>
        )}
        {!ready || rows.length === 0 ? null : (
          <div className="ms-auto flex flex-wrap items-center gap-2">
            {!selectable ||
            declaredBulkActions.length === 0 ||
            events?.bulk_action === undefined ? null : (
              <BulkActionsMenu
                accessibleName={accessibleName}
                actions={declaredBulkActions}
                recordIds={selectedRecordIds}
                canRun={(action) => bulkCapable(action.capability)}
                events={events}
              />
            )}
            <ColumnsMenu
              accessibleName={accessibleName}
              layout={layout}
              loadedKeys={loadedKeys}
              canRead={layout.persisted && events?.columns_changed !== undefined}
              announce={announce}
            />
          </div>
        )}
      </div>
    );
  const clearNarrowing = (): void => {
    setClearCount((count) => count + 1);
    if (narrowing?.search !== null && narrowing?.search !== undefined)
      void events?.search_changed?.({ event: "search_changed", query: "" });
    for (const filter of narrowing?.filters ?? [])
      void events?.filter_changed?.({ event: "filter_changed", field: filter.fieldId, value: "" });
  };
  const loading = (
    <TableLoadingState
      accessibleName={accessibleName}
      contract={contract}
      presentation={presentation ?? "grid"}
      selectionColumn={selectable}
      actionsColumn={showActions}
    />
  );

  const body = ((): ReactElement => {
    if (state.status === "loading") return loading;
    if (state.status === "empty")
      return <RecordsEmptyState accessibleName={accessibleName} message={emptyMessage} />;
    if (state.status === "error" || state.status === "refused")
      return (
        <div className="flex flex-col items-start gap-2">
          <DisplayStateContainer
            accessibleName={accessibleName}
            availability={availability}
            projectedData={state}
            emptyMessage={emptyMessage}
            {...(refusedMessage === undefined ? {} : { refusedMessage })}
            {...(errorMessage === undefined ? {} : { errorMessage })}
          >
            {null}
          </DisplayStateContainer>
          {state.status !== "error" || events?.refresh === undefined ? null : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void events.refresh?.({ event: "refresh" })}
            >
              Try again
            </Button>
          )}
        </div>
      );
    if (values === undefined) return loading;
    if (rows.length === 0)
      return (
        <Empty
          role="status"
          data-vortex-display-state={narrowed(narrowing) ? "no-match" : "empty"}
          className="border border-border text-muted-foreground"
          aria-label={`${accessibleName}: ${narrowed(narrowing) ? "no matches" : "empty"}`}
        >
          <EmptyHeader>
            <EmptyTitle>
              {narrowed(narrowing)
                ? "No records match the search or filters"
                : "No records on this page"}
            </EmptyTitle>
          </EmptyHeader>
          {!narrowed(narrowing) ? null : (
            <EmptyContent>
              <Button variant="outline" size="sm" onClick={clearNarrowing}>
                Clear search and filters
              </Button>
            </EmptyContent>
          )}
        </Empty>
      );
    // The viewport is unknown while the server renders and the page hydrates: the declared
    // skeleton stands in until the one presentation that fits is known.
    if (presentation === undefined) return loading;
    return presentation === "cards" ? (
      <RecordsCards
        accessibleName={accessibleName}
        columns={layout.shown}
        rows={rows}
        selectedRecordIds={selectedRecordIds}
        selectable={selectable}
        showActions={showActions}
        activateRow={activateRow}
        renderers={renderers}
      />
    ) : (
      <RecordsGrid
        accessibleName={accessibleName}
        contract={contract}
        layout={layout}
        rows={rows}
        sort={values.sort}
        selection={selectable ? (selectionMode === "single" ? "single" : "multiple") : undefined}
        selectedRecordIds={selectedRecordIds}
        showActions={showActions}
        events={events}
        activateRow={activateRow}
        renderers={gridRenderers}
        announce={announce}
      />
    );
  })();

  return (
    <div
      data-vortex-display="table"
      data-vortex-placement-id={placementId}
      data-vortex-table-density={layout.density}
      {...(revealed ? { "data-vortex-display-revealed": "" } : {})}
    >
      <DisplayHeader
        title={title}
        accessibleName={accessibleName}
        events={state.status === "empty" ? undefined : events}
      />
      {state.status === "refused" || state.status === "error" ? null : toolbar}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {message}
      </div>
      {ready && availability === "unavailable" ? (
        <DisplayStateContainer
          accessibleName={accessibleName}
          availability={availability}
          projectedData={state}
          emptyMessage={emptyMessage}
        >
          {body}
        </DisplayStateContainer>
      ) : (
        body
      )}
      {!ready || values === undefined ? null : (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="m-0 text-xs text-muted-foreground tabular-nums">
            {values.page === undefined ? "" : `Page ${values.page} · `}
            {rows.length === 1 ? "1 row" : `${rows.length} rows`}
          </p>
          <PaginationControl
            page={values.page}
            pageCount={values.pageCount}
            {...(values.hasNextPage === undefined ? {} : { hasNextPage: values.hasNextPage })}
            {...(values.nextContinuationToken === undefined
              ? {}
              : { nextContinuationToken: values.nextContinuationToken })}
            {...(values.hasPreviousPage === undefined
              ? {}
              : { hasPreviousPage: values.hasPreviousPage })}
            {...(values.previousContinuationToken === undefined
              ? {}
              : { previousContinuationToken: values.previousContinuationToken })}
            accessibleName={accessibleName}
            events={events}
          />
        </div>
      )}
    </div>
  );
}
