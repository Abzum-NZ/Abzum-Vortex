import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  recordsSelectionCountResultSchema,
  recordsTableBulkRunLineSchema,
  type RecordsSelectionInput,
  type RecordsTableBulkRunLine,
} from "@vortex/platform/schema";
import type {
  DisplaySemanticEvent,
  TableBulkRun,
  TablePayload,
  TableSelectionScope,
} from "@vortex/ui";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";

/**
 * "Every matching record" of one table: the read's sealed descriptor it was chosen on, its count
 * (or why it could not be counted) and the records the person unticked since.
 */
type HeldScope = Readonly<{
  token: string;
  scope:
    | Exclude<TableSelectionScope, { kind: "matching" }>
    | Readonly<{ kind: "matching"; count: number }>;
  excluded: readonly string[];
}>;

const without = <Value>(
  current: Readonly<Record<string, Value>>,
  placementId: string,
): Readonly<Record<string, Value>> => {
  const key = Object.keys(current).find((held) => held.toLowerCase() === placementId.toLowerCase());
  if (key === undefined) return current;
  const next = { ...current };
  delete next[key];
  return next;
};

/** The application page a bulk request addresses; the server resolves it again. */
const addressOf = (model: ApplicationPageModel) => ({
  tenantShortName: model.invocation.tenantShortName,
  organizationShortName: model.invocation.organizationShortName,
  applicationKey: model.invocation.applicationKey,
  pageKey: model.invocation.pageKey,
});

/**
 * The selection of a Records table beyond its shown page, and its bulk runs. The page's rows stay
 * the only records the browser holds: selecting every matching record keeps the read's sealed
 * descriptor, reads one capped count on the server when the person asks for it, and records the
 * rows the person unticks. A bulk run is one request to the server, which streams its progress
 * and summary; the table is read again once when the run ends. Any new read of the table (another
 * page, sort, filter, search, view or a refresh) seals a new descriptor, so a matching selection
 * of an earlier read no longer applies.
 */
export function useBulkSelection({
  model,
  navigationKey,
  setSelection,
  refreshPlacements,
}: Readonly<{
  model: ApplicationPageModel;
  navigationKey: string;
  setSelection: Dispatch<SetStateAction<Readonly<Record<string, readonly string[]>>>>;
  refreshPlacements: (placementIds: readonly string[]) => Promise<void>;
}>) {
  const [scopes, setScopes] = useState<Readonly<Record<string, HeldScope>>>({});
  const [runs, setRuns] = useState<Readonly<Record<string, TableBulkRun>>>({});
  const runsRef = useRef(runs);
  runsRef.current = runs;
  // Another page of the application starts with nothing selected and no run shown.
  useEffect(() => {
    setScopes({});
    setRuns({});
  }, [navigationKey]);

  const clear = useCallback(
    (placementId: string) => {
      setSelection((current) => without(current, placementId));
      setScopes((current) => without(current, placementId));
      setRuns((current) => without(current, placementId));
    },
    [setSelection],
  );

  /** The held matching selection of this read; an earlier read's descriptor no longer applies. */
  const scopeOf = useCallback(
    (placementId: string, table: TablePayload): HeldScope | undefined => {
      const held = scopes[placementId];
      return held !== undefined && held.token === table.selectionToken ? held : undefined;
    },
    [scopes],
  );

  const selectMatching = useCallback(
    async (placementId: string, token: string): Promise<void> => {
      setScopes((current) => ({
        ...current,
        [placementId]: { token, scope: { kind: "counting" }, excluded: [] },
      }));
      let scope: HeldScope["scope"];
      try {
        const response = await fetch("/api/records-table/selection-count", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          body: JSON.stringify({ ...addressOf(model), placementId, token }),
        });
        const result = recordsSelectionCountResultSchema.safeParse(await response.json());
        if (!result.success) throw new Error(`SELECTION_COUNT_UNREADABLE: ${response.status}`);
        scope =
          result.data.kind === "counted"
            ? { kind: "matching", count: result.data.count }
            : {
                kind: "not_counted",
                reason:
                  result.data.kind === "too_many" || result.data.kind === "search_not_counted"
                    ? result.data.kind
                    : "unavailable",
              };
      } catch (error) {
        console.error("[page] the matching records could not be counted", error);
        scope = { kind: "not_counted", reason: "unavailable" };
      }
      setScopes((current) =>
        current[placementId]?.token === token
          ? { ...current, [placementId]: { token, scope, excluded: [] } }
          : current,
      );
    },
    [model],
  );

  const runAction = useCallback(
    async (
      placementId: string,
      table: TablePayload,
      held: readonly string[] | undefined,
      actionKey: string,
    ): Promise<void> => {
      const action = table.features?.bulkActions?.find(
        (candidate) => candidate.action === actionKey,
      );
      if (action === undefined || runsRef.current[placementId]?.status === "running") return;
      const matching = scopeOf(placementId, table);
      let selection: RecordsSelectionInput;
      let selected: number;
      if (matching?.scope.kind === "matching") {
        selection = { kind: "matching", token: matching.token, excluded: [...matching.excluded] };
        selected = Math.max(0, matching.scope.count - matching.excluded.length);
      } else {
        // The rows the person selected on the shown page, each at the revision they saw.
        const items = (held ?? []).flatMap((recordId) => {
          const row = table.rows.find((candidate) => candidate.recordId === recordId);
          return row?.revision === undefined ? [] : [{ recordId, revision: row.revision }];
        });
        if (items.length === 0) return;
        selection = { kind: "ids", items };
        selected = items.length;
      }
      const label = action.label;
      setRuns((current) => ({
        ...current,
        [placementId]: { status: "running", label, processed: 0 },
      }));
      let last: RecordsTableBulkRunLine | undefined;
      try {
        const response = await fetch("/api/records-table/bulk-action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          body: JSON.stringify({
            ...addressOf(model),
            placementId,
            action: action.action,
            commandId: crypto.randomUUID(),
            selection,
          }),
        });
        if (!response.ok || response.body === null)
          throw new Error(`BULK_ACTION_REFUSED: ${response.status}`);
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffered = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (value !== undefined) buffered += value;
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          for (const text of lines) {
            if (text.trim() === "") continue;
            const line = recordsTableBulkRunLineSchema.parse(JSON.parse(text));
            last = line;
            if (line.kind === "progress")
              setRuns((current) => ({
                ...current,
                [placementId]: {
                  status: "running",
                  label,
                  total: line.total,
                  processed: line.processed,
                },
              }));
          }
          if (done) break;
        }
      } catch (error) {
        console.error("[page] the bulk action did not finish", error);
      }
      setRuns((current) => ({
        ...current,
        [placementId]:
          last?.kind === "summary"
            ? {
                status: "finished",
                label,
                selected,
                summary: {
                  total: last.total,
                  done: last.done,
                  refused: last.refused,
                  notProcessed: last.notProcessed,
                  limited: last.limited,
                },
              }
            : { status: "failed", label },
      }));
      // The run ends the selection; the table is read once, through the ordinary read path.
      setSelection((current) => without(current, placementId));
      setScopes((current) => without(current, placementId));
      await refreshPlacements([placementId]);
    },
    [model, refreshPlacements, scopeOf, setSelection],
  );

  /** The Bulk actions events of one table's placement. */
  const eventsFor = useCallback(
    (placementId: string, table: TablePayload, held: readonly string[] | undefined) => ({
      selection_scope_changed: (event: DisplaySemanticEvent) => {
        if (event.event !== "selection_scope_changed") return;
        if (event.scope === "cleared") return clear(placementId);
        if (table.selectionToken !== undefined)
          return selectMatching(placementId, table.selectionToken);
      },
      bulk_action: (event: DisplaySemanticEvent) => {
        if (event.event !== "bulk_action") return;
        return runAction(placementId, table, held, event.action);
      },
    }),
    [clear, runAction, selectMatching],
  );

  /**
   * While every matching record is selected, a row's checkbox unticks (or ticks again) that one
   * record; it reports whether it handled the change.
   */
  const toggleMatching = useCallback(
    (placementId: string, table: TablePayload, recordId: string, selected: boolean): boolean => {
      const matching = scopeOf(placementId, table);
      if (matching?.scope.kind !== "matching") return false;
      setScopes((current) => {
        const scope = current[placementId];
        if (scope === undefined) return current;
        const excluded = scope.excluded.filter((held) => held !== recordId);
        return {
          ...current,
          [placementId]: { ...scope, excluded: selected ? excluded : [...excluded, recordId] },
        };
      });
      return true;
    },
    [scopeOf],
  );

  /** The table values the page shows: its selection scope and bulk run, beside the read's rows. */
  const decorate = useCallback(
    (
      placementId: string,
      table: TablePayload,
      values: Readonly<Record<string, unknown>>,
    ): Readonly<Record<string, unknown>> | undefined => {
      const matching = scopeOf(placementId, table);
      const run = runs[placementId];
      if (matching === undefined && run === undefined) return undefined;
      const scope: TableSelectionScope | undefined =
        matching === undefined
          ? undefined
          : matching.scope.kind === "matching"
            ? { kind: "matching", count: matching.scope.count, excluded: matching.excluded.length }
            : matching.scope;
      return {
        ...values,
        ...(scope === undefined ? {} : { selectionScope: scope }),
        ...(matching?.scope.kind === "matching"
          ? {
              selectedRecordIds: table.rows
                .map((row) => row.recordId)
                .filter((recordId) => !matching.excluded.includes(recordId)),
            }
          : {}),
        ...(run === undefined ? {} : { bulkRun: run }),
      };
    },
    [runs, scopeOf],
  );

  return useMemo(
    () => ({ eventsFor, toggleMatching, decorate }),
    [eventsFor, toggleMatching, decorate],
  );
}
