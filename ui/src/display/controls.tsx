"use client";

import { useId, useState, type ReactElement } from "react";
import { ChevronDownIcon, MoreHorizontalIcon } from "lucide-react";
import type { RecordsTableActionContract } from "@vortex/contracts";
import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import { Empty, EmptyHeader, EmptyTitle } from "../components/empty";
import { Input } from "../components/input";
import { Label } from "../components/label";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "../components/pagination";
import { Skeleton } from "../components/skeleton";
import { cn } from "../lib/utils";
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
    <div className="mb-4 flex items-center justify-between gap-2">
      {title === undefined ? null : (
        <h2 className="m-0 font-heading text-lg font-semibold text-foreground">{title}</h2>
      )}
      {refresh === undefined ? null : (
        <Button
          variant="outline"
          size="sm"
          aria-label={`Refresh ${accessibleName}`}
          onClick={() => refresh({ event: "refresh" })}
        >
          Refresh
        </Button>
      )}
    </div>
  );
}

/**
 * The loading state of the Records table and lists: a data-free skeleton announced as a status at
 * the component, carrying the same state identity and accessible name the standard state container
 * gives a loading state.
 */
export function RecordsLoadingState({
  accessibleName,
}: Readonly<{ accessibleName: string }>): ReactElement {
  return (
    <div
      role="status"
      aria-busy="true"
      data-vortex-display-state="loading"
      className="flex flex-col gap-2 rounded-lg border border-border bg-background p-4"
      aria-label={`Loading ${accessibleName}`}
    >
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}

/**
 * The no-rows state of the Records table and lists: the authored or default neutral message in the
 * shadcn empty presentation, announced as a status with the same state identity and accessible name
 * the standard state container gives an empty state.
 */
export function RecordsEmptyState({
  accessibleName,
  message,
}: Readonly<{ accessibleName: string; message: string }>): ReactElement {
  return (
    <Empty
      role="status"
      data-vortex-display-state="empty"
      className="border border-border text-muted-foreground"
      aria-label={`${accessibleName}: empty`}
    >
      <EmptyHeader>
        <EmptyTitle>{message}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

/**
 * The per-row selection control bound to the declared `selection_changed` event and stable record
 * identity. `multiple` renders a shadcn Checkbox. `single` renders one radio group scoped to the
 * table by `groupName`, so choosing another row replaces the choice; the pinned base-nova registry
 * has no radio part bound to a per-row group, so that mode keeps the platform's own radio. Either
 * way the control only reports the viewer's choice; the host owns the selection and the projected
 * `selectedRecordIds`.
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
    <Checkbox
      aria-label={`Select ${name}`}
      checked={selected}
      onClick={(event) => event.stopPropagation()}
      onCheckedChange={(checked) =>
        onSelection({ event: "selection_changed", recordId: row.recordId, selected: checked })
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
    <Checkbox
      aria-label={
        allSelected ? `Clear selection for ${accessibleName}` : `Select all ${accessibleName}`
      }
      checked={allSelected}
      disabled={recordIds.length === 0}
      onCheckedChange={() => {
        for (const recordId of recordIds)
          onSelection({ event: "selection_changed", recordId, selected: !allSelected });
      }}
    />
  );
}

/**
 * One row command of a list or record detail, bound to the declared `row_action` event; the bound
 * flow decides its meaning. The Records table offers its own row commands as one Dropdown Menu.
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
    <Button
      variant="outline"
      size="sm"
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
    </Button>
  );
}

/**
 * Every row command the row shows, as one Dropdown Menu bound to the declared `row_action` event.
 * Each declared action carries the stable identity of its own binding, so several named commands on
 * one table reach different flows. A release that declares no named action keeps the one legacy
 * control, identified by the placement itself, as the menu's single command.
 */
export function RowActionsMenu({
  recordId,
  name,
  actions,
  events,
}: Readonly<{
  recordId: string;
  name: string;
  actions: readonly RecordsTableActionContract[];
  events: DisplayEventHandlers | undefined;
}>): ReactElement | null {
  const onRowAction = events?.row_action;
  if (onRowAction === undefined) return null;
  const commands: readonly {
    key: string;
    label: string;
    eventId: string | undefined;
  }[] =
    actions.length === 0
      ? [{ key: "row_action", label: "Open", eventId: undefined }]
      : actions.map((action) => ({
          key: action.eventId,
          label: action.label,
          eventId: action.eventId,
        }));
  // A row that shows no command keeps an empty actions cell, as before.
  if (commands.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={`Actions for ${name}`}
            // Opening the commands of a row is not a request to open the row itself.
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {commands.map((command) => (
          <DropdownMenuItem
            key={command.key}
            onClick={() =>
              onRowAction(
                command.eventId === undefined
                  ? { event: "row_action", recordId }
                  : { event: "row_action", eventId: command.eventId, recordId },
              )
            }
          >
            {command.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Every bulk command over the current selection, as one Dropdown Menu bound to the declared
 * `bulk_action` event. A command is unavailable until at least one row is selected, and unavailable
 * while any selected row lacks the record action capability the command declares. It sends the
 * selected record identities as a bounded list, never an implicit first record.
 */
export function BulkActionsMenu({
  accessibleName,
  actions,
  recordIds,
  canRun,
  events,
}: Readonly<{
  accessibleName: string;
  actions: readonly RecordsTableActionContract[];
  recordIds: readonly string[];
  canRun: (action: RecordsTableActionContract) => boolean;
  events: DisplayEventHandlers | undefined;
}>): ReactElement | null {
  const onBulkAction = events?.bulk_action;
  if (onBulkAction === undefined) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" aria-label={`Bulk actions for ${accessibleName}`} />
        }
      >
        Bulk actions
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.eventId}
            disabled={recordIds.length === 0 || !canRun(action)}
            onClick={() =>
              onBulkAction({
                event: "bulk_action",
                eventId: action.eventId,
                recordIds: [...recordIds],
              })
            }
          >
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The closed input kinds a declared filterable field's control can take. */
export type FilterInputKind = "text" | "number" | "date" | "boolean";

/** The three closed values a yes/no filter commits, and the label each one shows. */
const BOOLEAN_FILTER_OPTIONS = [
  { value: "", label: "Any" },
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
] as const;

/**
 * A yes/no filter as a Dropdown Menu of its three closed values, keeping the committed value as the
 * trigger's label. It reports only a real change, exactly as the native choice list did.
 */
function BooleanFilterControl({
  id,
  label,
  value,
  onCommit,
}: Readonly<{
  id: string;
  label: string;
  value: string;
  onCommit: (next: string) => void;
}>): ReactElement {
  const current = BOOLEAN_FILTER_OPTIONS.find((option) => option.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            id={id}
            variant="outline"
            size="default"
            aria-label={`Filter by ${label}`}
            className="w-full justify-between"
          />
        }
      >
        {current?.label ?? BOOLEAN_FILTER_OPTIONS[0].label}
        <ChevronDownIcon data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {BOOLEAN_FILTER_OPTIONS.map((option) => (
          <DropdownMenuItem key={option.value} onClick={() => onCommit(option.value)}>
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
          <BooleanFilterControl
            id={inputId}
            label={label}
            value={value}
            onCommit={(next) => {
              setValue(next);
              emit(next);
            }}
          />
        );
      case "date":
        return (
          <Input
            id={inputId}
            type="date"
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
          <Input
            id={inputId}
            type="number"
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
          <Input
            id={inputId}
            type="search"
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
    <div className="flex min-w-32 flex-col gap-1">
      <Label htmlFor={inputId}>{label}</Label>
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
      className="flex items-end gap-1.5"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onSearch({ event: "search_changed", query });
      }}
    >
      <Label htmlFor={inputId} className="sr-only">
        Search {accessibleName}
      </Label>
      <Input
        id={inputId}
        type="search"
        className="w-auto min-w-48"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      <Button type="submit" size="sm">
        Search
      </Button>
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
      <Checkbox
        aria-label={`Edit ${label}`}
        checked={checked}
        onClick={(event) => event.stopPropagation()}
        onCheckedChange={(next) => {
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
    <Input
      type={value.kind === "number" ? "number" : "text"}
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
  const previousDisabled = page <= 1;
  const nextDisabled = page >= pageCount;
  // The shadcn paging links are anchors, so an unavailable page is announced as disabled and taken
  // out of the tab order instead of carrying the native disabled attribute.
  return (
    <Pagination aria-label={`Pages of ${accessibleName}`} className="mt-2">
      <PaginationContent>
        {onPage === undefined ? null : (
          <PaginationItem>
            <PaginationPrevious
              text="Previous page"
              aria-disabled={previousDisabled}
              tabIndex={previousDisabled ? -1 : 0}
              className={cn(previousDisabled && "pointer-events-none opacity-50")}
              onClick={() => {
                if (previousDisabled) return;
                onPage({ event: "page_changed", page: page - 1 });
              }}
            />
          </PaginationItem>
        )}
        <PaginationItem>
          <PaginationLink isActive size="default" aria-label={`Page ${page} of ${pageCount}`}>
            {`${page} of ${pageCount}`}
          </PaginationLink>
        </PaginationItem>
        {onPage === undefined ? null : (
          <PaginationItem>
            <PaginationNext
              text="Next page"
              aria-disabled={nextDisabled}
              tabIndex={nextDisabled ? -1 : 0}
              className={cn(nextDisabled && "pointer-events-none opacity-50")}
              onClick={() => {
                if (nextDisabled) return;
                onPage({ event: "page_changed", page: page + 1 });
              }}
            />
          </PaginationItem>
        )}
      </PaginationContent>
    </Pagination>
  );
}
