"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  readRecordsTableContract,
  type RecordsTableActionContract,
  type RecordsTableContract,
} from "@vortex/platform/schema";
import { Button } from "../components/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "../components/empty";
import { cn } from "../lib/utils";
import { cellValueToText, DisplayCellView } from "./cell";
import {
  DisplayHeader,
  PaginationControl,
  RecordsEmptyState,
  RowActionsMenu,
  SelectAllControl,
  SelectionControl,
} from "./controls";
import { useGridFeatures, type GridFeatureContext } from "./grid-features/registry";
import { FULL_SCREEN_CLASS, GridToolbar, useGridFullScreen } from "./grid-features/toolbar";
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
import { useGridLayout, type GridColumn } from "./table-layout";
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
  // The grid features this viewer may use on this read, as the server projected them. While the
  // next page is being read the last projection stays, so the search box and filters keep focus.
  const lastFeatures = useRef(values?.features);
  if (values !== undefined) lastFeatures.current = values.features;
  const features = lastFeatures.current;
  // Rows are selectable only for bulk commands over the selection.
  const selectable =
    events?.selection_changed !== undefined &&
    contract !== undefined &&
    features?.bulkActions !== undefined;
  const selectedRecordIds = values?.selectedRecordIds ?? [];
  const narrowing = values?.narrowing;
  const [message, announce] = useAnnouncer();
  const [clearCount, setClearCount] = useState(0);

  // The optional grid features draw through their extension points; each feature's code loads only
  // when the projection turns it on.
  const featureContext = useMemo(
    (): GridFeatureContext | undefined =>
      features === undefined
        ? undefined
        : {
            accessibleName,
            features,
            pins: layout.state.pins,
            setPin: layout.setPin,
            columns: layout.shown,
            rows,
            selectedRecordIds,
            narrowing,
            sort: values?.sort,
            arrangement: layout.arrangement,
            views: values?.layout.views,
            events,
          },
    [
      accessibleName,
      features,
      layout.state.pins,
      layout.setPin,
      layout.shown,
      layout.arrangement,
      rows,
      selectedRecordIds,
      narrowing,
      values?.sort,
      values?.layout.views,
      events,
    ],
  );
  const gridFeatures = useGridFeatures(featureContext);
  const {
    cell: featureCell,
    decorate,
    cellClassName,
    headerAdornment,
    columnMenuItems,
  } = gridFeatures;
  // Full screen keeps this same tree and changes only the container classes.
  const containerRef = useRef<HTMLDivElement>(null);
  const fullScreen = useGridFullScreen(containerRef, contract?.allowFullScreen === true, announce);

  // Configured row behaviours: a row click and named row actions. Each declared control carries
  // the stable identity of its own flow binding, so one table placement can run several flows.
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
  const showActions = (behaviours?.rowActions.length ?? 0) > 0 && events?.row_action !== undefined;
  const headingKey = layout.shown[0]?.key;

  // Cell, selection and command renderers shared by the grid and the cards. They change only with
  // the bindings and the heading column, so the grid's memoized rows keep their identity.
  const renderers = useMemo((): GridRenderers & CardRenderers => {
    const rowActions = behaviours?.rowActions ?? [];
    // Cards show the same formatting as the grid, never its editors.
    const value = (row: DisplayRow, column: GridColumn) => {
      const cell: DisplayCellValue = row.cells[column.key] ?? { kind: "empty" };
      return decorate(row, column, <DisplayCellView value={cell} />);
    };
    return {
      value,
      heading: (row, column) =>
        decorate(row, column, cellValueToText(row.cells[column.key] ?? { kind: "empty" })),
      cell: (row, column) => {
        const cell: DisplayCellValue = row.cells[column.key] ?? { kind: "empty" };
        const decoration = cellClassName(row, column);
        return featureCell(
          row,
          column,
          <span
            className={
              decoration === undefined ? "min-w-0 truncate" : `min-w-0 truncate ${decoration}`
            }
          >
            <DisplayCellView value={cell} />
          </span>,
        );
      },
      headerAdornment,
      columnMenuItems,
      select: (row, selected) => (
        <SelectionControl
          row={row}
          name={rowName(row, headingKey)}
          selected={selected}
          mode="multiple"
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
  }, [
    behaviours,
    events,
    headingKey,
    placementId,
    featureCell,
    decorate,
    cellClassName,
    headerAdornment,
    columnMenuItems,
  ]);

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
  const layoutControls =
    !ready || rows.length === 0
      ? undefined
      : {
          layout,
          loadedKeys,
          canRead: layout.persisted && events?.columns_changed !== undefined,
          announce,
        };
  const allowFullScreen = contract.allowFullScreen;
  const toolbar =
    gridFeatures.keys.length === 0 && layoutControls === undefined && !allowFullScreen ? null : (
      <GridToolbar
        key={controlsKey}
        accessibleName={accessibleName}
        featureItems={state.status === "empty" ? null : gridFeatures.toolbarItems()}
        selectionBanner={
          layoutControls !== undefined && selectable ? gridFeatures.selectionBanner() : null
        }
        layoutControls={layoutControls}
        fullScreen={allowFullScreen ? fullScreen : undefined}
      />
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
    if (state.status === "error" || state.status === "refused" || state.status === "awaiting_input")
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
        fill={fullScreen.active}
      />
    ) : (
      <RecordsGrid
        accessibleName={accessibleName}
        contract={contract}
        layout={layout}
        rows={rows}
        sort={values.sort}
        selection={selectable ? "multiple" : undefined}
        selectedRecordIds={selectedRecordIds}
        showActions={showActions}
        events={events}
        activateRow={activateRow}
        renderers={gridRenderers}
        announce={announce}
        fill={fullScreen.active}
      />
    );
  })();

  return (
    <div
      ref={containerRef}
      data-vortex-display="table"
      data-vortex-placement-id={placementId}
      data-vortex-table-density={layout.density}
      {...(fullScreen.active ? { "data-vortex-full-screen": "" } : {})}
      className={cn(fullScreen.active && FULL_SCREEN_CLASS)}
      {...(revealed ? { "data-vortex-display-revealed": "" } : {})}
    >
      <DisplayHeader
        title={title}
        accessibleName={accessibleName}
        events={state.status === "empty" ? undefined : events}
      />
      {state.status === "refused" || state.status === "error" || state.status === "awaiting_input"
        ? null
        : toolbar}
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
        <div className="mt-2 flex shrink-0 flex-wrap items-center justify-between gap-2">
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
