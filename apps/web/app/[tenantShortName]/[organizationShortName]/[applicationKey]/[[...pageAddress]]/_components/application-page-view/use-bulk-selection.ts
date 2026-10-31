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
  recordsTableBulkRequestMaximum,
  recordsTableRunResultSchema,
  type NamedActionAvailability,
  type RecordsSelectionInput,
  type RecordsTableBulkRunLine,
} from "@vortex/platform/schema";
import type {
  DisplaySemanticEvent,
  DisplayTableBulkRun,
  DisplayTablePayload,
  DisplayTableSelectionScope,
} from "@vortex/ui";
import type {
  ApplicationPageModel,
  PlacementFlowBinding,
} from "../../../../../../_lib/application-page";
import { postJson } from "../../../../../../_lib/post-json";
import { recordsTableAddress } from "./records-table-address";
import { tablePayloadFor } from "./placement-helpers";
import type { DispatchOutcome, PageSelection, SelectedRecords } from "./types";

/**
 * "Every matching record" of one table: the read's sealed descriptor it was chosen on, its count
 * (or why it could not be counted) and the records the person unticked since.
 */
type HeldScope = Readonly<{
  token: string;
  scope:
    | Exclude<DisplayTableSelectionScope, { kind: "matching" }>
    | Readonly<{ kind: "matching"; count: number }>;
  excluded: readonly string[];
}>;

/** How often, and for how long, a background run the person started is asked how far it has got. */
const runFollowMilliseconds = 2_000;
const runFollowReads = 300;

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
  runBinding,
}: Readonly<{
  runBinding: (
    placementId: string,
    binding: PlacementFlowBinding,
    supplied: Record<string, unknown>,
    selectedRecordId?: string,
    gestureSubject?: undefined,
    afterAccepted?: undefined,
    clickId?: string,
    reportOnControl?: "transient",
  ) => Promise<DispatchOutcome>;
  model: ApplicationPageModel;
  navigationKey: string;
  currentData: ApplicationPageModel["data"];
  selection: PageSelection;
  setSelection: Dispatch<SetStateAction<PageSelection>>;
  refreshPlacements: (placementIds: readonly string[]) => Promise<void>;
}>) {
  const [scopes, setScopes] = useState<Readonly<Record<string, HeldScope>>>({});
  const [runs, setRuns] = useState<Readonly<Record<string, DisplayTableBulkRun>>>({});
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
    (placementId: string, table: DisplayTablePayload): HeldScope | undefined => {
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
        const response = await postJson("/api/records-table/selection-count", {
          ...recordsTableAddress(model),
          placementId,
          token,
        });
        const result = recordsSelectionCountResultSchema.safeParse(response.body);
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

  /**
   * Waits for a background run the person started, and the runs it started after itself, to end:
   * "succeeded" or "failed", "running" when it is still going after the time followed, or "left"
   * when the person has gone to another page.
   */
  const followRun = useCallback(
    async (
      placementId: string,
      run: string,
      owner: unknown,
    ): Promise<"succeeded" | "failed" | "running" | "left"> => {
      for (let read = 0; read < runFollowReads; read += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, runFollowMilliseconds));
        if (navigation.current !== owner) return "left";
        try {
          const response = await postJson("/api/records-table/run", {
            ...recordsTableAddress(model),
            placementId,
            run,
          });
          const parsed = recordsTableRunResultSchema.safeParse(response.body);
          if (!parsed.success) throw new Error("BACKGROUND_RUN_REPLY_INVALID");
          if (parsed.data.kind === "refused") return "failed";
          if (parsed.data.kind === "read" && parsed.data.state !== "running") {
            if (parsed.data.state === "failed")
              console.error(`[page] the background run failed: ${parsed.data.failureCode}`);
            return parsed.data.state;
          }
        } catch (error) {
          // A read that fails is asked again at the next interval.
          console.error("[page] the background run could not be read", error);
        }
      }
      return "running";
    },
    [model],
  );

  const runAction = useCallback(
    async (
      placementId: string,
      table: DisplayTablePayload,
      held: SelectedRecords | undefined,
      actionKey: string,
      bindings: readonly PlacementFlowBinding[],
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
          const binding = bindings.find(
            (candidate) =>
              candidate.event === "bulk_action" && candidate.eventId === action.eventId,
          );
          if (binding === undefined)
            throw new Error("BULK_ACTION_BINDING_MISSING: the table names no flow for the action");
          // One run of the action's bound flow: the chosen rows change in one transaction, or none
          // do; every matching record starts the flow's background run instead.
          const outcome = await runBinding(
            placementId,
            binding,
            selection.kind === "ids"
              ? {
                  // Few rows run in this request; more are queued to run on the back end.
                  [selection.items.length > recordsTableBulkRequestMaximum ? "queued" : "subjects"]:
                    selection.items.map((item) => [item.recordId, item.revision]),
                  [selection.items.length > recordsTableBulkRequestMaximum ? "subjects" : "queued"]:
                    [],
                  selection: "",
                  excluded: [],
                }
              : {
                  subjects: [],
                  queued: [],
                  selection: selection.token,
                  excluded: selection.excluded,
                },
            undefined,
            undefined,
            undefined,
            crypto.randomUUID(),
            "transient",
          );
          // A run whose outcome the page cannot tell offers its own Retry (the dispatch shows it);
          // the table is read again so the person sees what the run changed.
          if (
            !outcome.confirmed &&
            !outcome.completed &&
            !outcome.changed &&
            outcome.notice === undefined
          ) {
            setRuns((current) => without(current, placementId));
            await refreshPlacements([placementId]);
            return;
          }
          // Every matching record, or more chosen rows than a request holds, runs on the back end a
          // page at a time: the start ends the selection and the run is followed until it ends.
          let ended = outcome.confirmed;
          if (
            outcome.completed &&
            (selection.kind === "matching" ||
              selection.items.length > recordsTableBulkRequestMaximum)
          ) {
            if (outcome.run === undefined)
              throw new Error("BULK_ACTION_RUN_MISSING: the start returned no run reference");
            setSelection((current) => without(current, placementId));
            setScopes((current) => without(current, placementId));
            const followed = await followRun(placementId, outcome.run, owner);
            if (followed === "left") return;
            if (followed === "running") {
              // Still going after the time followed: the person sees the table as it is now.
              setRuns((current) => without(current, placementId));
              await refreshPlacements([placementId]);
              return;
            }
            ended = followed === "succeeded";
          }
          last = {
            kind: "summary",
            total: selected,
            done: ended ? selected : 0,
            warnings: [],
            refused: ended
              ? []
              : [{ reason: outcome.changed ? "changed" : "refused", count: selected }],
            notProcessed: ended ? 0 : selected,
            limited: false,
          };
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
    [followRun, refreshPlacements, scopeOf, scopes, setSelection],
  );

  /** The Bulk actions events of one table's placement. */
  const eventsFor = useCallback(
    (
      placementId: string,
      table: DisplayTablePayload,
      held: SelectedRecords | undefined,
      bindings: readonly PlacementFlowBinding[],
    ) => ({
      selection_scope_changed: (event: DisplaySemanticEvent) => {
        if (event.event !== "selection_scope_changed") return;
        if (event.scope === "cleared") return clear(placementId);
        if (table.selectionToken !== undefined)
          return selectMatching(placementId, table.selectionToken);
      },
      bulk_action: (event: DisplaySemanticEvent) => {
        if (event.event !== "bulk_action") return;
        return runAction(placementId, table, held, event.action, bindings);
      },
    }),
    [clear, runAction, selectMatching],
  );

  /**
   * While every matching record is selected, a row's checkbox unticks (or ticks again) that one
   * record; it reports whether it handled the change.
   */
  const toggleMatching = useCallback(
    (
      placementId: string,
      table: DisplayTablePayload,
      recordId: string,
      selected: boolean,
    ): boolean => {
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
      table: DisplayTablePayload,
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
      const scope: DisplayTableSelectionScope | undefined = changed
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
    (placementId: string, table: DisplayTablePayload) => {
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
