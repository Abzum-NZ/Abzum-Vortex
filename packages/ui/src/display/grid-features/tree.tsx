"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RECORDS_TABLE_TREE_MAXIMUM_PAGE_SIZE,
  recordsTableTreeFeature,
} from "@vortex/platform/schema";
import { cellValueToText } from "../cell";
import { fail, requireExactKeys, requireRecord } from "../payload-parse";
import { parseTablePayload, type DisplayRow } from "../projected-data";
import type { SubRowEntry, SubRowsBeneath } from "../sub-rows";
import type { GridFeatureModule, GridFeatureSubRowsProps } from "./registry";

/** The rows a tree table holds at once: its page and every level opened beneath it. */
const TREE_ROW_BUDGET = RECORDS_TABLE_TREE_MAXIMUM_PAGE_SIZE;

type Level = Readonly<{ rows: readonly DisplayRow[]; next?: string }>;
type Outcome =
  Readonly<{ status: "ready"; level: Level }> | Readonly<{ status: "empty" | "refused" | "error" }>;
type NodeState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{
      kind: "ready";
      rows: readonly DisplayRow[];
      next?: string;
      more: "idle" | "reading" | "failed";
      /** The shared budget has no room for the next page: it waits until a branch is closed. */
      capped: boolean;
    }>
  | Readonly<{ kind: "empty" | "refused" | "error" | "budget" }>;

const location = { propertyPath: [recordsTableTreeFeature.property] };

/**
 * One level as the host's read returned it: the table's own payload for the children of one row.
 * A reply the host dropped (a later read for the same row started) is undefined; anything else that
 * is not a level fails loudly, as every projected payload does.
 */
const parseOutcome = (value: unknown): Outcome | undefined => {
  if (value === undefined) return undefined;
  const record = requireRecord(value, "A tree level must be an object", location);
  switch (record.status) {
    case "empty":
    case "refused":
    case "error":
      requireExactKeys(record, ["status"], location);
      return { status: record.status };
    case "ready": {
      requireExactKeys(record, ["status", "values"], location);
      const payload = parseTablePayload(record.values, location);
      return {
        status: "ready",
        level: {
          rows: payload.rows,
          ...(payload.nextContinuationToken === undefined
            ? {}
            : { next: payload.nextContinuationToken }),
        },
      };
    }
    default:
      return fail("A tree level has an unknown status", location);
  }
};

/** The rows each opened branch holds, so the whole table stays within one row budget. */
const usedExcept = (budget: ReadonlyMap<string, number>, nodeId: string): number => {
  let used = 0;
  for (const [id, rows] of budget) if (id !== nodeId) used += rows;
  return used;
};

/**
 * The opened records that can be read: those of the page, and those listed by an opened record
 * whose level is loaded. A record whose parent closes, or whose level is read again, is no longer
 * one of them, and gives its rows back to the budget.
 */
const reachableOpen = (
  expanded: readonly string[],
  pageRows: readonly DisplayRow[],
  nodes: ReadonlyMap<string, NodeState>,
): readonly string[] => {
  const open = new Set(expanded);
  const reachable: string[] = [];
  const visit = (rows: readonly DisplayRow[]): void => {
    for (const row of rows) {
      if (!open.has(row.recordId)) continue;
      reachable.push(row.recordId);
      const node = nodes.get(row.recordId);
      if (node?.kind === "ready") visit(node.rows);
    }
  };
  visit(pageRows);
  return reachable;
};

/**
 * The levels of a tree table: one read when a row opens, one per "Show more" (nothing when it
 * closes, which also gives its rows back to the shared budget). It draws nothing; the entries it
 * reports are rows and notices of the table's own grid, so every level looks and acts like the page.
 */
function Levels({ context, expandedRecordIds, publish, written }: GridFeatureSubRowsProps): null {
  const tree = context.features.tree;
  if (tree === undefined) fail("A tree requires its feature projection", location);
  const pageSize = tree.pageSize;
  const readLevel = context.events?.row_expanded;
  const pageRows = context.rows;
  const heading = context.columns[0]?.key;
  const [nodes, setNodes] = useState<ReadonlyMap<string, NodeState>>(() => new Map());
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const budget = useRef(new Map<string, number>());
  const mounted = useRef(true);
  // The latest read of each opened row: an older one's reply never decides its state.
  const requests = useRef(new Map<string, number>());
  const sequence = useRef(0);
  // The page's own row count is read when a request is sized, so the reads keep their identity
  // while the page's rows change.
  const shownPageRows = useRef(pageRows.length);
  shownPageRows.current = pageRows.length;

  const patch = useCallback((id: string, state: NodeState | undefined): void => {
    setNodes((current) => {
      const next = new Map(current);
      if (state === undefined) next.delete(id);
      else next.set(id, state);
      return next;
    });
  }, []);
  const live = useCallback(
    (id: string, request: number): boolean =>
      mounted.current && requests.current.get(id) === request,
    [],
  );
  const remaining = useCallback(
    (id: string): number =>
      TREE_ROW_BUDGET - shownPageRows.current - usedExcept(budget.current, id),
    [],
  );

  const readPage = useCallback(
    async (
      recordId: string,
      token: string | undefined,
      requestedRows: number,
    ): Promise<Outcome | undefined> => {
      if (readLevel === undefined) return { status: "error" };
      try {
        return parseOutcome(
          await readLevel({
            event: "row_expanded",
            recordId,
            pageSize: requestedRows,
            ...(token === undefined ? {} : { continuationToken: token }),
          }),
        );
      } catch (error) {
        console.error("[display] a tree level could not be read", error);
        return { status: "error" };
      }
    },
    [readLevel],
  );

  // A read's rows are reserved in the budget before it starts, so every returned row (at most the
  // requested size) fits and the level's next position is never lost. Reading a shown level again
  // (the page was refreshed) keeps its rows on screen, and in the budget, until the reply replaces
  // them with the level's first page.
  const load = useCallback(
    async (id: string, again = false): Promise<void> => {
      sequence.current += 1;
      const request = sequence.current;
      requests.current.set(id, request);
      const shown = again ? nodesRef.current.get(id) : undefined;
      const shownRows = shown?.kind === "ready" ? shown.rows.length : undefined;
      const requestedRows = Math.min(pageSize, Math.max(remaining(id), 0));
      if (requestedRows === 0) {
        budget.current.delete(id);
        patch(id, { kind: "budget" });
        return;
      }
      budget.current.set(id, Math.max(requestedRows, shownRows ?? 0));
      if (shownRows === undefined) patch(id, { kind: "loading" });
      let outcome = await readPage(id, undefined, requestedRows);
      // A reply the host dropped (the page's search or address moved on while it was read) is read
      // again once under the page as it is now.
      if (outcome === undefined && live(id, request))
        outcome = await readPage(id, undefined, requestedRows);
      if (!live(id, request)) return;
      if (outcome === undefined || outcome.status !== "ready") {
        budget.current.delete(id);
        patch(id, { kind: outcome?.status ?? "error" });
        return;
      }
      const rows = outcome.level.rows.slice(0, requestedRows);
      budget.current.set(id, rows.length);
      patch(id, {
        kind: "ready",
        rows,
        ...(outcome.level.next === undefined ? {} : { next: outcome.level.next }),
        more: "idle",
        capped: false,
      });
    },
    [pageSize, remaining, patch, readPage, live],
  );

  const showMore = useCallback(
    async (id: string): Promise<void> => {
      const state = nodesRef.current.get(id);
      if (state?.kind !== "ready" || state.next === undefined || state.more === "reading") return;
      const request = requests.current.get(id) ?? 0;
      const requestedRows = Math.min(pageSize, Math.max(remaining(id) - state.rows.length, 0));
      if (requestedRows === 0) {
        patch(id, { ...state, capped: true });
        return;
      }
      budget.current.set(id, state.rows.length + requestedRows);
      patch(id, { ...state, more: "reading" });
      const outcome = await readPage(id, state.next, requestedRows);
      if (!live(id, request)) return;
      // A dropped reply leaves the shown rows as they were.
      if (outcome === undefined) {
        budget.current.set(id, state.rows.length);
        patch(id, { ...state, more: "idle" });
        return;
      }
      // A refused or expired position keeps the rows already shown, which were read under the
      // viewer's access; the level offers no further page.
      if (outcome.status === "refused") {
        budget.current.set(id, state.rows.length);
        patch(id, { kind: "ready", rows: state.rows, more: "failed", capped: false });
        return;
      }
      if (outcome.status === "error") {
        budget.current.set(id, state.rows.length);
        patch(id, { ...state, more: "failed" });
        return;
      }
      const known = new Set(state.rows.map((row) => row.recordId));
      const added =
        outcome.status === "ready"
          ? outcome.level.rows.filter((row) => !known.has(row.recordId)).slice(0, requestedRows)
          : [];
      const rows = [...state.rows, ...added];
      budget.current.set(id, rows.length);
      const next = outcome.status === "ready" ? outcome.level.next : undefined;
      patch(id, {
        kind: "ready",
        rows,
        ...(next === undefined ? {} : { next }),
        more: "idle",
        capped: false,
      });
    },
    [pageSize, remaining, patch, readPage, live],
  );

  // The controls in the reported entries call the latest reads, so a new read handler never
  // reports the whole tree again.
  const reads = useRef({ load, showMore });
  reads.current = { load, showMore };

  const wanted = useMemo(
    () => reachableOpen(expandedRecordIds, pageRows, nodes),
    [expandedRecordIds, pageRows, nodes],
  );
  // Only a new write reads a level again, never a level opened since.
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;

  useEffect(() => {
    mounted.current = true;
    const held = requests.current;
    const heldBudget = budget.current;
    return () => {
      mounted.current = false;
      held.clear();
      heldBudget.clear();
    };
  }, []);

  // A settled write on a row of an opened level (an inline edit or a row command) reads that level
  // again, and a write over unnamed rows (a bulk run) reads every opened level again: the host's
  // refresh reads only the page, and a child row must never keep a value or a revision the server
  // has since replaced.
  useEffect(() => {
    if (written === undefined) return;
    for (const id of wantedRef.current) {
      const node = nodesRef.current.get(id);
      if (node?.kind !== "ready") continue;
      if (written.recordId === undefined) {
        void reads.current.load(id, true);
        continue;
      }
      if (node.rows.some((row) => row.recordId === written.recordId)) {
        void reads.current.load(id, true);
        return;
      }
    }
  }, [written]);

  // Opening a row reads its level once; closing it (or closing a parent, or reading the parent
  // again) drops the level and gives its rows back to the budget.
  useEffect(() => {
    const open = new Set(wanted);
    for (const id of wanted) if (!requests.current.has(id)) void load(id);
    for (const id of [...requests.current.keys()]) {
      if (open.has(id)) continue;
      requests.current.delete(id);
      budget.current.delete(id);
      patch(id, undefined);
    }
  }, [wanted, load, patch]);

  const beneath = useMemo((): SubRowsBeneath => {
    const named = new Map<string, DisplayRow>();
    for (const row of pageRows) named.set(row.recordId, row);
    for (const node of nodes.values())
      if (node.kind === "ready") for (const row of node.rows) named.set(row.recordId, row);
    const nameOf = (id: string): string => {
      const row = named.get(id);
      return row === undefined || heading === undefined
        ? "this record"
        : cellValueToText(row.cells[heading] ?? { kind: "empty" }) || "this record";
    };
    const retry = (id: string) => ({ label: "Try again", run: () => void reads.current.load(id) });
    const result = new Map<
      string,
      Readonly<{ entries: readonly SubRowEntry[]; complete: boolean }>
    >();
    for (const id of wanted) {
      const state = nodes.get(id);
      if (state === undefined) continue;
      const notice = (
        suffix: string,
        tone: "info" | "alert",
        message: string,
        extra: Partial<Extract<SubRowEntry, { kind: "notice" }>> = {},
      ): SubRowEntry => ({ kind: "notice", id: `${id}:${suffix}`, tone, message, ...extra });
      switch (state.kind) {
        case "loading":
          result.set(id, {
            entries: [
              notice("loading", "info", `Reading child records of ${nameOf(id)}`, { busy: true }),
            ],
            complete: false,
          });
          break;
        case "refused":
          result.set(id, {
            entries: [notice("refused", "info", "You do not have access to these records")],
            complete: true,
          });
          break;
        case "budget":
          result.set(id, {
            entries: [
              notice(
                "budget",
                "info",
                "Close another branch to make room for this page of child records.",
                { action: retry(id) },
              ),
            ],
            complete: false,
          });
          break;
        case "error":
          result.set(id, {
            entries: [
              notice("error", "alert", "The child records could not be read.", {
                action: retry(id),
              }),
            ],
            complete: false,
          });
          break;
        case "empty":
          result.set(id, {
            entries: [notice("empty", "info", "No child records")],
            complete: true,
          });
          break;
        case "ready": {
          const entries: SubRowEntry[] = state.rows.map((row) => ({ kind: "row", row }));
          // A level read with no readable rows says so, as an empty reply does.
          if (state.rows.length === 0 && state.next === undefined)
            entries.push(notice("empty", "info", "No child records"));
          if (state.next !== undefined)
            entries.push({
              kind: "notice",
              id: `${id}:more`,
              tone: "info",
              action: {
                label: state.more === "reading" ? "Reading…" : "Show more",
                disabled: state.more === "reading",
                run: () => void reads.current.showMore(id),
              },
            });
          if (state.capped && state.next !== undefined)
            entries.push(
              notice(
                "capped",
                "info",
                `This table shows at most ${TREE_ROW_BUDGET} rows at once. Close a branch to see more.`,
              ),
            );
          if (state.more === "failed")
            entries.push(notice("failed", "alert", "More child records could not be read."));
          result.set(id, { entries, complete: state.next === undefined });
          break;
        }
      }
    }
    return result;
  }, [wanted, nodes, pageRows, heading]);

  useEffect(() => {
    publish(beneath);
  }, [beneath, publish]);

  return null;
}

/**
 * The records beneath the rows of a tree table. The table's own page is the first level; every level
 * below is read on the server only when its row is opened, within one budget of rows for the whole
 * table, and given back when it is closed. A level is read in the table's order: a new order reads
 * every opened level again.
 */
function SubRows(props: GridFeatureSubRowsProps) {
  return <Levels key={JSON.stringify(props.context.sort ?? null)} {...props} />;
}

export const gridFeature: GridFeatureModule = { SubRows };
