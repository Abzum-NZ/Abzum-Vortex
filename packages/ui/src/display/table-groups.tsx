"use client";

import type { ReactElement, ReactNode } from "react";
import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { Collapsible, CollapsibleContent } from "../components/collapsible";
import { Empty, EmptyHeader, EmptyTitle } from "../components/empty";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Icon } from "../icons/icon";
import { cn } from "../lib/utils";
import type { TableGroup } from "./projected-grid-features";
import { memberKey, type GroupedTable } from "./table-groups-state";

const groupLabelId = (placementId: string, key: string): string =>
  `${placementId}-group-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/**
 * The groups of a grouped table, one header row each, and under the open group the rows its page
 * holds: `members` draws them with the table's own grid or cards, so a member shows the same cells,
 * sort, formatting and actions as any row. Only one group is open at a time; opening another
 * closes this one. Counts are what the server counted when the page was read.
 */
export function GroupedBody({
  placementId,
  accessibleName,
  grouped,
  loading,
  members,
}: Readonly<{
  placementId: string;
  accessibleName: string;
  grouped: GroupedTable;
  /** The skeleton the open group shows while its first page is read, sized to the page. */
  loading: ReactNode;
  /** Draws a page of the open group's rows. */
  members: () => ReactNode;
}>): ReactElement {
  const { groups, expanded } = grouped;
  const state = grouped.members;
  return (
    <div
      data-vortex-grouped=""
      role="group"
      aria-label={`${accessibleName}: groups`}
      className="flex flex-col gap-2"
    >
      <p className="m-0 text-xs text-muted-foreground tabular-nums">
        {groups.total === 1 ? "1 record" : `${groups.total} records`} in{" "}
        {groups.groups.length === 1 ? "1 group" : `${groups.groups.length} groups`}
        {groups.page.first && groups.page.next === undefined ? "" : " on this page"}, counted when
        the table was read
      </p>
      {groups.groups.length === 0 ? (
        <Empty
          role="status"
          className="border border-border text-muted-foreground"
          aria-label={`${accessibleName}: no groups`}
        >
          <EmptyHeader>
            <EmptyTitle>No records to group</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : null}
      {groups.groups.map((group) => (
        <GroupSection
          key={group.key}
          id={groupLabelId(placementId, group.key)}
          group={group}
          open={expanded === group.key}
          onToggle={() => grouped.toggle(group.key)}
        >
          {state === undefined || memberKey(state) !== group.key ? null : state.status ===
            "loading" ? (
            loading
          ) : state.status === "ready" ? (
            <div className={cn("flex flex-col gap-2", state.refreshing && "opacity-70")}>
              {state.page.rows.length === 0 ? (
                <Empty
                  role="status"
                  className="border border-border text-muted-foreground"
                  aria-label={`${group.label}: no records`}
                >
                  <EmptyHeader>
                    <EmptyTitle>No records in this group now</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : (
                members()
              )}
              <GroupPager grouped={grouped} group={group} />
            </div>
          ) : (
            <Empty
              role="status"
              className="border border-border text-muted-foreground"
              aria-label={`${group.label}: ${state.status === "empty" ? "no records" : "not available"}`}
            >
              <EmptyHeader>
                <EmptyTitle>
                  {state.status === "empty"
                    ? "No records in this group now"
                    : state.status === "refused"
                      ? "These records are not available to you"
                      : "These records could not be read"}
                </EmptyTitle>
              </EmptyHeader>
              {state.status === "error" ? (
                <Button variant="outline" size="sm" onClick={() => grouped.toggle(group.key)}>
                  Close the group
                </Button>
              ) : null}
            </Empty>
          )}
        </GroupSection>
      ))}
      <GroupsPager grouped={grouped} />
    </div>
  );
}

/** More groups than one page shows continue on the next page; the way back is the first page. */
function GroupsPager({ grouped }: Readonly<{ grouped: GroupedTable }>): ReactElement | null {
  const { page } = grouped.groups;
  if (page.first && page.next === undefined) return null;
  const movePage = grouped.movePage;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={page.first || movePage === undefined}
        onClick={() => movePage?.(null)}
      >
        First groups
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={page.next === undefined || movePage === undefined}
        onClick={() => page.next !== undefined && movePage?.(page.next)}
      >
        More groups
      </Button>
    </div>
  );
}

function GroupSection({
  id,
  group,
  open,
  onToggle,
  children,
}: Readonly<{
  id: string;
  group: TableGroup;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}>): ReactElement {
  return (
    <Collapsible open={open} onOpenChange={() => onToggle()}>
      <div className="flex items-center gap-2 bg-muted/40 px-2 py-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-expanded={open}
                aria-controls={`${id}-members`}
                aria-label={`${open ? "Close" : "Open"} ${group.label}`}
                onClick={onToggle}
              />
            }
          >
            <Icon name={open ? "chevron-down" : "chevron-right"} aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>{open ? "Close the group" : "Open the group"}</TooltipContent>
        </Tooltip>
        <span
          id={id}
          className={cn(
            "min-w-0 flex-1 truncate text-sm font-medium",
            group.unassigned === true && "text-muted-foreground",
          )}
        >
          {group.label}
        </span>
        <Badge variant="secondary" className="tabular-nums" aria-label={`${group.count} records`}>
          {group.count}
        </Badge>
      </div>
      <CollapsibleContent id={`${id}-members`} className="pt-2">
        {open ? children : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function GroupPager({
  grouped,
  group,
}: Readonly<{ grouped: GroupedTable; group: TableGroup }>): ReactElement | null {
  const state = grouped.members;
  if (state?.status !== "ready") return null;
  const { rows, next, previous, page } = state.page;
  if (next === undefined && previous === undefined) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="m-0 text-xs text-muted-foreground tabular-nums">
        {`${group.label} · page ${page} · ${rows.length === 1 ? "1 row" : `${rows.length} rows`}`}
      </p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={previous === undefined || state.refreshing}
          onClick={() => grouped.move("previous")}
        >
          Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={next === undefined || state.refreshing}
          onClick={() => grouped.move("next")}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
