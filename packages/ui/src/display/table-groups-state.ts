import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fail, requireExactKeys, requireRecord } from "./payload-parse";
import {
  parseTablePayload,
  type DisplayEventHandlers,
  type DisplayRow,
  type TablePayload,
} from "./projected-data";
import type { TableGroups } from "./projected-grid-features";

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

export type Members =
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
export const memberKey = (members: Members): string =>
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
  /** Shows another page of the groups: after the group named, or (null) from the first. */
  movePage: ((after: string | null) => void) | undefined;
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
  // What the server read, by content: the page payload is parsed again on every render of the
  // page (an address write that opens a group is one), and only a different read starts again.
  const serverRead = useMemo(
    () =>
      values === undefined || groups === undefined
        ? ""
        : JSON.stringify([
            values.groups,
            values.rows,
            values.nextContinuationToken,
            values.previousContinuationToken,
          ]),
    [values, groups],
  );
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
    owner: string;
    expanded: string | null;
    members: Members | undefined;
  }>(() => ({ owner: serverRead, expanded: serverExpanded, members: initialMembers() }));
  // A payload the server read replaces whatever the person opened since: the groups were counted
  // again under the query as it is now.
  if (held.owner !== serverRead)
    setHeld({ owner: serverRead, expanded: serverExpanded, members: initialMembers() });
  const current =
    held.owner === serverRead
      ? held
      : { owner: serverRead, expanded: serverExpanded, members: initialMembers() };
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
  }, [serverRead]);
  const requestGroup = events?.group_requested;
  const opened = events?.group_opened;
  const pageGroups = events?.group_page_changed;

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

  const movePage = useMemo(
    () =>
      pageGroups === undefined
        ? undefined
        : (after: string | null) => {
            latest.current += 1;
            void pageGroups({ event: "group_page_changed", after });
          },
    [pageGroups],
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
            movePage,
          },
    [groups, current.expanded, members, toggle, move, movePage],
  );
}
