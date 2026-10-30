import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RecordsSelectionInput, RecordsTableExportFormat } from "@vortex/platform/schema";
import type {
  DisplaySemanticEvent,
  DisplayTableExportRun,
  DisplayTableExportScope,
  DisplayTablePayload,
} from "@vortex/ui";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import type { SelectedRecords } from "./types";

/**
 * Exports of a Records table: one request per export to the server, which authorises it again and
 * streams the file. The browser holds the bytes only to hand the finished file to the person; a
 * file that stops short, or that the person cancels, is dropped and never saved. Progress is the
 * bytes received. Any navigation to another page ends an export in progress.
 */
export function useRecordsExport({
  model,
  navigationKey,
  matchingOf,
}: Readonly<{
  model: ApplicationPageModel;
  navigationKey: string;
  /** The sealed descriptor and unticked records of "every matching record", when selected. */
  matchingOf: (
    placementId: string,
    table: DisplayTablePayload,
  ) => Readonly<{ token: string; excluded: readonly string[] }> | undefined;
}>) {
  const [runs, setRuns] = useState<Readonly<Record<string, DisplayTableExportRun>>>({});
  const controllers = useRef(new Map<string, AbortController>());

  // Another page of the application ends an export and forgets its result.
  useEffect(() => {
    const held = controllers.current;
    return () => {
      for (const controller of held.values()) controller.abort();
      held.clear();
      setRuns({});
    };
  }, [navigationKey]);

  const record = useCallback(
    (placementId: string, run: DisplayTableExportRun | undefined): void => {
      setRuns((current) => {
        const next = { ...current };
        if (run === undefined) delete next[placementId];
        else next[placementId] = run;
        return next;
      });
    },
    [],
  );

  const start = useCallback(
    async (
      placementId: string,
      table: DisplayTablePayload,
      held: SelectedRecords | undefined,
      scope: DisplayTableExportScope,
      format: RecordsTableExportFormat,
    ): Promise<void> => {
      if (controllers.current.has(placementId)) return;
      let selection: RecordsSelectionInput;
      let token: string | undefined;
      if (scope === "selected") {
        const items = [...(held ?? [])];
        if (items.length === 0 || table.selectionToken === undefined) return;
        selection = { kind: "ids", items };
        token = table.selectionToken;
      } else if (scope === "matching") {
        const matching = matchingOf(placementId, table);
        if (matching === undefined) return;
        selection = { kind: "matching", token: matching.token, excluded: [...matching.excluded] };
      } else {
        if (table.selectionToken === undefined) return;
        selection = { kind: "matching", token: table.selectionToken, excluded: [] };
      }
      const controller = new AbortController();
      const runId = crypto.randomUUID();
      controllers.current.set(placementId, controller);
      record(placementId, { runId, status: "running", scope, bytes: 0 });
      try {
        const { streamRecordsExport } = await import("./records-export-stream");
        await streamRecordsExport({
          model,
          placementId,
          format,
          selection,
          token,
          table,
          controller,
          runId,
          scope,
          record,
        });
      } catch (error) {
        if (controller.signal.aborted) record(placementId, { runId, status: "cancelled" });
        else {
          console.error("[page] the export did not finish", error);
          record(placementId, { runId, status: "incomplete" });
        }
      } finally {
        controllers.current.delete(placementId);
      }
    },
    [matchingOf, model, record],
  );

  const eventsFor = useCallback(
    (placementId: string, table: DisplayTablePayload, held: SelectedRecords | undefined) => ({
      export_requested: (event: DisplaySemanticEvent) => {
        if (event.event !== "export_requested") return;
        return start(placementId, table, held, event.scope, event.format);
      },
      export_cancelled: (event: DisplaySemanticEvent) => {
        if (event.event !== "export_cancelled") return;
        controllers.current.get(placementId)?.abort();
      },
    }),
    [start],
  );

  /** The table values with the export the page runtime follows. */
  const decorate = useCallback(
    (placementId: string, values: Readonly<Record<string, unknown>>) => {
      const run = runs[placementId];
      return run === undefined ? values : { ...values, exportRun: run };
    },
    [runs],
  );

  return useMemo(() => ({ eventsFor, decorate }), [eventsFor, decorate]);
}
