"use client";

import {
  lazy,
  memo,
  Fragment,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type Header,
  type RowSelectionState,
  type SortingState,
  type Updater,
} from "@tanstack/react-table";
import {
  RECORDS_TABLE_UNVIRTUALIZED_ROW_LIMIT,
  nextRecordsTableSort,
  type RecordsTableContract,
  type RecordsTableSortState,
} from "@vortex/platform/schema";
import { Card } from "../components/card";
import { ColumnMenu } from "./grid-features/column-menu";
import { Icon } from "../icons/icon";
import { cn } from "../lib/utils";
import type { DisplayEventHandlers, DisplayRow } from "./projected-data";
import { useRowEntrance } from "./row-entrance";
import type { RowExpansionControls } from "./row-expansion";
import { RowExpansionToggle } from "./row-expansion-toggle";
import {
  BOUNDED_VIEWPORT_CLASS,
  GRID_COLUMN_MAX_WIDTH,
  GRID_COLUMN_MIN_WIDTH,
  GRID_CONTROL_COLUMN_WIDTH,
  GRID_ROW_HEIGHT,
  virtualizesRows,
} from "./table-geometry";
import type { GridColumn, GridLayoutControls } from "./table-layout";
import {
  ACTIONS_COLUMN,
  EXPAND_COLUMN,
  SELECT_COLUMN,
  pinStyle,
  sizeVariable,
  useGridPinning,
} from "./table-pinning";

/** TanStack Virtual loads only for a table whose page can hold more than one hundred rows. */
const loadVirtualRows = () => import("./table-grid-virtual");
const VirtualRows = lazy(loadVirtualRows);

const RESIZE_STEP = 16;

/** Controls inside a cell keep their own meaning: a click or key on one never opens the row. */
const INTERACTIVE_IN_ROW =
  "a,button,input,select,textarea,label,summary,[role='button'],[role='checkbox'],[role='radio'],[role='menuitem'],[role='switch'],[contenteditable='true']";
/** An expanded row's panel of related records: its controls follow the row in the tab order. */
const PANEL = "[data-grid-panel]";
/** Every element inside a cell that would otherwise be its own tab stop. */
const INNER_FOCUSABLE =
  "a[href],button,input,select,textarea,[contenteditable='true'],[tabindex]:not([data-grid-cell])";

const isInteractiveTarget = (target: EventTarget, row: HTMLElement): boolean => {
  if (!(target instanceof Element)) return false;
  const control = target.closest(INTERACTIVE_IN_ROW);
  return control !== null && control !== row && row.contains(control);
};

const sameFieldKey = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

/** The cell the roving tab stop is on, by record and column identity; a null record is the header. */
type ActiveCell = Readonly<{ recordId: string | null; columnId: string }>;

/** One rendered column of the grid, in visible order, with everything a row needs to draw it. */
type CellSlot = Readonly<{
  id: string;
  kind: "expand" | "select" | "data" | "actions";
  column: GridColumn | undefined;
  style: CSSProperties;
  sticky: boolean;
}>;

/** Content renderers the host supplies; the grid places them and owns only focus and layout. */
export type GridRenderers = Readonly<{
  cell: (row: DisplayRow, column: GridColumn) => ReactNode;
  /** What the projected grid features draw after a column's heading (for example a filter mark). */
  headerAdornment?: (column: GridColumn) => ReactNode;
  /** The items the projected grid features add to a column's menu. */
  columnMenuItems?: (column: GridColumn) => ReactNode;
  select: (row: DisplayRow, selected: boolean) => ReactNode;
  selectAll: () => ReactNode;
  actions: (row: DisplayRow) => ReactNode;
}>;

export type RecordsGridProps = Readonly<{
  accessibleName: string;
  contract: RecordsTableContract;
  layout: GridLayoutControls;
  rows: readonly DisplayRow[];
  sort: RecordsTableSortState | undefined;
  selection: "single" | "multiple" | undefined;
  selectedRecordIds: readonly string[];
  showActions: boolean;
  events: DisplayEventHandlers | undefined;
  activateRow: ((recordId: string) => unknown) | undefined;
  renderers: GridRenderers;
  announce: (message: string) => void;
  /** Rows expand to a panel of related records; undefined when no projected feature draws one. */
  expansion: RowExpansionControls | undefined;
  /** The name a row is announced and labelled by. */
  rowName: (row: DisplayRow) => string;
  /** The table fills the screen: the grid takes the remaining height instead of its bound. */
  fill: boolean;
}>;

const cellAlignment = (column: GridColumn | undefined): string => {
  switch (column?.declared.alignment) {
    case "center":
      return "justify-center text-center";
    case "end":
      return "justify-end text-end";
    default:
      return "justify-start text-start";
  }
};

/**
 * One data row. Rows are memoized by their record and their focus/selection/expansion state;
 * column widths are CSS variables of the grid, so resizing a column re-renders no row. The same row
 * renders a normal page and a virtualized window, where its wrapper places it.
 */
const GridRow = memo(function GridRow({
  row,
  index,
  slots,
  rowHeight,
  selected,
  selectable,
  activeColumnId,
  pending,
  activatable,
  renderers,
  onActivate,
  expanded,
  name,
  panelId,
  onToggle,
}: Readonly<{
  row: DisplayRow;
  index: number;
  slots: readonly CellSlot[];
  rowHeight: number;
  selected: boolean;
  selectable: boolean;
  activeColumnId: string | undefined;
  pending: boolean;
  activatable: boolean;
  renderers: GridRenderers;
  onActivate: (recordId: string) => void;
  expanded: boolean;
  name: string;
  panelId: string | undefined;
  onToggle: (recordId: string) => void;
}>): ReactElement {
  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      {...(selectable ? { "aria-selected": selected } : {})}
      {...(pending ? { "aria-busy": true } : {})}
      {...(panelId === undefined ? {} : { "aria-expanded": expanded })}
      id={`record-${row.recordId}`}
      data-vortex-record-id={row.recordId}
      data-state={selected ? "selected" : undefined}
      className={cn(
        "group/row flex w-full border-b bg-card transition-colors last:border-b-0 hover:bg-muted data-[state=selected]:bg-muted",
        expanded && "border-b-0",
        activatable && "cursor-pointer",
        pending && "cursor-progress opacity-60",
      )}
      style={{ height: rowHeight }}
      onClick={(event: MouseEvent<HTMLDivElement>) => {
        if (!activatable || isInteractiveTarget(event.target, event.currentTarget)) return;
        onActivate(row.recordId);
      }}
    >
      {slots.map((slot, column) => (
        <div
          key={slot.id}
          role="gridcell"
          aria-colindex={column + 1}
          data-grid-cell=""
          data-row={index}
          data-col={slot.id}
          tabIndex={activeColumnId === slot.id ? 0 : -1}
          className={cn(
            "flex min-w-0 items-center overflow-hidden px-2 whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            "scroll-mt-[var(--grid-row-height)]",
            slot.kind === "data" && cellAlignment(slot.column),
            slot.kind !== "data" && "justify-center",
            slot.sticky &&
              "sticky z-10 bg-card group-hover/row:bg-muted group-data-[state=selected]/row:bg-muted",
          )}
          style={slot.style}
        >
          {slot.kind === "expand" ? (
            panelId === undefined ? null : (
              <RowExpansionToggle
                name={name}
                expanded={expanded}
                panelId={panelId}
                onToggle={() => onToggle(row.recordId)}
              />
            )
          ) : slot.kind === "select" ? (
            renderers.select(row, selected)
          ) : slot.kind === "actions" ? (
            renderers.actions(row)
          ) : slot.column === undefined ? null : (
            renderers.cell(row, slot.column)
          )}
        </div>
      ))}
    </div>
  );
});

/**
 * The panel of an expanded row: one full-width cell below the row holding its related records. It
 * stays at the left of the scroll area, so a wide grid scrolled sideways still shows it.
 */
const GridRowPanel = ({
  row,
  index,
  columnCount,
  panelId,
  name,
  children,
}: Readonly<{
  row: DisplayRow;
  index: number;
  columnCount: number;
  panelId: string;
  name: string;
  children: ReactNode;
}>): ReactElement => (
  <div role="row" data-vortex-related-of={row.recordId} className="flex w-full border-b bg-card">
    <div
      role="gridcell"
      aria-colspan={columnCount}
      id={panelId}
      aria-label={`Related records of ${name}`}
      data-grid-panel=""
      data-row={index}
      className="sticky left-0 w-full min-w-0 bg-muted/40 px-3 py-2"
    >
      {children}
    </div>
  </div>
);

/**
 * The Records table's desktop presentation: an accessible data grid over exactly the permitted
 * page the host supplied. TanStack Table holds the controlled column state (order, widths), the
 * sort the page was read in and the selection; sorting, filtering, paging and the shown columns
 * stay on the server (`manual*`), so no client row model ever reorders or narrows the rows. A page
 * of more than one hundred rows mounts only its visible window through TanStack Virtual (a lazy
 * chunk), at the fixed row height of the authored density, and reads nothing more.
 *
 * Keyboard: the grid is one tab stop. Arrows, Home/End, Ctrl+Home/End and PageUp/PageDown move
 * between cells of the loaded page; Enter or F2 enters a cell's controls, Escape returns to the
 * cell, Tab leaves the grid. Enter or Alt+Down on a column heading opens its menu (Escape closes it
 * and returns to the heading), Shift+Enter adds the column to the sort; Enter on a plain cell opens
 * the row, Space selects it. Alt+Left/Right resizes a header's column and Alt+Shift+Left/Right
 * moves it. Focus follows the record and column through a refresh.
 */
export function RecordsGrid({
  accessibleName,
  contract,
  layout,
  rows,
  sort,
  selection,
  selectedRecordIds,
  showActions,
  events,
  activateRow,
  renderers,
  announce,
  expansion,
  rowName,
  fill,
}: RecordsGridProps): ReactElement {
  const rowHeight = GRID_ROW_HEIGHT[layout.density];
  const virtual = virtualizesRows(rows.length);
  const bounded = contract.viewport === "bounded";
  const { columns } = layout;
  const columnsById = useMemo(
    () => new Map(columns.map((column) => [column.key, column])),
    [columns],
  );

  // Column definitions change only with the requested columns; widths and order are controlled
  // state, so a layout change never rebuilds them.
  const selectable = selection !== undefined;
  const expandable = expansion !== undefined;
  const definitions = useMemo<ColumnDef<DisplayRow>[]>(
    () => [
      ...(expandable
        ? [
            {
              id: EXPAND_COLUMN,
              size: GRID_CONTROL_COLUMN_WIDTH,
              enableResizing: false,
              enableHiding: false,
            },
          ]
        : []),
      ...(selectable
        ? [
            {
              id: SELECT_COLUMN,
              size: GRID_CONTROL_COLUMN_WIDTH,
              enableResizing: false,
              enableHiding: false,
            },
          ]
        : []),
      ...columns.map((column): ColumnDef<DisplayRow> => ({
        id: column.key,
        accessorFn: (row) => row.cells[column.key],
        size: column.width,
        minSize: GRID_COLUMN_MIN_WIDTH,
        maxSize: GRID_COLUMN_MAX_WIDTH,
        enableSorting: column.sortable,
      })),
      ...(showActions
        ? [
            {
              id: ACTIONS_COLUMN,
              size: GRID_CONTROL_COLUMN_WIDTH,
              enableResizing: false,
              enableHiding: false,
            },
          ]
        : []),
    ],
    [columns, expandable, selectable, showActions],
  );
  const sorting = useMemo<SortingState>(
    () =>
      (sort?.keys ?? []).flatMap((key) => {
        const column = columns.find((candidate) => sameFieldKey(candidate.key, key.fieldId));
        return column === undefined
          ? []
          : [{ id: column.key, desc: key.direction === "descending" }];
      }),
    [columns, sort],
  );
  const rowSelection = useMemo<RowSelectionState>(
    () => Object.fromEntries(selectedRecordIds.map((recordId) => [recordId, true])),
    [selectedRecordIds],
  );
  const columnOrder = useMemo(
    () => [EXPAND_COLUMN, SELECT_COLUMN, ...layout.state.order, ACTIONS_COLUMN],
    [layout.state.order],
  );
  const { setWidths } = layout;
  const onColumnSizingChange = useCallback(
    (updater: Updater<Readonly<Record<string, number>>>) =>
      setWidths((current) => (typeof updater === "function" ? updater(current) : updater)),
    [setWidths],
  );
  const table = useReactTable<DisplayRow>({
    data: rows as DisplayRow[],
    columns: definitions,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.recordId,
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    enableMultiSort: true,
    enableRowSelection: selectable,
    columnResizeMode: "onChange",
    state: {
      sorting,
      rowSelection,
      columnOrder,
      columnSizing: layout.state.widths,
    },
    onColumnSizingChange: onColumnSizingChange as never,
  });
  const visibleColumns = table.getVisibleLeafColumns();
  const visibleIds = visibleColumns.map((column) => column.id);
  const visibleSignature = visibleIds.join("\u0000");
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinning = contract.features.pinning.enabled;
  const pinSignature = visibleIds.map((id) => layout.state.pins[id.toLowerCase()]).join(",");
  const pinningStyle = useGridPinning(
    scrollRef,
    layout,
    pinning,
    selectable,
    showActions,
    expandable,
  );

  // Rows draw their cells from these slots; a slot changes only with the visible column set, never
  // with a width, so a resize repaints only the grid's width variables.
  const slots = useMemo<readonly CellSlot[]>(
    () =>
      visibleSignature.split("\u0000").flatMap((id): CellSlot[] => {
        if (id === "") return [];
        const kind =
          id === EXPAND_COLUMN
            ? "expand"
            : id === SELECT_COLUMN
              ? "select"
              : id === ACTIONS_COLUMN
                ? "actions"
                : "data";
        // The expand and select columns pin at the start, expand first; actions pin at the end.
        const pin =
          kind === "expand" || kind === "select"
            ? "start"
            : kind === "actions"
              ? "end"
              : layout.state.pins[id.toLowerCase()];
        const sticky = pinning && (pin === "start" || pin === "end");
        return [
          {
            id,
            kind,
            column: kind === "data" ? columnsById.get(id) : undefined,
            sticky,
            style: {
              flex:
                kind === "data"
                  ? `var(${sizeVariable(id)}) 0 calc(var(${sizeVariable(id)}) * 1px)`
                  : `0 0 ${GRID_CONTROL_COLUMN_WIDTH}px`,
              ...(sticky ? pinStyle(id, pin as "start" | "end") : {}),
            },
          },
        ];
      }),
    [visibleSignature, pinSignature, pinning, columnsById],
  );
  const sizeStyle = useMemo(() => {
    const style: Record<string, string | number> = { "--grid-row-height": `${rowHeight}px` };
    for (const column of visibleColumns) style[sizeVariable(column.id)] = column.getSize();
    return style as CSSProperties;
    // The sizes come from the controlled widths; the column objects carry them.
  }, [visibleSignature, layout.state.widths, rowHeight]);
  const totalWidth = table.getTotalSize();

  // The roving tab stop, kept by record and column identity so it survives a refresh.
  const [active, setActive] = useState<ActiveCell>(() => ({
    recordId: null,
    columnId: visibleIds[0] ?? "",
  }));
  const [controlMode, setControlMode] = useState(false);
  /** The column whose heading menu is open. */
  const [menuColumnId, setMenuColumnId] = useState<string | undefined>(undefined);
  const [pendingRecordId, setPendingRecordId] = useState<string | undefined>(undefined);
  const lastPosition = useRef({ row: -1, column: 0 });
  const focusRequested = useRef(false);
  const gridHasFocus = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);

  const rowIndexOf = (recordId: string | null): number =>
    recordId === null ? -1 : rows.findIndex((row) => row.recordId === recordId);
  const activeRow = rowIndexOf(active.recordId);
  const activeColumn = visibleIds.indexOf(active.columnId);
  const activeRowRef = useRef(activeRow);
  activeRowRef.current = activeRow;
  const activeColumnIdRef = useRef(active.columnId);
  activeColumnIdRef.current = active.columnId;

  // A record or column that left the page moves the tab stop to the nearest valid cell, and says so.
  useEffect(() => {
    const lostRow = active.recordId !== null && activeRow < 0;
    const lostColumn = activeColumn < 0;
    if (!lostRow && !lostColumn) {
      lastPosition.current = { row: activeRow, column: activeColumn };
      return;
    }
    const row = lostRow ? Math.min(lastPosition.current.row, rows.length - 1) : activeRow;
    const column = Math.max(0, Math.min(lastPosition.current.column, visibleIds.length - 1));
    const next: ActiveCell = {
      recordId: row < 0 ? null : (rows[row]?.recordId ?? null),
      columnId: visibleIds[column] ?? "",
    };
    setActive(next);
    if (gridHasFocus.current) {
      focusRequested.current = true;
      if (lostRow)
        announce(
          row < 0
            ? "The focused row is no longer shown; focus moved to the column headers"
            : `The focused row is no longer shown; focus moved to row ${row + 1} of ${rows.length}`,
        );
    }
  }, [active.recordId, activeRow, activeColumn, rows, visibleIds, announce]);

  // A table whose page can hold more than one hundred rows fetches the virtual body ahead of need.
  const mayVirtualize = contract.pageSize > RECORDS_TABLE_UNVIRTUALIZED_ROW_LIMIT;
  useEffect(() => {
    if (mayVirtualize) void loadVirtualRows();
  }, [mayVirtualize]);

  const cellElement = (row: number, columnId: string): HTMLElement | null =>
    gridRef.current?.querySelector<HTMLElement>(
      `[data-grid-cell][data-row="${row}"][data-col="${CSS.escape(columnId)}"]`,
    ) ?? null;

  // Moves real focus to the tab stop after the render that placed it. The destination is mounted
  // (the window always holds the active row); focusing scrolls it into view below the sticky header
  // (its scroll margin), and the window then follows the scroll.
  useLayoutEffect(() => {
    if (!focusRequested.current) return;
    focusRequested.current = false;
    if (activeColumn >= 0) {
      const element = cellElement(activeRow, active.columnId);
      element?.scrollIntoView({ block: "nearest", inline: "nearest" });
      element?.focus({ preventScroll: true });
    }
  });

  // Only the active cell is a tab stop; its controls join the tab order only in control mode. The
  // panel of the active row's related records follows it, so Tab moves into that panel.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (grid === null) return;
    for (const element of grid.querySelectorAll<HTMLElement>(INNER_FOCUSABLE)) {
      const panel = element.closest<HTMLElement>(PANEL);
      const cell = element.closest<HTMLElement>("[data-grid-cell]");
      const open =
        panel !== null
          ? panel.dataset.row === String(activeRow)
          : controlMode &&
            cell !== null &&
            cell.dataset.row === String(activeRow) &&
            cell.dataset.col === active.columnId;
      const tabIndex = open ? 0 : -1;
      if (element.tabIndex !== tabIndex) element.tabIndex = tabIndex;
    }
  });

  // A refresh that removed the focused element (a reset editor, say) while the grid had focus puts
  // focus back on the tab stop.
  useEffect(() => {
    if (!gridHasFocus.current) return;
    const focused = document.activeElement;
    if (focused === null || focused === document.body)
      cellElement(activeRowRef.current, activeColumnIdRef.current)?.focus();
  }, [rows]);

  const moveTo = (row: number, column: number): void => {
    const clampedRow = Math.max(-1, Math.min(row, rows.length - 1));
    const clampedColumn = Math.max(0, Math.min(column, visibleIds.length - 1));
    setControlMode(false);
    setActive({
      recordId: clampedRow < 0 ? null : (rows[clampedRow]?.recordId ?? null),
      columnId: visibleIds[clampedColumn] ?? "",
    });
    focusRequested.current = true;
  };

  const runActivation = (recordId: string): void => {
    if (activateRow === undefined || pendingRecordId !== undefined) return;
    const outcome = activateRow(recordId);
    if (
      typeof outcome === "object" &&
      outcome !== null &&
      typeof (outcome as PromiseLike<unknown>).then === "function"
    ) {
      setPendingRecordId(recordId);
      const settle = (): void => setPendingRecordId(undefined);
      (outcome as PromiseLike<unknown>).then(settle, settle);
    }
  };
  const activateRef = useRef(runActivation);
  activateRef.current = runActivation;
  const onActivate = useCallback((recordId: string) => activateRef.current(recordId), []);
  const toggleRef = useRef(expansion?.toggle);
  toggleRef.current = expansion?.toggle;
  const onToggle = useCallback((recordId: string) => toggleRef.current?.(recordId), []);

  const sortBy = (columnId: string, additive: boolean): void => {
    const onSort = events?.sort_changed;
    const column = columnsById.get(columnId);
    if (onSort === undefined || column === undefined || !column.sortable) return;
    void onSort({ event: "sort_changed", sort: nextRecordsTableSort(sort, column.key, additive) });
  };

  const toggleSelection = (row: DisplayRow | undefined): void => {
    const onSelection = events?.selection_changed;
    if (row === undefined || onSelection === undefined || selection === undefined) return;
    const selected = selectedRecordIds.includes(row.recordId);
    if (selection === "single" && selected) return;
    void onSelection({ event: "selection_changed", recordId: row.recordId, selected: !selected });
  };
  const toggleAll = (): void => {
    const onSelection = events?.selection_changed;
    if (onSelection === undefined || selection !== "multiple") return;
    const all = rows.length > 0 && rows.every((row) => selectedRecordIds.includes(row.recordId));
    for (const row of rows)
      void onSelection({ event: "selection_changed", recordId: row.recordId, selected: !all });
  };

  const resizeBy = (columnId: string, delta: number): void => {
    const column = columnsById.get(columnId);
    if (column === undefined) return;
    const current = layout.state.widths[columnId] ?? column.width;
    const next = Math.max(GRID_COLUMN_MIN_WIDTH, Math.min(GRID_COLUMN_MAX_WIDTH, current + delta));
    setWidths((widths) => ({ ...widths, [columnId]: next }));
    layout.commit();
    announce(`${column.label} is ${next} pixels wide`);
  };
  const autoSize = (columnId: string, width: number): void => {
    const column = columnsById.get(columnId);
    if (column === undefined) return;
    setWidths((widths) => ({ ...widths, [columnId]: width }));
    layout.commit();
    announce(`${column.label} fitted to ${width} pixels`);
  };
  const hideColumn = (columnId: string): void => {
    const column = columnsById.get(columnId);
    if (column === undefined) return;
    const remaining = visibleIds.filter((id) => id !== columnId);
    const next = remaining[Math.min(visibleIds.indexOf(columnId), remaining.length - 1)];
    if (next !== undefined) {
      setActive({ recordId: null, columnId: next });
      focusRequested.current = true;
    }
    layout.setVisible(columnId, false);
    announce(`${column.label} hidden`);
  };
  const moveColumnBy = (columnId: string, offset: number): void => {
    const column = columnsById.get(columnId);
    const position = layout.moveColumn(columnId, offset);
    if (column !== undefined && position !== undefined)
      announce(`${column.label} moved to column ${position}`);
    focusRequested.current = true;
  };

  const pageStep = (): number => {
    const height = bounded
      ? (scrollRef.current?.clientHeight ?? window.innerHeight)
      : window.innerHeight;
    return Math.max(1, Math.floor(height / rowHeight) - 1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Keys from a portalled menu or from outside the grid are not grid navigation.
    if (!(event.target instanceof Node) || !gridRef.current?.contains(event.target)) return;
    // Inside a row's related records the panel's own controls take every key but Escape, which
    // returns to the row's expand toggle.
    const panel = (event.target as Element).closest<HTMLElement>(PANEL);
    if (panel !== null) {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        moveTo(Number(panel.dataset.row), visibleIds.indexOf(EXPAND_COLUMN));
      }
      return;
    }
    const cell = (event.target as Element).closest<HTMLElement>("[data-grid-cell]");
    if (cell === null) return;
    if (event.target !== cell) {
      // Control mode: the control owns every key but Escape, which returns to the cell.
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        setControlMode(false);
        cell.focus();
      }
      return;
    }
    const row = activeRow;
    const column = activeColumn < 0 ? 0 : activeColumn;
    const columnId = visibleIds[column] ?? "";
    const header = row < 0;
    const control = event.ctrlKey || event.metaKey;
    const handled = (): void => event.preventDefault();
    // On a row's expand toggle, Right or Enter opens its related records and Left or Enter closes
    // them; F2 moves into an open panel. Elsewhere the arrows move between cells as usual.
    const record = header ? undefined : rows[row];
    if (
      expansion !== undefined &&
      record !== undefined &&
      columnId === EXPAND_COLUMN &&
      !event.altKey &&
      !control
    ) {
      const open = expansion.isExpanded(record.recordId);
      if (
        event.key === "Enter" ||
        (event.key === "ArrowRight" && !open) ||
        (event.key === "ArrowLeft" && open)
      ) {
        handled();
        expansion.toggle(record.recordId);
        return;
      }
      if (event.key === "F2" && open) {
        handled();
        gridRef.current
          ?.querySelector<HTMLElement>(`${PANEL}[data-row="${row}"]`)
          ?.querySelector<HTMLElement>(INNER_FOCUSABLE)
          ?.focus();
        return;
      }
    }
    if (header && event.altKey && event.key === "ArrowDown") {
      handled();
      if (columnsById.has(columnId)) setMenuColumnId(columnId);
      return;
    }
    if (header && event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      handled();
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      if (event.shiftKey) moveColumnBy(columnId, direction);
      else resizeBy(columnId, direction * RESIZE_STEP);
      return;
    }
    switch (event.key) {
      case "ArrowRight":
        handled();
        moveTo(row, column + 1);
        return;
      case "ArrowLeft":
        handled();
        moveTo(row, column - 1);
        return;
      case "ArrowDown":
        handled();
        moveTo(row + 1, column);
        return;
      case "ArrowUp":
        handled();
        moveTo(row - 1, column);
        return;
      case "Home":
        handled();
        moveTo(control ? -1 : row, 0);
        return;
      case "End":
        handled();
        moveTo(control ? rows.length - 1 : row, visibleIds.length - 1);
        return;
      case "PageDown":
        handled();
        moveTo(row + pageStep(), column);
        return;
      case "PageUp":
        handled();
        moveTo(Math.max(0, row - pageStep()), column);
        return;
      case "Enter":
      case "F2": {
        handled();
        if (header && event.key === "Enter") {
          if (columnId === SELECT_COLUMN) toggleAll();
          else if (event.shiftKey) sortBy(columnId, true);
          else if (columnsById.has(columnId)) setMenuColumnId(columnId);
          return;
        }
        const target = cell.querySelector<HTMLElement>(INNER_FOCUSABLE);
        if (target !== null) {
          setControlMode(true);
          target.focus();
          return;
        }
        if (event.key === "Enter" && !header) {
          const record = rows[row];
          if (record !== undefined) runActivation(record.recordId);
        }
        return;
      }
      case " ":
        handled();
        if (header) {
          if (columnId === SELECT_COLUMN) toggleAll();
          return;
        }
        toggleSelection(rows[row]);
        return;
      default:
        return;
    }
  };

  const onFocus = (event: FocusEvent<HTMLDivElement>): void => {
    const target = event.target;
    // Focus inside a row's related records keeps that row's toggle as the tab stop, so the row
    // (and, in a virtualized page, its panel) stays mounted.
    const panel = target.closest<HTMLElement>(PANEL);
    if (panel !== null && gridRef.current?.contains(panel)) {
      gridHasFocus.current = true;
      const recordId = rows[Number(panel.dataset.row)]?.recordId ?? null;
      if (recordId !== active.recordId || active.columnId !== EXPAND_COLUMN)
        setActive({ recordId, columnId: EXPAND_COLUMN });
      setControlMode(false);
      return;
    }
    const cell = target.closest<HTMLElement>("[data-grid-cell]");
    if (cell === null || !gridRef.current?.contains(cell)) return;
    gridHasFocus.current = true;
    const row = Number(cell.dataset.row);
    const columnId = cell.dataset.col ?? "";
    const recordId = row < 0 ? null : (rows[row]?.recordId ?? null);
    if (recordId !== active.recordId || columnId !== active.columnId)
      setActive({ recordId, columnId });
    setControlMode(target !== cell);
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && gridRef.current?.contains(next)) return;
    if (next !== null) gridHasFocus.current = false;
    setControlMode(false);
  };

  // Header drag-and-drop reorder; the keyboard alternative is Alt+Shift+Left/Right.
  const dragged = useRef<string | undefined>(undefined);
  const onHeaderDrop = (event: DragEvent<HTMLDivElement>, targetId: string): void => {
    const source = dragged.current;
    dragged.current = undefined;
    if (source === undefined || source === targetId) return;
    event.preventDefault();
    const order = layout.state.order;
    const offset = order.indexOf(targetId) - order.indexOf(source);
    moveColumnBy(source, offset);
  };

  const rowsRef = useRowEntrance<HTMLDivElement>(
    virtual ? [] : rows.map((row) => row.recordId),
    "[role='row']",
  );
  const selectedSet = useMemo(() => new Set(selectedRecordIds), [selectedRecordIds]);
  const sortKeys = sort?.keys ?? [];
  const instructionsId = `${useId()}-grid-help`;
  const headerSlots = slots;

  const renderHeader = (
    header: Header<DisplayRow, unknown> | undefined,
    slot: CellSlot,
    index: number,
  ): ReactElement => {
    const column = slot.column;
    const priority =
      column === undefined
        ? -1
        : sortKeys.findIndex((key) => sameFieldKey(key.fieldId, column.key));
    const direction = priority < 0 ? undefined : sortKeys[priority]?.direction;
    const sortText =
      direction === undefined
        ? undefined
        : sortKeys.length === 1
          ? `sorted ${direction}`
          : `sorted ${direction}, sort priority ${priority + 1} of ${sortKeys.length}`;
    const sortable = column?.sortable === true && events?.sort_changed !== undefined;
    return (
      <div
        key={slot.id}
        role="columnheader"
        aria-colindex={index + 1}
        aria-sort={priority === 0 && direction !== undefined ? direction : undefined}
        data-grid-cell=""
        data-row={-1}
        data-col={slot.id}
        tabIndex={activeRow < 0 && active.columnId === slot.id ? 0 : -1}
        title={sortable ? "Sort; hold Shift to add to the sort" : undefined}
        className={cn(
          "relative flex min-w-0 items-center gap-1 overflow-hidden bg-muted px-2 text-xs font-medium whitespace-nowrap text-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          slot.kind === "data" ? cellAlignment(column) : "justify-center",
          sortable && "cursor-pointer hover:bg-muted/70",
          slot.sticky && "sticky z-30",
        )}
        style={slot.style}
        onClick={(event) => {
          if (sortable) sortBy(slot.id, event.shiftKey);
        }}
        onDragOver={(event) => {
          if (slot.kind === "data" && dragged.current !== undefined) event.preventDefault();
        }}
        onDrop={(event) => {
          if (slot.kind === "data") onHeaderDrop(event, slot.id);
        }}
      >
        {slot.kind === "select" ? (
          selection === "multiple" ? (
            renderers.selectAll()
          ) : (
            <span className="sr-only">Selected</span>
          )
        ) : slot.kind === "actions" ? (
          <span className="sr-only">Actions</span>
        ) : slot.kind === "expand" ? (
          <span className="sr-only">Related records</span>
        ) : (
          <>
            <span
              className="truncate"
              draggable
              onDragStart={(event) => {
                dragged.current = slot.id;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", column?.label ?? slot.id);
              }}
              onDragEnd={() => {
                dragged.current = undefined;
              }}
            >
              {column?.label}
            </span>
            {sortText === undefined ? null : <span className="sr-only">, {sortText}</span>}
            {direction === undefined ? null : (
              <Icon
                name={direction === "ascending" ? "arrow-up" : "arrow-down"}
                aria-hidden="true"
                className="size-3.5 shrink-0"
              />
            )}
            {direction === undefined || sortKeys.length < 2 ? null : (
              <span aria-hidden="true" className="text-muted-foreground tabular-nums">
                {priority + 1}
              </span>
            )}
            {column === undefined ? null : renderers.headerAdornment?.(column)}
            {column === undefined ? null : (
              <ColumnMenu
                column={column}
                open={menuColumnId === slot.id}
                onOpenChange={(open) => setMenuColumnId(open ? slot.id : undefined)}
                returnFocus={() =>
                  cellElement(-1, slot.id) ?? cellElement(-1, activeColumnIdRef.current)
                }
                sort={sort}
                sortable={sortable}
                onSort={(keys) =>
                  void events?.sort_changed?.({ event: "sort_changed", sort: keys })
                }
                position={layout.state.order.indexOf(slot.id) + 1}
                shownCount={layout.state.order.length}
                onHide={() => hideColumn(slot.id)}
                onMove={(offset) => moveColumnBy(slot.id, offset)}
                grid={() => gridRef.current}
                onAutoSize={(width) => autoSize(slot.id, width)}
                featureItems={renderers.columnMenuItems?.(column)}
              />
            )}
            {header === undefined || !header.column.getCanResize() ? null : (
              <div
                aria-hidden="true"
                className={cn(
                  "absolute top-0 right-0 h-full w-1.5 cursor-col-resize touch-none border-e border-border select-none hover:bg-ring/50",
                  header.column.getIsResizing() && "bg-ring",
                )}
                // The width changes on screen while the pointer moves; it is stored once, when
                // the pointer is released.
                onMouseDown={(event) => {
                  header.getResizeHandler()(event);
                  document.addEventListener("mouseup", layout.commit, { once: true });
                }}
                onTouchStart={(event) => {
                  header.getResizeHandler()(event);
                  document.addEventListener("touchend", layout.commit, { once: true });
                }}
                onDoubleClick={() => {
                  header.column.resetSize();
                  layout.commit();
                }}
                onClick={(event) => event.stopPropagation()}
              />
            )}
          </>
        )}
      </div>
    );
  };

  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const headerById = new Map(headers.map((header) => [header.column.id, header]));

  // A row and, while it is expanded, the panel of its related records below it.
  const drawRow = (row: DisplayRow, index: number): ReactElement => {
    const expanded = expansion?.isExpanded(row.recordId) === true;
    const panelId = expansion?.panelId(row.recordId);
    const name = expansion === undefined ? "" : rowName(row);
    return (
      <Fragment key={row.recordId}>
        <GridRow
          row={row}
          index={index}
          slots={slots}
          rowHeight={rowHeight}
          selected={selectedSet.has(row.recordId)}
          selectable={selectable}
          activeColumnId={activeRow === index ? active.columnId : undefined}
          pending={pendingRecordId === row.recordId}
          activatable={activateRow !== undefined}
          renderers={renderers}
          onActivate={onActivate}
          expanded={expanded}
          name={name}
          panelId={panelId}
          onToggle={onToggle}
        />
        {!expanded || panelId === undefined || expansion === undefined ? null : (
          <GridRowPanel
            row={row}
            index={index}
            columnCount={slots.length}
            panelId={panelId}
            name={name}
          >
            {expansion.panel(row)}
          </GridRowPanel>
        )}
      </Fragment>
    );
  };

  return (
    // The frame is the theme's card (its radius, ring and surface); the grid scrolls inside it.
    <Card
      ref={scrollRef}
      style={pinningStyle.scrollPadding}
      data-slot="grid-viewport"
      data-vortex-grid-virtualized={virtual ? "" : undefined}
      className={cn(
        "relative max-w-full gap-0 overflow-auto py-0",
        fill ? "min-h-0 flex-1" : bounded && BOUNDED_VIEWPORT_CLASS,
      )}
    >
      <span id={instructionsId} className="sr-only">
        Use the arrow keys to move between cells. Enter opens a row or uses the controls in a cell,
        F2 edits them and Escape returns to the cell. Space selects a row.{" "}
        {expansion === undefined
          ? null
          : "On a row's expand button, the right arrow shows its related records and the left arrow hides them; F2 or Tab moves into them and Escape returns to the row. "}
        On a column heading, Enter or Alt with the down arrow opens the column menu, Shift and Enter
        adds to the sort, Alt with the left or right arrow resizes the column and Alt, Shift with
        the left or right arrow moves it.
      </span>
      <div
        ref={gridRef}
        role="grid"
        aria-label={accessibleName}
        aria-describedby={instructionsId}
        aria-rowcount={rows.length + 1}
        aria-colcount={slots.length}
        {...(selection === "multiple" ? { "aria-multiselectable": true } : {})}
        className="text-sm"
        style={{ ...sizeStyle, ...pinningStyle.variables, width: totalWidth, minWidth: "100%" }}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        <div
          role="rowgroup"
          className={cn(contract.stickyHeader && bounded && "sticky top-0 z-20")}
        >
          <div
            role="row"
            aria-rowindex={1}
            className="flex w-full border-b bg-muted"
            style={{ height: rowHeight }}
          >
            {headerSlots.map((slot, index) => renderHeader(headerById.get(slot.id), slot, index))}
          </div>
        </div>
        {virtual ? (
          <Suspense
            // Until the virtual body arrives, the rows' full height keeps the real scroll range.
            fallback={<div role="rowgroup" style={{ height: rows.length * rowHeight }} />}
          >
            <VirtualRows
              expandedRecordIds={expansion?.expandedRecordIds}
              rows={rows}
              rowHeight={rowHeight}
              activeRow={activeRow}
              stickyHeader={contract.stickyHeader}
              scrollRef={scrollRef}
              drawRow={drawRow}
            />
          </Suspense>
        ) : (
          <div ref={rowsRef} role="rowgroup">
            {rows.map((row, index) => drawRow(row, index))}
          </div>
        )}
      </div>
    </Card>
  );
}
