"use client";

import type { ReactElement } from "react";
import { Icon } from "../icons/icon";
import type { RecordsTableActionContract } from "@vortex/platform/schema";
import { Button } from "../components/button";
import { Card, CardContent } from "../components/card";
import { Checkbox } from "../components/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import { Empty, EmptyHeader, EmptyTitle } from "../components/empty";
import { Pagination, PaginationContent, PaginationItem } from "../components/pagination";
import { Skeleton } from "../components/skeleton";
import { Spinner } from "../components/spinner";
import { usePendingGesture } from "../controls/pending-gesture";
import type {
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
    <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-2">
      {title === undefined ? null : (
        <h2 className="m-0 min-w-0 break-words font-heading text-lg font-semibold text-foreground">
          {title}
        </h2>
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
    <Card
      role="status"
      aria-busy="true"
      data-vortex-display-state="loading"
      aria-label={`Loading ${accessibleName}`}
    >
      <CardContent className="flex flex-col gap-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </CardContent>
    </Card>
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
 * table by `groupName`, so choosing another row replaces the choice; the shadcn radio group must
 * wrap all of its radios in one element, which table rows cannot share, so that mode keeps the
 * platform's own radio. Either way the control only reports the viewer's choice; the host owns the
 * selection and the projected `selectedRecordIds`.
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
 * flow decides its meaning. The record's current revision travels with the command, so a flow that
 * changes one existing row is bound at the revision the person saw. The Records table offers its own
 * row commands as one Dropdown Menu.
 */
export function RowActionControl({
  recordId,
  revision,
  name,
  eventId,
  label,
  events,
}: Readonly<{
  recordId: string;
  revision?: number;
  name: string;
  eventId?: string;
  label?: string;
  events: DisplayEventHandlers | undefined;
}>): ReactElement | null {
  // The command's flow keeps the button busy until it settles, like every flow button.
  const gesture = usePendingGesture();
  const onRowAction = events?.row_action;
  if (onRowAction === undefined) return null;
  const text = label ?? "Open";
  const identity = { recordId, ...(revision === undefined ? {} : { revision }) };
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={`${text} ${name}`}
      disabled={gesture.pending}
      aria-busy={gesture.pending}
      onClick={(clickEvent) => {
        clickEvent.stopPropagation();
        if (gesture.running()) return;
        gesture.track(
          onRowAction(
            eventId === undefined
              ? { event: "row_action", ...identity }
              : { event: "row_action", eventId, ...identity },
          ),
        );
      }}
    >
      {gesture.pending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
      {text}
    </Button>
  );
}

/**
 * Every row command the row shows, as one Dropdown Menu bound to the declared `row_action` event.
 * Each declared action carries the stable identity of its own binding, so several named commands on
 * one table reach different flows. An empty action list shows no command. Every
 * command carries the row's current revision, so the bound flow acts on the record as it was read.
 */
export function RowActionsMenu({
  recordId,
  revision,
  name,
  actions,
  events,
}: Readonly<{
  recordId: string;
  revision?: number;
  name: string;
  actions: readonly RecordsTableActionContract[];
  events: DisplayEventHandlers | undefined;
}>): ReactElement | null {
  // The chosen command's flow keeps the menu's button busy until it settles.
  const gesture = usePendingGesture();
  const onRowAction = events?.row_action;
  if (onRowAction === undefined) return null;
  const identity = { recordId, ...(revision === undefined ? {} : { revision }) };
  if (actions.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={`Actions for ${name}`}
            disabled={gesture.pending}
            aria-busy={gesture.pending}
            // Opening the commands of a row is not a request to open the row itself.
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        {gesture.pending ? <Spinner aria-hidden="true" /> : <Icon name="more-horizontal" />}
      </DropdownMenuTrigger>
      {/* The menu is portalled, but React still bubbles its clicks through the row; choosing a
          command is not a request to open the row itself. */}
      <DropdownMenuContent onClick={(event) => event.stopPropagation()}>
        {actions.map((command) => (
          <DropdownMenuItem
            key={command.eventId}
            onClick={() => {
              if (gesture.running()) return;
              gesture.track(
                onRowAction({ event: "row_action", eventId: command.eventId, ...identity }),
              );
            }}
          >
            {command.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Keyset page navigation bound to the declared `page_changed` event. */
export function PaginationControl({
  page,
  pageCount,
  hasNextPage,
  nextContinuationToken,
  hasPreviousPage,
  previousContinuationToken,
  accessibleName,
  events,
}: Readonly<{
  page: number | undefined;
  pageCount: number | undefined;
  hasNextPage?: boolean;
  nextContinuationToken?: string;
  hasPreviousPage?: boolean;
  previousContinuationToken?: string;
  accessibleName: string;
  events: DisplayEventHandlers | undefined;
}>): ReactElement | null {
  if (page === undefined) return null;
  const onPage = events?.page_changed;
  // A keyset preview has neither a page count nor paging actions to present.
  if (onPage === undefined && pageCount === undefined) return null;
  const numbered = pageCount !== undefined;
  const previousDisabled = numbered ? page <= 1 : hasPreviousPage !== true;
  const nextDisabled = pageCount !== undefined ? page >= pageCount : hasNextPage !== true;
  // First is unavailable only on the first page itself: an empty continuation page (rows deleted
  // or access changed) has no previous anchor but must still lead back to page one.
  const firstDisabled = page <= 1;
  // Numbered lists target real page numbers; keyset tables mark a continuation with page 2.
  const previousTarget = numbered ? page - 1 : 2;
  const nextTarget = numbered ? page + 1 : 2;
  const lastTarget = pageCount ?? 2;
  return (
    <Pagination aria-label={`Pages of ${accessibleName}`} className="mt-2">
      <PaginationContent className="flex-wrap justify-center gap-1">
        {onPage === undefined ? null : (
          <PaginationItem>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={firstDisabled}
              aria-label="First page"
              onClick={() => onPage({ event: "page_changed", page: 1, direction: "first" })}
            >
              First
            </Button>
          </PaginationItem>
        )}
        {onPage === undefined ? null : (
          <PaginationItem>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={previousDisabled}
              aria-label="Previous page"
              onClick={() =>
                onPage({
                  event: "page_changed",
                  page: previousTarget,
                  direction: "previous",
                  ...(previousContinuationToken === undefined
                    ? {}
                    : { continuationToken: previousContinuationToken }),
                })
              }
            >
              Previous
            </Button>
          </PaginationItem>
        )}
        {pageCount === undefined ? null : (
          <PaginationItem>
            <span className="px-2 text-sm">
              Page {page} of {pageCount}
            </span>
          </PaginationItem>
        )}
        {onPage === undefined ? null : (
          <PaginationItem>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={nextDisabled}
              aria-label="Next page"
              onClick={() =>
                onPage({
                  event: "page_changed",
                  page: nextTarget,
                  direction: "next",
                  ...(nextContinuationToken === undefined
                    ? {}
                    : { continuationToken: nextContinuationToken }),
                })
              }
            >
              Next
            </Button>
          </PaginationItem>
        )}
        {onPage === undefined ? null : (
          <PaginationItem>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={nextDisabled}
              aria-label="Last page"
              onClick={() => onPage({ event: "page_changed", page: lastTarget, direction: "last" })}
            >
              Last
            </Button>
          </PaginationItem>
        )}
      </PaginationContent>
    </Pagination>
  );
}
