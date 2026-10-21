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
  type NamedActionAvailability,
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
import { recordsTableAddress } from "./records-table-address";
import { tablePayloadFor } from "./placement-helpers";
import type { PageSelection, SelectedRecords } from "./types";

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

/**
 * The selection of a Records table's drawn rows, and its bulk runs. Explicit selections hold the
 * revision seen when ticked; selecting every matching record keeps the read's sealed
 * descriptor, reads one capped count on the server when the person asks for it, and records the
 * rows the person unticks. A bulk run is one request to the server, which streams its progress
 * and summary; the table is read again once when the run ends. Any new read of the table (another
 * page, sort, filter, search, view or a refresh) seals a new descriptor, so a matching selection
 * of an earlier read no longer applies.
 */
export function useBulkSelection({
  model,
  navigationKey,
  currentData,
  selection,
  setSelection,
  refreshPlacements,
}: Readonly<{
  model: ApplicationPageModel;
  navigationKey: string;
  currentData: ApplicationPageModel["data"];
  selection: PageSelection;
  setSelection: Dispatch<SetStateAction<PageSelection>>;
  refreshPlacements: (placementIds: readonly string[]) => Promise<void>;
}>) {
  const [scopes, setScopes] = useState<Readonly<Record<string, HeldScope>>>({});
  const [runs, setRuns] = useState<Readonly<Record<string, TableBulkRun>>>({});
  const [availability, setAvailability] = useState<
    Readonly<
      Record<
        string,
        Readonly<{
          data: unknown;
          selected: SelectedRecords;
          records: NamedActionAvailability | "unavailable";
        }>
      >
    >
  >({});
  const heldAvailability = useRef(availability);
  heldAvailability.current = availability;
  const inFlight = useRef(new Set<string>());
  const navigation = useRef({ key: navigationKey });
  if (navigation.current.key !== navigationKey) navigation.current = { key: navigationKey };
  // Another page of the application starts with nothing selected and no run shown.
  useEffect(() => {
    setScopes({});
    setRuns({});
    setAvailability({});
  }, [navigationKey]);

  // One debounced, cancellable request per active selection, never per row or action. The module
  // and response parser are downloaded only after a bulk-enabled table has a visible selection.
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      for (const [placementId, selected] of Object.entries(selection)) {
        if (selected.length === 0 || scopes[placementId] !== undefined) continue;
        const held = heldAvailability.current[placementId];
        // A table whose selection and rows did not change keeps its decisions; no second read.
        if (
          held !== undefined &&
          held.data === currentData[placementId] &&
          held.selected === selected
        )
          continue;
        const table = tablePayloadFor(currentData[placementId]);
        if (table?.features?.bulkActions === undefined) continue;
        void import("./read-action-availability")
          .then(({ readActionAvailability }) =>
            readActionAvailability(
              { ...recordsTableAddress(model), placementId, targets: selected },
              controller.signal,
            ),
          )
          .then((records) => {
            if (!controller.signal.aborted)
              setAvailability((current) => ({
                ...current,
                [placementId]: { data: currentData[placementId], selected, records },
              }));
          })
          .catch((error: unknown) => {
            if (!controller.signal.aborted) {
              console.error("[page] action availability could not be read", error);
              setAvailability((current) => ({
                ...current,
                [placementId]: { data: currentData[placementId], selected, records: "unavailable" },
              }));
            }
          });
      }
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [currentData, model, navigationKey, scopes, selection]);

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
          body: JSON.stringify({ ...recordsTableAddress(model), placementId, token }),
        });
        const result = recordsSelectionCountResultSchema.safeParse(await response.json());
        if (!result.success) throw new Error(`SELECTION_COUNT_UNREADABLE: ${response.status}`);
        scope =
          result.data.kind === "counted"
            ? { kind: "matching", count: result.data.count }
            : {
                kind: "not_counted",
                reason: result.data.kind === "too_many" ? "too_many" : "unavailable",
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
      held: SelectedRecords | undefined,
      actionKey: string,
    ): Promise<void> => {
      const action = table.features?.bulkActions?.find(
        (candidate) => candidate.action === actionKey,
      );
      if (action === undefined || inFlight.current.has(placementId)) return;
      const owner = navigation.current;
      if (scopes[placementId] !== undefined && scopeOf(placementId, table) === undefined) {
        console.error("[page] bulk selection refused", { part: "selection", reason: "changed" });
        return;
      }
      const matching = scopeOf(placementId, table);
      let selection: RecordsSelectionInput;
      let selected: number;
      if (matching?.scope.kind === "matching") {
        selection = { kind: "matching", token: matching.token, excluded: [...matching.excluded] };
        selected = Math.max(0, matching.scope.count - matching.excluded.length);
      } else {
        const items = [...(held ?? [])];
        if (items.length === 0) return;
        selection = { kind: "ids", items };
        selected = items.length;
      }
      const label = action.label;
      // Acquire before scheduling React state: two gestures in one render must not submit twice.
      inFlight.current.add(placementId);
      try {
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
              ...recordsTableAddress(model),
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
              if (line.kind === "progress" && navigation.current === owner)
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
        // A completed request belongs to the page that started it, even after navigation away.
        if (navigation.current !== owner) return;
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
                    warnings: last.warnings,
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
      } finally {
        inFlight.current.delete(placementId);
      }
    },
    [model, refreshPlacements, scopeOf, scopes, setSelection],
  );

  /** The Bulk actions events of one table's placement. */
  const eventsFor = useCallback(
    (placementId: string, table: TablePayload, held: SelectedRecords | undefined) => ({
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
      if (matching === undefined && scopes[placementId] !== undefined)
        setScopes((current) => without(current, placementId));
      if (matching?.scope.kind !== "matching") return false;
      if (!table.rows.some((row) => row.recordId === recordId)) {
        // Matching means query roots only. Selecting a child returns to the explicitly checked
        // page roots, then lets the ordinary selection handler add that one drawn child.
        setScopes((current) => without(current, placementId));
        setSelection((current) => ({
          ...current,
          [placementId]: table.rows.flatMap((row) =>
            matching.excluded.includes(row.recordId) || row.revision === undefined
              ? []
              : [{ recordId: row.recordId, revision: row.revision }],
          ),
        }));
        return false;
      }
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
    [scopeOf, scopes, setSelection],
  );

  /** The table values the page shows: its selection scope and bulk run, beside the read's rows. */
  const decorate = useCallback(
    (
      placementId: string,
      table: TablePayload,
      values: Readonly<Record<string, unknown>>,
    ): Readonly<Record<string, unknown>> | undefined => {
      const matching = scopeOf(placementId, table);
      const changed = scopes[placementId] !== undefined && matching === undefined;
      const run = runs[placementId];
      const held = availability[placementId];
      const selected = selection[placementId] ?? [];
      const records =
        held !== undefined && held.data === currentData[placementId] && held.selected === selected
          ? held.records
          : undefined;
      if (matching === undefined && run === undefined && !changed && records === undefined)
        return undefined;
      const scope: TableSelectionScope | undefined = changed
        ? { kind: "not_counted", reason: "changed" }
        : matching === undefined
          ? undefined
          : matching.scope.kind === "matching"
            ? { kind: "matching", count: matching.scope.count, excluded: matching.excluded.length }
            : matching.scope;
      return {
        ...values,
        ...(scope === undefined ? {} : { selectionScope: scope }),
        ...(changed ? { selectedRecordIds: [] } : {}),
        ...(matching?.scope.kind === "matching"
          ? {
              selectedRecordIds: table.rows
                .map((row) => row.recordId)
                .filter((recordId) => !matching.excluded.includes(recordId)),
            }
          : {}),
        ...(run === undefined ? {} : { bulkRun: run }),
        ...(records === undefined ? {} : { actionAvailability: records }),
      };
    },
    [availability, currentData, runs, scopeOf, scopes, selection],
  );

  /** The sealed descriptor and unticked records of "every matching record", once it is counted. */
  const matchingOf = useCallback(
    (placementId: string, table: TablePayload) => {
      const held = scopeOf(placementId, table);
      return held?.scope.kind === "matching"
        ? { token: held.token, excluded: held.excluded }
        : undefined;
    },
    [scopeOf],
  );

  return useMemo(
    () => ({ eventsFor, toggleMatching, decorate, matchingOf }),
    [eventsFor, toggleMatching, decorate, matchingOf],
  );
}
