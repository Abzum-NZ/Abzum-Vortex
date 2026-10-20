"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { Button } from "../../components/button";
import { Skeleton } from "../../components/skeleton";
import { cellValueToText, DisplayCellView } from "../cell";
import {
  fail,
  parseTablePayload,
  requireExactKeys,
  requireRecord,
  type DisplayColumn,
  type DisplayRow,
} from "../projected-data";
import { RowExpansionToggle } from "../row-expansion-toggle";
import type { GridFeatureModule, GridFeatureRowProps } from "./registry";

/** The rows a tree table holds at once: its page and every level opened beneath it. */
const TREE_ROW_BUDGET = 200;
const INDENT_REM = 1.25;

type Level = Readonly<{
  columns: readonly DisplayColumn[];
  rows: readonly DisplayRow[];
  next?: string;
}>;
type Outcome =
  Readonly<{ status: "ready"; level: Level }> | Readonly<{ status: "empty" | "refused" | "error" }>;
type LevelState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{
      kind: "ready";
      level: Level;
      more: "idle" | "reading" | "failed";
      /** Rows the shared budget left out: further levels wait until a branch is closed. */
      capped: boolean;
    }>
  | Readonly<{ kind: "empty" | "refused" | "error" | "budget" }>;

const location = { propertyPath: ["tree"] };

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
          columns: payload.columns,
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
const budgets = new WeakMap<object, Map<string, number>>();
const budgetOf = (key: object): Map<string, number> => {
  const held = budgets.get(key);
  if (held !== undefined) return held;
  const created = new Map<string, number>();
  budgets.set(key, created);
  return created;
};
const usedExcept = (budget: ReadonlyMap<string, number>, nodeKey: string): number => {
  let used = 0;
  for (const [key, rows] of budget) if (key !== nodeKey) used += rows;
  return used;
};

type LevelProps = Readonly<{
  readLevel: NonNullable<GridFeatureRowProps["context"]["events"]>["row_expanded"];
  budget: Map<string, number>;
  /** Rows the table's own page already holds. */
  pageRows: number;
  parentRecordId: string;
  nodeKey: string;
  depth: number;
  columns: readonly DisplayColumn[] | undefined;
  parentName: string;
  panelId: string;
}>;

/**
 * The records beneath one row: read only while the row is open (one read when it opens, one per
 * "Show more"; nothing when it closes, which also gives its rows back to the shared budget). Each
 * record shows the table's columns with the table's own cell renderer; a record the viewer may
 * read a child of offers its own toggle, so levels open to any depth.
 */
function TreeLevel({
  readLevel,
  budget,
  pageRows,
  parentRecordId,
  nodeKey,
  depth,
  columns: inherited,
  parentName,
  panelId,
}: LevelProps): ReactElement {
  const [state, setState] = useState<LevelState>({ kind: "loading" });
  const [open, setOpen] = useState<readonly string[]>([]);
  const mounted = useRef(true);

  const remaining = useCallback(
    (): number => TREE_ROW_BUDGET - pageRows - usedExcept(budget, nodeKey),
    [budget, nodeKey, pageRows],
  );

  const readPage = useCallback(
    async (token: string | undefined): Promise<Outcome | undefined> => {
      if (readLevel === undefined) return { status: "error" };
      try {
        return parseOutcome(
          await readLevel({
            event: "row_expanded",
            recordId: parentRecordId,
            ...(token === undefined ? {} : { continuationToken: token }),
          }),
        );
      } catch (error) {
        console.error("[display] a tree level could not be read", error);
        return { status: "error" };
      }
    },
    [readLevel, parentRecordId],
  );

  const keep = useCallback(
    (rows: readonly DisplayRow[]): Readonly<{ rows: readonly DisplayRow[]; capped: boolean }> => {
      const room = Math.max(remaining(), 0);
      return { rows: rows.slice(0, room), capped: rows.length > room };
    },
    [remaining],
  );

  const load = useCallback(async () => {
    if (remaining() <= 0) {
      setState({ kind: "budget" });
      return;
    }
    setState({ kind: "loading" });
    const outcome = await readPage(undefined);
    if (!mounted.current || outcome === undefined) return;
    if (outcome.status !== "ready") {
      budget.delete(nodeKey);
      setState({ kind: outcome.status });
      return;
    }
    const { rows, capped } = keep(outcome.level.rows);
    budget.set(nodeKey, rows.length);
    setState({
      kind: "ready",
      level: {
        columns: outcome.level.columns,
        rows,
        ...(capped || outcome.level.next === undefined ? {} : { next: outcome.level.next }),
      },
      more: "idle",
      capped,
    });
  }, [budget, keep, nodeKey, readPage, remaining]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      budget.delete(nodeKey);
    };
  }, [budget, load, nodeKey]);

  const showMore = async (): Promise<void> => {
    if (state.kind !== "ready" || state.level.next === undefined || state.more === "reading")
      return;
    const shown = state.level;
    setState({ ...state, more: "reading" });
    const outcome = await readPage(shown.next);
    if (!mounted.current) return;
    // A dropped reply leaves the shown rows as they were.
    if (outcome === undefined) {
      setState({ kind: "ready", level: shown, more: "idle", capped: state.capped });
      return;
    }
    if (outcome.status === "refused") {
      budget.delete(nodeKey);
      setState({ kind: "refused" });
      return;
    }
    if (outcome.status === "error") {
      setState({ kind: "ready", level: shown, more: "failed", capped: state.capped });
      return;
    }
    const known = new Set(shown.rows.map((row) => row.recordId));
    const added =
      outcome.status === "ready"
        ? outcome.level.rows.filter((row) => !known.has(row.recordId))
        : [];
    const { rows: fitting, capped } = keep([...shown.rows, ...added]);
    budget.set(nodeKey, fitting.length);
    const next = outcome.status === "ready" ? outcome.level.next : undefined;
    setState({
      kind: "ready",
      level: {
        columns: shown.columns,
        rows: fitting,
        ...(capped || next === undefined ? {} : { next }),
      },
      more: "idle",
      capped,
    });
  };

  const toggle = (recordId: string): void =>
    setOpen((current) =>
      current.includes(recordId)
        ? current.filter((candidate) => candidate !== recordId)
        : [...current, recordId],
    );

  if (state.kind === "loading")
    return (
      <div
        role="status"
        aria-label={`Reading child records of ${parentName}`}
        className="flex flex-col gap-2 py-1"
        style={{ paddingInlineStart: `${(depth - 2) * INDENT_REM}rem` }}
      >
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-5 w-full" />
        ))}
      </div>
    );
  if (state.kind === "refused")
    return (
      <p role="status" className="m-0 py-1 text-sm text-muted-foreground">
        You do not have access to these records
      </p>
    );
  if (state.kind === "budget")
    return (
      <p role="status" className="m-0 py-1 text-sm text-muted-foreground">
        This table shows at most {TREE_ROW_BUDGET} rows at once. Close another branch to open this
        one.
      </p>
    );
  if (state.kind === "error")
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 py-1 text-sm">
        <span className="text-muted-foreground">The child records could not be read.</span>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  if (state.kind === "empty")
    return (
      <p role="status" className="m-0 py-1 text-sm text-muted-foreground">
        No child records
      </p>
    );

  if (state.kind !== "ready") return fail("A tree level has an unhandled state", location);
  const { level, more, capped } = state;
  const shownColumns = inherited ?? level.columns;
  const template: CSSProperties = {
    gridTemplateColumns: `repeat(${Math.max(shownColumns.length, 1)}, minmax(0, 1fr))`,
  };
  return (
    <div
      id={panelId}
      role="treegrid"
      aria-label={`Child records of ${parentName}`}
      className="flex flex-col text-sm"
    >
      {depth === 2 ? (
        <div
          role="row"
          className="grid gap-2 border-b py-1 text-xs text-muted-foreground"
          style={template}
        >
          {shownColumns.map((column) => (
            <div key={column.key} role="columnheader" className="min-w-0 truncate px-2">
              {column.label}
            </div>
          ))}
        </div>
      ) : null}
      {level.rows.map((child) => {
        const childKey = `${nodeKey}/${child.recordId}`;
        const expanded = open.includes(child.recordId);
        const name =
          cellValueToText(child.cells[shownColumns[0]?.key ?? ""] ?? { kind: "empty" }) ||
          "this record";
        const childPanelId = `${panelId}-${child.recordId}`;
        return (
          <div key={child.recordId} role="none" data-vortex-tree-record-id={child.recordId}>
            <div
              role="row"
              aria-level={depth}
              {...(child.hasChildren === true ? { "aria-expanded": expanded } : {})}
              className="grid items-center gap-2 border-b py-1 hover:bg-muted/60"
              style={template}
            >
              {shownColumns.map((column, index) => (
                <div
                  key={column.key}
                  role="gridcell"
                  className="flex min-w-0 items-center gap-1 truncate px-2"
                  style={
                    index === 0
                      ? { paddingInlineStart: `${(depth - 2) * INDENT_REM + 0.5}rem` }
                      : undefined
                  }
                >
                  {index === 0 ? (
                    child.hasChildren === true ? (
                      <RowExpansionToggle
                        name={name}
                        noun="child records"
                        expanded={expanded}
                        panelId={childPanelId}
                        onToggle={() => toggle(child.recordId)}
                      />
                    ) : (
                      <span aria-hidden="true" className="inline-block size-7 shrink-0" />
                    )
                  ) : null}
                  <span className="min-w-0 truncate">
                    <DisplayCellView value={child.cells[column.key] ?? { kind: "empty" }} />
                  </span>
                </div>
              ))}
            </div>
            {expanded && child.hasChildren === true ? (
              <TreeLevel
                readLevel={readLevel}
                budget={budget}
                pageRows={pageRows}
                parentRecordId={child.recordId}
                nodeKey={childKey}
                depth={depth + 1}
                columns={shownColumns}
                parentName={name}
                panelId={childPanelId}
              />
            ) : null}
          </div>
        );
      })}
      {level.next === undefined ? null : (
        <div className="py-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={more === "reading"}
            onClick={() => void showMore()}
          >
            {more === "reading" ? "Reading…" : "Show more"}
          </Button>
        </div>
      )}
      {capped ? (
        <p role="status" className="m-0 py-1 text-xs text-muted-foreground">
          This table shows at most {TREE_ROW_BUDGET} rows at once. Close a branch to see more.
        </p>
      ) : null}
      {more === "failed" ? (
        <p role="alert" className="m-0 py-1 text-xs text-muted-foreground">
          More child records could not be read.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The records beneath one row of a tree table. The table's own page is the first level; every level
 * below is read on the server only when its row is opened, within one budget of rows for the whole
 * table, and given back when it is closed.
 */
function Beneath({ context, row }: GridFeatureRowProps): ReactElement {
  const readLevel = context.events?.row_expanded;
  if (context.features.tree === undefined) fail("A tree requires its feature projection", location);
  const budget = useMemo(() => budgetOf(readLevel ?? context), [readLevel, context]);
  const heading = context.columns[0]?.key;
  const name =
    heading === undefined
      ? "this record"
      : cellValueToText(row.cells[heading] ?? { kind: "empty" }) || "this record";
  return (
    <TreeLevel
      readLevel={readLevel}
      budget={budget}
      pageRows={context.rows.length}
      parentRecordId={row.recordId}
      nodeKey={row.recordId}
      depth={2}
      columns={undefined}
      parentName={name}
      panelId={`tree-${row.recordId}`}
    />
  );
}

export const gridFeature: GridFeatureModule = { RowExpansion: Beneath };
