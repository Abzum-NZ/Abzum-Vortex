import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  recordsTableExportRefusalSchema,
  type RecordsSelectionInput,
  type RecordsTableExportRefusal,
} from "@vortex/platform/schema";
import type {
  DisplaySemanticEvent,
  TableExportRun,
  TableExportScope,
  TablePayload,
} from "@vortex/ui";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";

/** The application page an export request addresses; the server resolves it again. */
const addressOf = (model: ApplicationPageModel) => ({
  tenantShortName: model.invocation.tenantShortName,
  organizationShortName: model.invocation.organizationShortName,
  applicationKey: model.invocation.applicationKey,
  pageKey: model.invocation.pageKey,
});

const numberFormat = new Intl.NumberFormat();

/** The sentence a person reads when the server refused to start an export. */
const refusalMessage = (refusal: RecordsTableExportRefusal): string => {
  if (refusal.kind === "unavailable") return "The export could not start. Try again.";
  switch (refusal.reason) {
    case "too_many":
      return `Too many records to export${
        refusal.count === undefined ? "" : `: ${numberFormat.format(refusal.count)} are selected`
      }. At most ${numberFormat.format(refusal.limit ?? 0)} can be exported at once; narrow the view and try again.`;
    case "changed":
      return "The table changed since you made this selection, or nothing is left to export. Select the records again.";
    case "not_available":
      return "Export is not available for this table or your access right now.";
  }
};

/** The file name the server chose, from its Content-Disposition. */
const filenameOf = (response: Response): string => {
  const match = /filename="([^"\\]{1,120})"/.exec(
    response.headers.get("content-disposition") ?? "",
  );
  return match?.[1] ?? "records.csv";
};

/** How often the running export reports its bytes, so a large file does not redraw the table per chunk. */
const progressInterval = 150;

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
    table: TablePayload,
  ) => Readonly<{ token: string; excluded: readonly string[] }> | undefined;
}>) {
  const [runs, setRuns] = useState<Readonly<Record<string, TableExportRun>>>({});
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

  const record = useCallback((placementId: string, run: TableExportRun | undefined): void => {
    setRuns((current) => {
      const next = { ...current };
      if (run === undefined) delete next[placementId];
      else next[placementId] = run;
      return next;
    });
  }, []);

  const start = useCallback(
    async (
      placementId: string,
      table: TablePayload,
      held: readonly string[] | undefined,
      scope: TableExportScope,
    ): Promise<void> => {
      if (controllers.current.has(placementId)) return;
      let selection: RecordsSelectionInput;
      let token: string | undefined;
      if (scope === "selected") {
        // The rows the person ticked on the shown page, each at the revision they saw.
        const items = (held ?? []).flatMap((recordId) => {
          const row = table.rows.find((candidate) => candidate.recordId === recordId);
          return row?.revision === undefined ? [] : [{ recordId, revision: row.revision }];
        });
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
      controllers.current.set(placementId, controller);
      record(placementId, { status: "running", scope, bytes: 0 });
      try {
        const viewId = table.layout.views?.selected?.viewId;
        const response = await fetch("/api/records-table/export", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
          body: JSON.stringify({
            ...addressOf(model),
            placementId,
            format: "csv",
            selection,
            ...(token === undefined ? {} : { token }),
            // The saved view the grid showed is a candidate; the server decides the columns.
            ...(viewId === undefined ? {} : { viewId }),
          }),
        });
        if (!response.ok || response.body === null) {
          const refusal = recordsTableExportRefusalSchema.safeParse(
            await response.json().catch(() => undefined),
          );
          record(placementId, {
            status: "refused",
            message: refusalMessage(refusal.success ? refusal.data : { kind: "unavailable" }),
          });
          return;
        }
        const expectedHeader = Number(response.headers.get("x-vortex-export-records"));
        const expected = Number.isSafeInteger(expectedHeader) ? expectedHeader : undefined;
        const filename = filenameOf(response);
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        let reported = 0;
        const reader = response.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value);
          bytes += value.byteLength;
          if (Date.now() - reported >= progressInterval) {
            reported = Date.now();
            record(placementId, {
              status: "running",
              scope,
              bytes,
              ...(expected === undefined ? {} : { expected }),
            });
          }
        }
        // The stream ended cleanly: only now is there a whole file to hand over.
        const url = URL.createObjectURL(
          new Blob(chunks as BlobPart[], { type: "text/csv;charset=utf-8" }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.rel = "noopener";
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
        record(placementId, { status: "finished", scope, filename, expected: expected ?? 0 });
      } catch (error) {
        if (controller.signal.aborted) record(placementId, { status: "cancelled" });
        else {
          console.error("[page] the export did not finish", error);
          record(placementId, { status: "incomplete" });
        }
      } finally {
        controllers.current.delete(placementId);
      }
    },
    [matchingOf, model, record],
  );

  const eventsFor = useCallback(
    (placementId: string, table: TablePayload, held: readonly string[] | undefined) => ({
      export_requested: (event: DisplaySemanticEvent) => {
        if (event.event !== "export_requested") return;
        return start(placementId, table, held, event.scope);
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
