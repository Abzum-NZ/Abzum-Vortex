import "server-only";

import { PassThrough, type Transform } from "node:stream";
import { Temporal } from "@js-temporal/polyfill";
import { compareExactDecimals, parseExactDecimal } from "../records/exact-decimal";
import {
  csvCellText,
  RECORDS_TABLE_EXPORT_MAXIMUM_ROWS,
  spreadsheetText,
} from "../definition/application-composition/records-table-features/export";

/**
 * What a spreadsheet keeps as a real number, date or yes/no beside the cell's text. The text is
 * always what the cell shows; `typed` carries the exact value and the spreadsheet number format
 * that reproduces the text, so Excel cells read the same and still sort and sum.
 */
type RecordsExportTyped =
  | Readonly<{ kind: "number"; amount: string; format: string }>
  | Readonly<{ kind: "date"; iso: string; format: string }>
  /** With a format the cell is 1/0 shown by that format (words); without, a real boolean. */
  | Readonly<{ kind: "yes_no"; value: boolean; format?: string }>;

/**
 * One value already projected by the export authority, as text exactly as the grid shows it (or
 * as stored, in raw mode). Links enter only as permitted titles (text), never as link objects.
 * Null is empty. Only the Excel encoder converts `typed` values to spreadsheet numbers/dates,
 * refusing values Excel cannot represent without losing digits.
 */
export type RecordsExportCell = null | Readonly<{ text: string; typed?: RecordsExportTyped }>;

export type RecordsExportPage = readonly (readonly RecordsExportCell[])[];

/**
 * One encoder per download. The transport is independent of the declared file format and validates
 * every page's cells before an encoder receives them; encoders do not repeat that validation.
 */
export type RecordsExportFormat = Readonly<{
  mediaType: string;
  extension: string;
  header: (labels: readonly string[]) => AsyncIterable<Uint8Array>;
  row: (cells: readonly RecordsExportCell[]) => AsyncIterable<Uint8Array>;
  finish: () => AsyncIterable<Uint8Array>;
  abort: () => void;
}>;

const csvQuote = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const csvText = (value: string): string => csvQuote(spreadsheetText(value));

const validateCell = (cell: RecordsExportCell): void => {
  if (cell === null) return;
  if (typeof cell.text !== "string") throw exportError("cell_invalid");
  const typed = cell.typed;
  if (typed === undefined) return;
  switch (typed.kind) {
    case "number":
      if (parseExactDecimal(typed.amount) === undefined || typeof typed.format !== "string")
        throw exportError("cell_invalid");
      return;
    case "date":
      if (Number.isNaN(Date.parse(typed.iso)) || typeof typed.format !== "string")
        throw exportError("cell_invalid");
      return;
    case "yes_no":
      if (typeof typed.value !== "boolean") throw exportError("cell_invalid");
      return;
    default:
      throw exportError("cell_type_invalid");
  }
};

/**
 * UTF-8 with one BOM, comma delimiter, every cell quoted, doubled quotes and CRLF record ends.
 * Only untyped text receives a formula prefix: typed negative numbers keep their sign.
 */
export const recordsCsvFormat = (): RecordsExportFormat => {
  const encoder = new TextEncoder();
  return Object.freeze({
    mediaType: "text/csv; charset=utf-8",
    extension: "csv",
    async *header(labels: readonly string[]) {
      yield encoder.encode(`\uFEFF${labels.map(csvText).join(",")}\r\n`);
    },
    async *row(cells: readonly RecordsExportCell[]) {
      yield encoder.encode(
        `${cells
          .map((cell) => {
            if (cell === null) return csvQuote("");
            // Only a plain number keeps its sign; any other text that starts like a formula is neutralised.
            return csvQuote(csvCellText(cell.text));
          })
          .join(",")}\r\n`,
      );
    },
    async *finish() {},
    abort() {},
  });
};

const excelNumberText = new Intl.NumberFormat("en", {
  useGrouping: false,
  maximumSignificantDigits: 15,
});

const excelNumber = (text: string): number => {
  const exact = parseExactDecimal(text);
  if (exact === undefined) throw exportError("cell_invalid");
  const number = Number(text);
  // Excel supports 15 significant decimal digits. Never silently round an exact platform value.
  const represented = Number.isFinite(number)
    ? parseExactDecimal(excelNumberText.format(number))
    : undefined;
  if (represented === undefined || compareExactDecimals(exact, represented) !== 0)
    throw Object.assign(exportError("excel_number_precision"), {
      message: "Excel cannot keep this number's precision. Choose CSV to keep every digit.",
    });
  return number;
};

const excelDate = (value: string, timeZone: string): Date => {
  const wall =
    value.length === 10
      ? Temporal.PlainDate.from(value).toPlainDateTime()
      : Temporal.Instant.from(value).toZonedDateTimeISO(timeZone).toPlainDateTime();
  if (wall.year < 1900 || wall.year > 9999 || wall.microsecond !== 0 || wall.nanosecond !== 0)
    throw Object.assign(exportError("excel_date_precision"), {
      message: "Excel cannot hold this date. Choose CSV to keep every value.",
    });
  // Excel has no time zone. Store the authored zone's wall clock as a UTC Date for its serialiser.
  const milliseconds = wall.toZonedDateTime("UTC").epochMilliseconds;
  // The 1900 date system includes the fictitious 29 February; ExcelJS uses the later epoch.
  return new Date(milliseconds - (wall.year === 1900 && wall.month < 3 ? 86_400_000 : 0));
};

const excelText = (value: string): string => {
  const text = spreadsheetText(value);
  if (text.length > 32_767) throw exportError("excel_text_limit");
  // ExcelJS drops these controls; UTF-8/XML cannot preserve unpaired surrogates either.
  // eslint-disable-next-line no-control-regex -- Refuse the controls that ExcelJS would silently remove.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uD800-\uDFFF\uFFFE\uFFFF]/u.test(text))
    throw exportError("excel_text_characters");
  return text;
};

/**
 * One sheet, committed rows, no shared-string cache or file. Loaded only for an Excel download.
 * Like CSV this encoder has no authority: its caller supplies only permitted values and metadata.
 */
export const recordsXlsxFormat = async (
  options: Readonly<{
    /** Column widths in grid CSS pixels, in the order of the labels. */
    widths: readonly number[];
    timeZone: string;
  }>,
): Promise<RecordsExportFormat> => {
  const { default: ExcelJS } = await import("exceljs");
  type Archive = Transform & {
    append: (source: Transform, options: { name: string }) => void;
    abort: () => void;
  };
  class SheetStream extends PassThrough {
    override write(
      chunk: unknown,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean {
      // Snapshot StringBuf at write(), before it can be queued and reused by the writer.
      const bytes =
        typeof chunk === "object" &&
        chunk !== null &&
        "toBuffer" in chunk &&
        typeof chunk.toBuffer === "function"
          ? chunk.toBuffer()
          : chunk;
      return typeof encodingOrCallback === "function"
        ? super.write(bytes, encodingOrCallback)
        : super.write(bytes, encodingOrCallback ?? "utf8", callback);
    }
  }
  /**
   * ExcelJS 4.4.0's _openStream uses StreamBuf, whose batch write ignores pipe backpressure.
   * Replace that single hook with Node streams. Await a write callback after each committed row;
   * otherwise even WorkbookWriter can queue an entire sheet behind a slow download.
   */
  class ExportWorkbook extends ExcelJS.stream.xlsx.WorkbookWriter {
    readonly entries = new Set<SheetStream>();
    sheetOutput: SheetStream | undefined;

    get archive(): Archive {
      // This is the pinned writer's ZIP stream, omitted from its public TypeScript declaration.
      return (this as unknown as { zip: Archive }).zip;
    }

    _openStream(path: string): SheetStream {
      const entry = new SheetStream({ highWaterMark: 65_536 });
      this.entries.add(entry);
      entry.on("error", fail);
      entry.once("finish", () => entry.emit("zipped"));
      // WorksheetWriter pauses a newly opened entry. Attach afterwards so Node's pipe resumes it.
      queueMicrotask(() => {
        if (stopped) return;
        try {
          this.archive.append(entry, { name: path });
        } catch (cause) {
          fail(cause);
        }
      });
      if (path === "/xl/worksheets/sheet1.xml") this.sheetOutput = entry;
      return entry;
    }
  }

  const output = new PassThrough({ highWaterMark: 65_536 });
  let workbook: ExportWorkbook | undefined;
  let sheet: ReturnType<ExportWorkbook["addWorksheet"]> | undefined;
  let wake: (() => void) | undefined;
  let stopped = false;
  let failure: unknown;
  let failed = false;
  const notify = (): void => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  const abort = (): void => {
    stopped = true;
    workbook?.archive.abort();
    workbook?.archive.destroy();
    for (const entry of workbook?.entries ?? []) entry.destroy();
    output.destroy();
    notify();
  };
  const fail = (cause: unknown): void => {
    if (stopped) return;
    failed = true;
    failure = cause;
    abort();
  };
  output.on("error", fail);
  output.on("readable", notify);
  output.on("close", notify);

  // Drain ZIP bytes while the operation writes, including finalization. No accumulated workbook.
  async function* chunks(operation: () => Promise<void>): AsyncGenerator<Uint8Array> {
    let done = false;
    void Promise.resolve()
      .then(operation)
      .then(() => {
        done = true;
        notify();
      }, fail);
    for (;;) {
      if (failed) throw failure;
      if (stopped) throw new DOMException("Export cancelled", "AbortError");
      const chunk: Buffer | null = output.read();
      if (chunk !== null) {
        yield chunk;
        continue;
      }
      if (done) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  const rowDrained = (): Promise<void> =>
    new Promise((resolve, reject) => {
      if (workbook?.sheetOutput === undefined) return reject(exportError("excel_sheet_missing"));
      workbook.sheetOutput.write("", (cause?: Error | null) => (cause ? reject(cause) : resolve()));
    });

  return Object.freeze({
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
    header(labels: readonly string[]) {
      if (workbook !== undefined) throw exportError("excel_header_repeated");
      if (options.widths.length !== labels.length) throw exportError("columns_invalid");
      Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(options.timeZone);
      const headings = labels.map(excelText);
      for (const width of options.widths)
        if (!Number.isFinite(width) || width < 1 || width > 1_790)
          throw exportError("column_width_invalid");
      workbook = new ExportWorkbook({ stream: output, useSharedStrings: false, useStyles: true });
      workbook.archive.on("error", fail);
      sheet = workbook.addWorksheet("Records", {
        views: [{ state: "frozen", ySplit: 1 }],
      });
      sheet.columns = options.widths.map((width) => ({ width: Math.max(1, (width - 5) / 7) }));
      return chunks(async () => {
        sheet!.addRow(headings).commit();
        await rowDrained();
      });
    },
    row(cells: readonly RecordsExportCell[]) {
      return chunks(async () => {
        if (sheet === undefined || cells.length !== options.widths.length)
          throw exportError("row_width_invalid");
        const row = sheet.addRow([]);
        cells.forEach((cell, index) => {
          if (cell === null) return;
          const target = row.getCell(index + 1);
          const typed = cell.typed;
          if (typed === undefined) {
            target.value = excelText(cell.text);
            return;
          }
          switch (typed.kind) {
            case "number":
              target.value = excelNumber(typed.amount);
              target.numFmt = typed.format;
              break;
            case "date":
              target.value = excelDate(typed.iso, options.timeZone);
              target.numFmt = typed.format;
              break;
            case "yes_no":
              // Words are shown by the number format, so the cell still sorts and counts.
              target.value = typed.format === undefined ? typed.value : typed.value ? 1 : 0;
              if (typed.format !== undefined) target.numFmt = typed.format;
              break;
          }
        });
        // Preserve a record whose permitted cells are all blank; ExcelJS skips valueless rows.
        if (!row.hasValues) row.getCell(1).value = "";
        row.commit();
        await rowDrained();
      });
    },
    finish() {
      return chunks(async () => {
        if (workbook === undefined || sheet === undefined) throw exportError("excel_sheet_missing");
        sheet.commit();
        await workbook.commit();
      });
    },
    abort,
  });
};

export type RecordsExportOutcome =
  | Readonly<{ kind: "completed"; exported: number }>
  | Readonly<{ kind: "cancelled"; exported: number }>
  | Readonly<{ kind: "incomplete"; exported: number; reason: string }>;

/** Safe for a quoted Content-Disposition filename; the format owns the extension. */
const exportFilename = (name: string, extension: string): string => {
  if (!/^[a-z0-9]{1,10}$/.test(extension)) throw exportError("extension_invalid");
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
  const abortFormat = (): void => {
    try {
      request.format.abort();
    } catch (cause) {
      console.error("[records-export] encoder close failed", {
        part: "export",
        reason: "encoder_close_failed",
        cause,
      });
    }
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
    abortFormat();
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
  let header: AsyncIterable<Uint8Array>;
  let filename: string;
  try {
    throwIfAborted();
    if (
      !Number.isSafeInteger(request.maxRows) ||
      request.maxRows < 1 ||
      request.maxRows > RECORDS_TABLE_EXPORT_MAXIMUM_ROWS
    )
      throw exportError("row_limit_invalid");
    if (request.labels.length === 0 || request.labels.length > 200)
      throw exportError("columns_invalid");
    filename = exportFilename(request.name, request.format.extension);
    iterator = request.pages(abort.signal)[Symbol.asyncIterator]();
    // Read AND validate the first page before the route can send successful download headers. The
    // read races the abort signal, so a cancelled export returns without waiting for the database.
    // The source receives the same signal and cancels its statement in flight on the server.
    const cancelled = new Promise<never>((_, reject) =>
      abort.signal.addEventListener(
        "abort",
        () => reject(new DOMException("Export cancelled", "AbortError")),
        { once: true },
      ),
    );
    page = await Promise.race([iterator.next(), cancelled]);
    throwIfAborted();
    if (!page.done) validatePage(page.value);
    header = request.format.header(request.labels);
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
      abortFormat();
      closeSource();
    }
    throw cause;
  }

  async function* encode(): AsyncGenerator<Uint8Array> {
    yield* header;
    while (!page.done) {
      for (const row of page.value) {
        throwIfAborted();
        yield* request.format.row(row);
        exported += 1;
      }
      // A new page is requested only after downstream consumes all rows of the current one.
      page = { done: true, value: undefined };
      page = await iterator!.next();
      throwIfAborted();
      if (!page.done) validatePage(page.value);
    }
    yield* request.format.finish();
  }
  const bytes = encode();
  const stream = new ReadableStream<Uint8Array>(
    {
      start(current) {
        controller = current;
        if (abort.signal.aborted) current.error(new DOMException("Export cancelled", "AbortError"));
      },
      async pull(current) {
        try {
          throwIfAborted();
          const chunk = await bytes.next();
          throwIfAborted();
          if (chunk.done) {
            current.close();
            settle({ kind: "completed", exported });
            return;
          }
          current.enqueue(chunk.value);
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
          abortFormat();
          closeSource();
          // Never append an error row, finish a partial file or close it as a successful download.
          current.error(exportError(reason, cause));
        }
      },
      cancel() {
        if (settled) return;
        abort.abort();
        settle({ kind: "cancelled", exported });
        abortFormat();
        closeSource();
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, filename, mediaType: request.format.mediaType, outcome };
};
