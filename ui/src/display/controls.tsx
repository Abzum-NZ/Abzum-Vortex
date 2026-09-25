"use client";

import { useId, useState, type ReactElement } from "react";
import type {
  DisplayCellValue,
  DisplayEventHandler,
  DisplayEventHandlers,
  DisplayRow,
} from "./projected-data";

/** Optional authored title with a refresh control bound to the declared `refresh` event. */
export function DisplayHeader({
  title,
  accessibleName,
  events,
}: Readonly<{
  title: string | undefined;
  accessibleName: string;
  events: DisplayEventHandlers | undefined;
}>): ReactElement | null {
  const refresh = events?.refresh;
  if (title === undefined && refresh === undefined) return null;
  return (
    <div className="vortex-display-header">
      {title === undefined ? null : <h2 className="vortex-display-title">{title}</h2>}
      {refresh === undefined ? null : (
        <button
          type="button"
          className="vortex-button-refresh"
          aria-label={`Refresh ${accessibleName}`}
          onClick={() => refresh({ event: "refresh" })}
        >
          Refresh
        </button>
      )}
    </div>
  );
}

/**
 * The per-row selection control bound to the declared `selection_changed` event and stable record
 * identity. `multiple` renders a checkbox; `single` renders a radio whose `groupName` scopes its
 * group to one table, so choosing another row replaces the choice. It only reports the viewer's
 * choice; the host owns the selection and the projected `selectedRecordIds`.
 */
export function SelectionControl({
  row,
  name,
  selected,
  mode = "multiple",
  groupName,
  events,
}: Readonly<{
  row: DisplayRow;
  name: string;
  selected: boolean;
  mode?: "single" | "multiple";
  groupName?: string;
  events: DisplayEventHandlers | undefined;
}>): ReactElement | null {
  const onSelection = events?.selection_changed;
  if (onSelection === undefined) return null;
  if (mode === "single")
    return (
      <input
        type="radio"
        className="vortex-selection-radio"
        name={groupName}
        aria-label={`Select ${name}`}
        checked={selected}
        onClick={(event) => event.stopPropagation()}
        onChange={() =>
          onSelection({ event: "selection_changed", recordId: row.recordId, selected: true })
        }
      />
    );
  return (
    <input
      type="checkbox"
      className="vortex-selection-checkbox"
      aria-label={`Select ${name}`}
      checked={selected}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) =>
        onSelection({
          event: "selection_changed",
          recordId: row.recordId,
          selected: event.currentTarget.checked,
        })
      }
    />
  );
}

/** The header control that selects or clears every selectable row on the returned page. */
export function SelectAllControl({
  allSelected,
  recordIds,
  accessibleName,
  events,
}: Readonly<{
  allSelected: boolean;
  recordIds: readonly string[];
  accessibleName: string;
  events: DisplayEventHandlers | undefined;
}>): ReactElement | null {
  const onSelection = events?.selection_changed;
  if (onSelection === undefined) return null;
  return (
    <input
      type="checkbox"
      className="vortex-selection-checkbox vortex-selection-all"
      aria-label={
        allSelected ? `Clear selection for ${accessibleName}` : `Select all ${accessibleName}`
      }
      checked={allSelected}
      disabled={recordIds.length === 0}
      onChange={() => {
        for (const recordId of recordIds)
          onSelection({ event: "selection_changed", recordId, selected: !allSelected });
      }}
    />
  );
}

/**
 * Row command bound to the declared `row_action` event; the bound flow decides its meaning. A
 * declared action carries the stable identity of its own binding, so several named commands on one
 * table reach different flows. An earlier release that declares no named action keeps the one
 * legacy control, identified by the placement itself.
 */
export function RowActionControl({
  recordId,
  name,
  eventId,
  label,
  events,
}: Readonly<{
  recordId: string;
  name: string;
  eventId?: string;
  label?: string;
  events: DisplayEventHandlers | undefined;
}>): ReactElement | null {
  const onRowAction = events?.row_action;
  if (onRowAction === undefined) return null;
  const text = label ?? "Open";
  return (
    <button
      type="button"
      className="vortex-button-row-action"
      aria-label={`${text} ${name}`}
      onClick={(clickEvent) => {
        clickEvent.stopPropagation();
        onRowAction(
          eventId === undefined
            ? { event: "row_action", recordId }
            : { event: "row_action", eventId, recordId },
        );
      }}
    >
      {text}
    </button>
  );
}

/**
 * One bulk command over the current selection. It is disabled until at least one row is selected,
 * and disabled while any selected row lacks the record action capability the command declares. It
 * sends the selected record identities as a bounded list, never an implicit first record.
 */
export function BulkActionControl({
  eventId,
  label,
  recordIds,
  capable = true,
  events,
}: Readonly<{
  eventId: string;
  label: string;
  recordIds: readonly string[];
  capable?: boolean;
  events: DisplayEventHandlers | undefined;
}>): ReactElement | null {
  const onBulkAction = events?.bulk_action;
  if (onBulkAction === undefined) return null;
  return (
    <button
      type="button"
      className="vortex-button-bulk-action"
      disabled={recordIds.length === 0 || !capable}
      onClick={() => onBulkAction({ event: "bulk_action", eventId, recordIds: [...recordIds] })}
    >
      {label}
    </button>
  );
}

/** The closed input kinds a declared filterable field's control can take. */
export type FilterInputKind = "text" | "number" | "date" | "boolean";

/**
 * One filter control for a configured filterable field. It emits the declared `filter_changed`
 * event for its field; the host sends that to the Query engine and returns a new page, so the
 * component never filters the returned rows itself. It only reports a committed value: a text or
 * number filter commits on Enter or blur, while a date or yes/no filter commits on change.
 */
export function FilterControl({
  field,
  label,
  input,
  events,
}: Readonly<{
  field: string;
  label: string;
  input: FilterInputKind;
  events: DisplayEventHandlers | undefined;
}>): ReactElement | null {
  const [value, setValue] = useState("");
  const [committed, setCommitted] = useState("");
  const inputId = useId();
  const onFilter = events?.filter_changed;
  if (onFilter === undefined) return null;
  // Reports only a real change, never each keystroke or a blur that changed nothing.
  const emit = (next: string): void => {
    if (next === committed) return;
    setCommitted(next);
    onFilter({ event: "filter_changed", field, value: next });
  };
  const control = ((): ReactElement => {
    switch (input) {
      case "boolean":
        return (
          <select
            id={inputId}
            className="vortex-select"
            aria-label={`Filter by ${label}`}
            value={value}
            onChange={(event) => {
              setValue(event.currentTarget.value);
              emit(event.currentTarget.value);
            }}
          >
            <option value="">Any</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        );
      case "date":
        return (
          <input
            id={inputId}
            type="date"
            className="vortex-input"
            aria-label={`Filter by ${label}`}
            value={value}
            onChange={(event) => {
              setValue(event.currentTarget.value);
              emit(event.currentTarget.value);
            }}
          />
        );
      case "number":
        return (
          <input
            id={inputId}
            type="number"
            className="vortex-input"
            aria-label={`Filter by ${label}`}
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
            onBlur={() => emit(value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                emit(value);
              }
            }}
          />
        );
      default:
        return (
          <input
            id={inputId}
            type="search"
            className="vortex-input"
            aria-label={`Filter by ${label}`}
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
            onBlur={() => emit(value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                emit(value);
              }
            }}
          />
        );
    }
  })();
  return (
    <div className="vortex-filter-control">
      <label htmlFor={inputId} className="vortex-filter-label">
        {label}
      </label>
      {control}
    </div>
  );
}

/**
 * The table's search box, shown only when the placement enables search and the host supplies the
 * declared `search_changed` event. It reports the query; the host sends it to the Query engine.
 */
export function SearchControl({
  accessibleName,
  events,
}: Readonly<{
  accessibleName: string;
  events: DisplayEventHandlers | undefined;
}>): ReactElement | null {
  const [query, setQuery] = useState("");
  const inputId = useId();
  const onSearch = events?.search_changed;
  if (onSearch === undefined) return null;
  return (
    <form
      className="vortex-table-search"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onSearch({ event: "search_changed", query });
      }}
    >
      <label htmlFor={inputId} className="vortex-sr-only">
        Search {accessibleName}
      </label>
      <input
        id={inputId}
        type="search"
        className="vortex-input vortex-table-search-input"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      <button type="submit" className="vortex-button">
        Search
      </button>
    </form>
  );
}

/**
 * One in-place editor for a declared permitted field. It commits the edited value as the table's
 * declared `inline_edit` event carrying the stable identity of the commit binding, the record, the
 * record revision the row was read at, the field and the new closed value. The revision lets the
 * server refuse a change made against a stale row; a row whose payload carries no revision sends
 * none and the server still re-checks the change.
 */
export function InlineEditCell({
  eventId,
  recordId,
  revision,
  field,
  label,
  value,
  handler,
}: Readonly<{
  eventId: string;
  recordId: string;
  revision?: number;
  field: string;
  label: string;
  value: DisplayCellValue;
  handler: DisplayEventHandler;
}>): ReactElement {
  const [text, setText] = useState(() =>
    value.kind === "number" ? String(value.value) : value.kind === "text" ? value.text : "",
  );
  const [checked, setChecked] = useState(value.kind === "boolean" ? value.value : false);
  const revisionField = revision === undefined ? {} : { revision };
  // Commits only a real change of a text or number cell; leaving the editor unchanged, or with a
  // value that is not a number, sends nothing.
  const commitText = (): void => {
    if (value.kind === "number") {
      const parsed = Number(text);
      if (!Number.isFinite(parsed) || text.trim().length === 0 || parsed === value.value) return;
      handler({
        event: "inline_edit",
        eventId,
        recordId,
        ...revisionField,
        field,
        value: { kind: "number", value: parsed },
      });
      return;
    }
    if (value.kind !== "text" || text === value.text) return;
    handler({
      event: "inline_edit",
      eventId,
      recordId,
      ...revisionField,
      field,
      value: { kind: "text", text },
    });
  };
  if (value.kind === "boolean")
    return (
      <input
        type="checkbox"
        className="vortex-inline-edit-checkbox"
        aria-label={`Edit ${label}`}
        checked={checked}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          const next = event.currentTarget.checked;
          setChecked(next);
          handler({
            event: "inline_edit",
            eventId,
            recordId,
            ...revisionField,
            field,
            value: { kind: "boolean", value: next },
          });
        }}
      />
    );
  return (
    <input
      type={value.kind === "number" ? "number" : "text"}
      className="vortex-inline-edit-input"
      aria-label={`Edit ${label}`}
      value={text}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setText(event.currentTarget.value)}
      onBlur={commitText}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          commitText();
        }
      }}
    />
  );
}

/** Page position with previous/next controls bound to the declared `page_changed` event. */
export function PaginationControl({
  page,
  pageCount,
  accessibleName,
  events,
}: Readonly<{
  page: number | undefined;
  pageCount: number | undefined;
  accessibleName: string;
  events: DisplayEventHandlers | undefined;
}>): ReactElement | null {
  if (page === undefined || pageCount === undefined) return null;
  const onPage = events?.page_changed;
  return (
    <nav className="vortex-pagination" aria-label={`Pages of ${accessibleName}`}>
      <span className="vortex-pagination-info">
        Page {page} of {pageCount}
      </span>
      {onPage === undefined ? null : (
        <>
          <button
            type="button"
            className="vortex-pagination-prev"
            disabled={page <= 1}
            onClick={() => onPage({ event: "page_changed", page: page - 1 })}
          >
            Previous page
          </button>
          <button
            type="button"
            className="vortex-pagination-next"
            disabled={page >= pageCount}
            onClick={() => onPage({ event: "page_changed", page: page + 1 })}
          >
            Next page
          </button>
        </>
      )}
    </nav>
  );
}
