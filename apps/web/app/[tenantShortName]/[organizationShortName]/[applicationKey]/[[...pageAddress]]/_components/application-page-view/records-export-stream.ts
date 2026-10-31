import {
  recordsTableExportRefusalSchema,
  type RecordsSelectionInput,
  type RecordsTableExportRefusal,
  type RecordsTableExportFormat,
} from "@vortex/platform/schema";
import type {
  DisplayTableExportRun,
  DisplayTableExportScope,
  DisplayTablePayload,
} from "@vortex/ui";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import { postJson } from "../../../../../../_lib/post-json";
import { recordsTableAddress } from "./records-table-address";

const numberFormat = new Intl.NumberFormat();

/** The sentence a person reads when the server refused to start an export. */
const refusalMessage = (refusal: RecordsTableExportRefusal): string => {
  if (refusal.kind === "unavailable") return "The export could not start. Try again.";
  switch (refusal.reason) {
    case "request_invalid":
      return "This export request could not be read. Reload the page and try again.";
    case "too_many":
      return `Too many records to export${
        refusal.count === undefined ? "" : `: ${numberFormat.format(refusal.count)} are selected`
      }. At most ${numberFormat.format(refusal.limit ?? 0)} can be exported at once; narrow the view and try again.`;
    case "changed":
      return "The table changed since you made this selection, or nothing is left to export. Select the records again.";
    case "not_available":
      return "Export is not available for this table or your access right now.";
    case "format_not_authored":
      return "This file format is not offered by this table. Choose an available format.";
  }
};

/** The file name the server chose, from its Content-Disposition. */
const filenameOf = (response: Response): string => {
  const match = /filename="([^"\\]{1,120})"/.exec(
    response.headers.get("content-disposition") ?? "",
  );
  if (match === null) throw new Error("The export response has no valid filename");
  return match[1]!;
};

/** How often the running export reports its bytes, so a large file does not redraw the table per chunk. */
const progressInterval = 150;

/** Run the existing export stream after the page has registered its cancellation controller. */
export async function streamRecordsExport({
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
}: Readonly<{
  model: ApplicationPageModel;
  placementId: string;
  format: RecordsTableExportFormat;
  selection: RecordsSelectionInput;
  token: string | undefined;
  table: DisplayTablePayload;
  controller: AbortController;
  runId: string;
  scope: DisplayTableExportScope;
  record: (placementId: string, run: DisplayTableExportRun | undefined) => void;
}>): Promise<void> {
  const viewId = table.layout.views?.selected?.viewId;
  const posted = await postJson(
    "/api/records-table/export",
    {
      ...recordsTableAddress(model),
      placementId,
      format,
      selection,
      ...(token === undefined ? {} : { token }),
      // The saved view the grid showed is a candidate; the server decides the columns.
      ...(viewId === undefined ? {} : { viewId }),
    },
    { signal: controller.signal, read: "stream" },
  );
  const response = posted.response;
  if (!response.ok || response.body === null) {
    const refusal = recordsTableExportRefusalSchema.safeParse(
      await response.json().catch(() => undefined),
    );
    record(placementId, {
      runId,
      status: "refused",
      message: refusalMessage(refusal.success ? refusal.data : { kind: "unavailable" }),
    });
    return;
  }
  const expectedHeader = Number(response.headers.get("x-vortex-export-records"));
  const expected = Number.isSafeInteger(expectedHeader) ? expectedHeader : undefined;
  const filename = filenameOf(response);
  const mediaType = response.headers.get("content-type");
  if (mediaType === null) throw new Error("The export response has no media type");
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
        runId,
        status: "running",
        scope,
        bytes,
        ...(expected === undefined ? {} : { expected }),
      });
    }
  }
  // The stream ended cleanly: only now is there a whole file to hand over.
  const url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: mediaType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  record(placementId, { runId, status: "finished", scope, filename });
}
