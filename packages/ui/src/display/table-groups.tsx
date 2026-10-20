"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { Collapsible, CollapsibleContent } from "../components/collapsible";
import { Empty, EmptyHeader, EmptyTitle } from "../components/empty";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Icon } from "../icons/icon";
import { cn } from "../lib/utils";
import {
  fail,
  parseTablePayload,
  requireExactKeys,
  requireRecord,
  type DisplayEventHandlers,
  type DisplayRow,
  type TablePayload,
} from "./projected-data";
import type { TableGroup, TableGroups } from "./projected-grid-features";

const location = { propertyPath: ["groups"] };

type MemberPage = Readonly<{
  key: string;
  rows: readonly DisplayRow[];
  /**
   * The grid features the server projected with this page: a feature that depends on the rows
   * read (such as inline editing) follows the open group's page, not the collapsed groups' read.
   */
  features: TablePayload["features"];
  next?: string;
  previous?: string;
  /** The page number within the open group, for the footer; the group is read a page at a time. */
  page: number;
}>;

type Members =
  | Readonly<{ status: "loading"; key: string }>
  | Readonly<{ status: "ready"; page: MemberPage; refreshing: boolean }>
  | Readonly<{ status: "empty" | "refused" | "error"; key: string }>;

/**
 * A member read's reply. A reply the host dropped (a later read for the same table started, or the
 * address moved on) is undefined; anything else that is not a page fails loudly, as every
 * projected payload does.
 */
const parseMembers = (
  value: unknown,
  key: string,
  page: number,
): Exclude<Members, Readonly<{ status: "loading" }>> | undefined => {
  if (value === undefined) return undefined;
  const record = requireRecord(value, "A group's members must be an object", location);
  switch (record.status) {
    case "empty":
    case "refused":
    case "error":
      requireExactKeys(record, ["status"], location);
      return { status: record.status, key };
    case "ready": {
      requireExactKeys(record, ["status", "values"], location);
      const payload = parseTablePayload(record.values, location);
      return {
        status: "ready",
        refreshing: false,
        page: {
          key,
          rows: payload.rows,
          features: payload.features,
          page,
          ...(payload.nextContinuationToken === undefined
            ? {}
            : { next: payload.nextContinuationToken }),
          ...(payload.previousContinuationToken === undefined
            ? {}
            : { previous: payload.previousContinuationToken }),
        },
      };
    }
    default:
      return fail("A group's members have an unknown status", location);
  }
};

/** The group a members state belongs to. */
const memberKey = (members: Members): string =>
  members.status === "ready" ? members.page.key : members.key;

export type GroupedTable = Readonly<{
  groups: Extract<TableGroups, { status: "ready" }>;
  /** The open group's key; null while every group is closed. */
  expanded: string | null;
  members: Members | undefined;
  /** The open group's rows as the table shows them; empty while closed or reading. */
  rows: readonly DisplayRow[];
  /** The features projected with the open group's page; undefined while no page is shown. */
  memberFeatures: TablePayload["features"] | undefined;
  toggle: (key: string) => void;
  /** Reads the open group's next or previous page. */
  move: (direction: "next" | "previous") => void;
}>;

/**
 * The state of a grouped table. The page read counted the groups and, when the address names an
 * open group, carried its first page of members; every other opening or page of a group is one
 * read of that group's members, and closing a group reads nothing. A new server payload starts
 * the state again from what the server read; a reply for a group that is no longer open is dropped.
 */
export function useGroupedTable(
  values: TablePayload | undefined,
  events: DisplayEventHandlers | undefined,
): GroupedTable | undefined {
  const groups = values?.groups?.status === "ready" ? values.groups : undefined;
  const serverExpanded = groups?.expanded ?? null;
  const initialMembers = useCallback((): Members | undefined => {
    if (values === undefined || serverExpanded === null) return undefined;
    return {
      status: "ready",
      refreshing: false,
      page: {
        key: serverExpanded,
        rows: values.rows,
        features: values.features,
        page: 1,
        ...(values.nextContinuationToken === undefined
          ? {}
          : { next: values.nextContinuationToken }),
        ...(values.previousContinuationToken === undefined
          ? {}
          : { previous: values.previousContinuationToken }),
      },
    };
  }, [values, serverExpanded]);
  const [held, setHeld] = useState<{
    owner: TablePayload | undefined;
    expanded: string | null;
    members: Members | undefined;
  }>(() => ({ owner: values, expanded: serverExpanded, members: initialMembers() }));
  // A payload the server read replaces whatever the person opened since: the groups were counted
  // again under the query as it is now.
  if (held.owner !== values)
    setHeld({ owner: values, expanded: serverExpanded, members: initialMembers() });
  const current =
    held.owner === values
      ? held
      : { owner: values, expanded: serverExpanded, members: initialMembers() };
  const latest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A payload the server read ends every member read still on its way: it was for the old query.
  useEffect(() => {
    latest.current += 1;
  }, [values]);
  const requestGroup = events?.group_requested;
  const opened = events?.group_opened;

  const read = useCallback(
    async (key: string, page: number, token?: string, direction?: "forward" | "backward") => {
      const request = latest.current + 1;
      latest.current = request;
      setHeld((state) => ({
        ...state,
        members:
          state.members?.status === "ready" && state.members.page.key === key
            ? { ...state.members, refreshing: true }
            : { status: "loading", key },
      }));
      let outcome: ReturnType<typeof parseMembers>;
      try {
        outcome = parseMembers(
          await requestGroup?.({
            event: "group_requested",
            key,
            ...(token === undefined ? {} : { continuationToken: token }),
            ...(direction === undefined ? {} : { direction }),
          }),
          key,
          page,
        );
      } catch (error) {
        console.error("[display] a group's members could not be read", error);
        outcome = { status: "error", key };
      }
      if (!mounted.current || latest.current !== request) return;
      // A reply the host dropped keeps the page already shown; the person can try again.
      setHeld((state) => ({
        ...state,
        members:
          outcome === undefined
            ? state.members?.status === "ready"
              ? { ...state.members, refreshing: false }
              : { status: "error", key }
            : outcome,
      }));
    },
    [requestGroup],
  );

  const toggle = useCallback(
    (key: string) => {
      if (current.expanded === key) {
        latest.current += 1;
        setHeld((state) => ({ ...state, expanded: null, members: undefined }));
        void opened?.({ event: "group_opened", key: null });
        return;
      }
      setHeld((state) => ({ ...state, expanded: key, members: { status: "loading", key } }));
      void opened?.({ event: "group_opened", key });
      void read(key, 1);
    },
    [current.expanded, opened, read],
  );

  const members = current.members;
  const move = useCallback(
    (direction: "next" | "previous") => {
      if (members?.status !== "ready") return;
      const token = direction === "next" ? members.page.next : members.page.previous;
      if (token === undefined) return;
      void read(
        members.page.key,
        Math.max(1, members.page.page + (direction === "next" ? 1 : -1)),
        token,
        direction === "next" ? "forward" : "backward",
      );
    },
    [members, read],
  );

  return useMemo(
    () =>
      groups === undefined
        ? undefined
        : {
            groups,
            expanded: current.expanded,
            members,
            rows: members?.status === "ready" ? members.page.rows : [],
            memberFeatures: members?.status === "ready" ? members.page.features : undefined,
            toggle,
            move,
          },
    [groups, current.expanded, members, toggle, move],
  );
}

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
  members: (rows: readonly DisplayRow[]) => ReactNode;
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
        {groups.groups.length === 1 ? "1 group" : `${groups.groups.length} groups`}, counted when
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
                members(state.page.rows)
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
      <div className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5">
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
