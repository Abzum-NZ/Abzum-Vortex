import "server-only";

import { moduleFieldValueSchemas } from "../records/module-field-values";

/**
 * Values already projected by the export authority. Links enter only as permitted titles (text),
 * never as link objects or identifiers. Null includes a value withheld on an individual row.
 * Decimal and temporal values retain their stored spelling; no Number, Date or locale conversion.
 */
export type RecordsExportCell =
  | null
  | Readonly<{
      type: "text" | "decimal_number" | "date" | "date_time";
      value: string;
    }>
  | Readonly<{ type: "whole_number"; value: number }>
  | Readonly<{ type: "yes_no"; value: boolean }>;

export type RecordsExportPage = readonly (readonly RecordsExportCell[])[];

/** One encoder per download. The transport is independent of the declared file format. */
export type RecordsExportFormat = Readonly<{
  mediaType: string;
  extension: string;
  header: (labels: readonly string[]) => Uint8Array | Promise<Uint8Array>;
  row: (cells: readonly RecordsExportCell[]) => Uint8Array | Promise<Uint8Array>;
  finish: () => Uint8Array | Promise<Uint8Array>;
}>;

const csvQuote = (value: string): string => `"${value.replaceAll('"', '""')}"`;

/** Prefix spreadsheet formula strings, including header labels; quoting alone is insufficient. */
const csvText = (value: string): string =>
  csvQuote(/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);

const validateCell = (cell: RecordsExportCell): void => {
  if (cell === null) return;
  const result = moduleFieldValueSchemas[cell.type].safeParse(cell.value);
  if (!result.success) throw exportError("cell_invalid", result.error);
};

/**
 * UTF-8 with one BOM, comma delimiter, every cell quoted, doubled quotes and CRLF record ends.
 * Only text receives a formula prefix: typed negative numbers keep their exact decimal value.
 * No object coercion is allowed, so an unresolved link cannot disclose its identifiers by accident.
 */
export const recordsCsvFormat = (): RecordsExportFormat => {
  const encoder = new TextEncoder();
  return Object.freeze({
    mediaType: "text/csv; charset=utf-8",
    extension: "csv",
    header: (labels: readonly string[]) =>
      encoder.encode(`\uFEFF${labels.map(csvText).join(",")}\r\n`),
    row: (cells: readonly RecordsExportCell[]) =>
      encoder.encode(
        `${cells
          .map((cell) => {
            validateCell(cell);
            if (cell === null) return csvQuote("");
            return cell.type === "text" ? csvText(cell.value) : csvQuote(String(cell.value));
          })
          .join(",")}\r\n`,
      ),
    finish: () => new Uint8Array(),
  });
};

export type RecordsExportOutcome =
  | Readonly<{ kind: "completed"; exported: number }>
  | Readonly<{ kind: "cancelled"; exported: number }>
  | Readonly<{ kind: "incomplete"; exported: number; reason: string }>;

/** Safe for a quoted Content-Disposition filename; the format owns the extension. */
const exportFilename = (name: string, extension: string): string => {
  if (!/^[a-z0-9]{1,10}$/.test(extension)) throw new Error("EXPORT_EXTENSION_INVALID");
  const stem = name
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .slice(0, 80);
  return `${stem.length === 0 ? "records" : stem}.${extension}`;
};

const exportError = (reason: string, cause?: unknown): Error =>
  Object.assign(new Error("The export is incomplete. Please try again.", { cause }), {
    part: "export",
    reason,
  });

const failureReason = (cause: unknown, otherwise: string): string =>
  cause instanceof Error &&
  "part" in cause &&
  cause.part === "export" &&
  "reason" in cause &&
  typeof cause.reason === "string"
    ? cause.reason
    : otherwise;

/**
 * Bounded download transport, not an authority or a query endpoint. Its server caller MUST resolve
 * the installed feature, actor, sealed selection, bound query and effective visible fields, and
 * recheck current export/row/field access and release before yielding EACH page. That caller runs
 * the existing protected query service, resolves link titles in one batch and propagates refusals
 * by throwing. Header labels include only fields it has authorised. There is no browser caller.
 *
 * The source receives the download's AbortSignal, including consumer cancellation. It must stop
 * issuing reads after abort. An in-flight protected database call may finish but is never emitted.
 * No row source or permission decision is cached here. Only the current page and stream buffers
 * are retained. There is no background producer, count, job, retained file or reusable link.
 */
export const prepareRecordsExport = async (
  request: Readonly<{
    name: string;
    labels: readonly string[];
    maxRows: number;
    format: RecordsExportFormat;
    pages: (signal: AbortSignal) => AsyncIterable<RecordsExportPage>;
    signal: AbortSignal;
  }>,
): Promise<
  Readonly<{
    stream: ReadableStream<Uint8Array>;
    filename: string;
    mediaType: string;
    /** Resolves successfully only after the source ends and the encoder finishes. */
    outcome: Promise<RecordsExportOutcome>;
  }>
> => {
  if (!Number.isSafeInteger(request.maxRows) || request.maxRows < 1 || request.maxRows > 100_000)
    throw exportError("row_limit_invalid");
  if (request.labels.length === 0 || request.labels.length > 200)
    throw exportError("columns_invalid");
  const filename = exportFilename(request.name, request.format.extension);
  const abort = new AbortController();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let exported = 0;
  let settled = false;
  let complete: (outcome: RecordsExportOutcome) => void;
  const outcome = new Promise<RecordsExportOutcome>((resolve) => {
    complete = resolve;
  });
  const settle = (result: RecordsExportOutcome): void => {
    if (settled) return;
    settled = true;
    request.signal.removeEventListener("abort", onAbort);
    complete(result);
  };
  let iterator: AsyncIterator<RecordsExportPage> | undefined;
  const closeSource = (): void => {
    // return() is best effort: cancellation never waits for an in-flight database request.
    try {
      void iterator?.return?.().catch((cause: unknown) => {
        console.error("[records-export] source close failed", {
          part: "export",
          reason: "source_close_failed",
          cause,
        });
      });
    } catch (cause) {
      console.error("[records-export] source close failed", {
        part: "export",
        reason: "source_close_failed",
        cause,
      });
    }
  };
  const onAbort = (): void => {
    if (settled) return;
    abort.abort();
    settle({ kind: "cancelled", exported });
    controller?.error(new DOMException("Export cancelled", "AbortError"));
    closeSource();
  };
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();

  const throwIfAborted = (): void => abort.signal.throwIfAborted();
  const validatePage = (page: RecordsExportPage): void => {
    if (page.length > 200) throw exportError("page_limit_exceeded");
    if (exported + page.length > request.maxRows)
      throw Object.assign(exportError("row_limit_exceeded"), {
        message: `Too many records to export. Narrow the view to at most ${request.maxRows.toLocaleString("en")} records.`,
      });
    for (const row of page) {
      if (row.length !== request.labels.length) throw exportError("row_width_invalid");
      for (const cell of row) validateCell(cell);
    }
  };

  let page: IteratorResult<RecordsExportPage>;
  let header: Uint8Array;
  try {
    throwIfAborted();
    iterator = request.pages(abort.signal)[Symbol.asyncIterator]();
    // Read AND validate the first page before the route can send successful download headers.
    page = await iterator.next();
    throwIfAborted();
    if (!page.done) validatePage(page.value);
    header = await request.format.header(request.labels);
    throwIfAborted();
  } catch (cause) {
    if (!abort.signal.aborted) {
      const reason = failureReason(cause, "preparation_failed");
      console.error("[records-export] preparation failed", {
        part: "export",
        reason,
        cause,
      });
      abort.abort();
      settle({ kind: "incomplete", exported, reason });
      closeSource();
    }
    throw cause;
  }

  let headerSent = false;
  let rowIndex = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(current) {
        controller = current;
        if (abort.signal.aborted) current.error(new DOMException("Export cancelled", "AbortError"));
      },
      async pull(current) {
        try {
          throwIfAborted();
          if (!headerSent) {
            headerSent = true;
            current.enqueue(header);
            header = new Uint8Array();
            return;
          }
          // A new page is requested only after downstream consumes all rows of the current one.
          while (!page.done && rowIndex === page.value.length) {
            page = { done: true, value: undefined };
            page = await iterator!.next();
            throwIfAborted();
            rowIndex = 0;
            if (!page.done) validatePage(page.value);
          }
          if (page.done) {
            const final = await request.format.finish();
            throwIfAborted();
            if (final.byteLength > 0) current.enqueue(final);
            current.close();
            settle({ kind: "completed", exported });
            return;
          }
          const chunk = await request.format.row(page.value[rowIndex]!);
          throwIfAborted();
          current.enqueue(chunk);
          rowIndex += 1;
          exported += 1;
        } catch (cause) {
          if (abort.signal.aborted) return;
          const reason = failureReason(cause, "stream_failed");
          console.error("[records-export] stream failed", {
            part: "export",
            reason,
            cause,
          });
          abort.abort();
          settle({ kind: "incomplete", exported, reason });
          closeSource();
          // Never append an error row, finish a partial file or close it as a successful download.
          current.error(exportError(reason, cause));
        }
      },
      cancel() {
        if (settled) return;
        abort.abort();
        settle({ kind: "cancelled", exported });
        closeSource();
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, filename, mediaType: request.format.mediaType, outcome };
};
