import "server-only";

import {
  STRUCTURED_RECORD_IMPORT_FORMAT,
  STRUCTURED_RECORD_IMPORT_MAXIMUM_CELL_SOURCE_BYTES,
  STRUCTURED_RECORD_IMPORT_MAXIMUM_COLUMNS,
  STRUCTURED_RECORD_IMPORT_MAXIMUM_JSON_ENTRIES,
  STRUCTURED_RECORD_IMPORT_MAXIMUM_NESTING_DEPTH,
  STRUCTURED_RECORD_IMPORT_MAXIMUM_ROWS,
  STRUCTURED_RECORD_IMPORT_MAXIMUM_SOURCE_BYTES,
  structuredRecordImportColumnSchema,
  structuredRecordImportFormatSchema,
  type DecodedRecordImportRow,
  type RecordImportSourceRefusalReason,
  type StructuredRecordImportColumn,
} from "@vortex/contracts";

export const STRUCTURED_RECORD_IMPORT_FORMAT_VERSION = STRUCTURED_RECORD_IMPORT_FORMAT;

export type StructuredRecordImportDecodeResult =
  | Readonly<{
      outcome: "decoded";
      columns: readonly StructuredRecordImportColumn[];
      rows: readonly DecodedRecordImportRow[];
    }>
  | Readonly<{
      outcome: "refused";
      reason: RecordImportSourceRefusalReason;
      rowNumber?: number;
      columnNumber?: number;
    }>;

type ParseMode = "normal" | "root" | "columns" | "rows" | "row" | "column";
type SafeParseFailure = Readonly<{
  reason: RecordImportSourceRefusalReason;
  rowNumber?: number;
  columnNumber?: number;
}>;

const refused = (
  reason: RecordImportSourceRefusalReason,
  position?: Readonly<{ rowNumber?: number; columnNumber?: number }>,
): StructuredRecordImportDecodeResult => ({
  outcome: "refused",
  reason,
  ...(position?.rowNumber === undefined ? {} : { rowNumber: position.rowNumber }),
  ...(position?.columnNumber === undefined ? {} : { columnNumber: position.columnNumber }),
});

const isJsonWhitespace = (character: string | undefined): boolean =>
  character === " " || character === "\t" || character === "\r" || character === "\n";

/**
 * Performs a bounded lexical pass before JSON.parse can build nested values.
 * This pass also detects duplicate decoded member names and numeric tokens
 * that JavaScript would otherwise round or interpret as a decimal.
 */
class BoundedJsonScanner {
  private offset = 0;
  private entries = 0;
  private columns = 0;
  private rows = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  scan(): void {
    this.skipWhitespace();
    this.parseValue(0, "root");
    this.skipWhitespace();
    if (this.offset !== this.text.length) this.fail("invalid_json");
  }

  private fail(
    reason: RecordImportSourceRefusalReason,
    rowNumber?: number,
    columnNumber?: number,
  ): never {
    const failure: SafeParseFailure = {
      reason,
      ...(rowNumber === undefined ? {} : { rowNumber }),
      ...(columnNumber === undefined ? {} : { columnNumber }),
    };
    throw failure;
  }

  private skipWhitespace(): void {
    while (isJsonWhitespace(this.text[this.offset])) this.offset += 1;
  }

  private countEntry(): void {
    this.entries += 1;
    if (this.entries > STRUCTURED_RECORD_IMPORT_MAXIMUM_JSON_ENTRIES) {
      this.fail("resource_limit");
    }
  }

  private parseValue(
    containerDepth: number,
    mode: ParseMode,
    cellPosition?: Readonly<{ rowNumber: number; columnNumber: number }>,
  ): void {
    this.countEntry();
    this.skipWhitespace();
    const start = this.offset;
    const character = this.text[this.offset];
    if (character === "{") {
      this.parseObject(containerDepth, mode);
    } else if (character === "[") {
      this.parseArray(containerDepth, mode);
    } else if (character === '"') {
      this.parseString();
    } else if (character === "t") {
      this.parseLiteral("true");
    } else if (character === "f") {
      this.parseLiteral("false");
    } else if (character === "n") {
      this.parseLiteral("null");
    } else if (
      character === "-" ||
      (character !== undefined && character >= "0" && character <= "9")
    ) {
      this.parseNumber();
    } else {
      this.fail("invalid_json");
    }

    if (cellPosition !== undefined) {
      const sourceBytes = Buffer.byteLength(this.text.slice(start, this.offset), "utf8");
      if (sourceBytes > STRUCTURED_RECORD_IMPORT_MAXIMUM_CELL_SOURCE_BYTES) {
        this.fail("cell_too_large", cellPosition.rowNumber, cellPosition.columnNumber);
      }
    }
  }

  private parseObject(containerDepth: number, mode: ParseMode): void {
    if (containerDepth >= STRUCTURED_RECORD_IMPORT_MAXIMUM_NESTING_DEPTH) {
      this.fail("resource_limit");
    }
    this.offset += 1;
    this.skipWhitespace();
    if (this.text[this.offset] === "}") {
      this.offset += 1;
      return;
    }

    const keys = new Set<string>();
    while (true) {
      this.skipWhitespace();
      if (this.text[this.offset] !== '"') this.fail("invalid_json");
      const key = this.parseString();
      this.entries += 1;
      if (this.entries > STRUCTURED_RECORD_IMPORT_MAXIMUM_JSON_ENTRIES) {
        this.fail("resource_limit");
      }
      if (keys.has(key)) this.fail("duplicate_member");
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.offset] !== ":") this.fail("invalid_json");
      this.offset += 1;
      const childMode: ParseMode =
        mode === "root" && key === "columns"
          ? "columns"
          : mode === "root" && key === "rows"
            ? "rows"
            : "normal";
      this.parseValue(containerDepth + 1, childMode);
      this.skipWhitespace();
      if (this.text[this.offset] === "}") {
        this.offset += 1;
        return;
      }
      if (this.text[this.offset] !== ",") this.fail("invalid_json");
      this.offset += 1;
    }
  }

  private parseArray(containerDepth: number, mode: ParseMode): void {
    if (containerDepth >= STRUCTURED_RECORD_IMPORT_MAXIMUM_NESTING_DEPTH) {
      this.fail("resource_limit");
    }
    this.offset += 1;
    this.skipWhitespace();
    if (this.text[this.offset] === "]") {
      this.offset += 1;
      return;
    }

    let rowNumber: number | undefined;
    let columnNumber = 0;
    while (true) {
      let childMode: ParseMode = "normal";
      let cellPosition: Readonly<{ rowNumber: number; columnNumber: number }> | undefined;
      if (mode === "columns") {
        this.columns += 1;
        if (this.columns > STRUCTURED_RECORD_IMPORT_MAXIMUM_COLUMNS) {
          this.fail("too_many_columns");
        }
        childMode = "column";
      } else if (mode === "rows") {
        this.rows += 1;
        if (this.rows > STRUCTURED_RECORD_IMPORT_MAXIMUM_ROWS) this.fail("too_many_rows");
        rowNumber = this.rows;
        childMode = "row";
      } else if (mode === "row") {
        columnNumber += 1;
        if (columnNumber > STRUCTURED_RECORD_IMPORT_MAXIMUM_COLUMNS) {
          this.fail("invalid_document", rowNumber);
        }
        cellPosition = { rowNumber: rowNumber ?? this.rows, columnNumber };
      }
      this.parseValue(containerDepth + 1, childMode, cellPosition);
      this.skipWhitespace();
      if (this.text[this.offset] === "]") {
        this.offset += 1;
        return;
      }
      if (this.text[this.offset] !== ",") this.fail("invalid_json", rowNumber);
      this.offset += 1;
    }
  }

  private parseString(): string {
    const start = this.offset;
    if (this.text[this.offset] !== '"') this.fail("invalid_json");
    this.offset += 1;
    while (this.offset < this.text.length) {
      const character = this.text[this.offset];
      if (character === '"') {
        this.offset += 1;
        try {
          return JSON.parse(this.text.slice(start, this.offset)) as string;
        } catch {
          this.fail("invalid_json");
        }
      }
      if (character === "\\") {
        this.offset += 1;
        const escape = this.text[this.offset];
        if (escape === "u") {
          const digits = this.text.slice(this.offset + 1, this.offset + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) this.fail("invalid_json");
          this.offset += 5;
          continue;
        }
        if (escape === undefined || !['"', "\\", "/", "b", "f", "n", "r", "t"].includes(escape)) {
          this.fail("invalid_json");
        }
        this.offset += 1;
        continue;
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) {
        this.fail("invalid_json");
      }
      this.offset += 1;
    }
    this.fail("invalid_json");
  }

  private parseLiteral(literal: "true" | "false" | "null"): void {
    if (this.text.slice(this.offset, this.offset + literal.length) !== literal) {
      this.fail("invalid_json");
    }
    this.offset += literal.length;
  }

  private parseNumber(): void {
    const start = this.offset;
    if (this.text[this.offset] === "-") this.offset += 1;
    if (this.text[this.offset] === "0") {
      this.offset += 1;
    } else {
      const first = this.text[this.offset];
      if (first === undefined || first < "1" || first > "9") this.fail("invalid_json");
      this.offset += 1;
      while (this.isDigit(this.text[this.offset])) this.offset += 1;
    }
    if (this.text[this.offset] === ".") {
      this.offset += 1;
      if (!this.isDigit(this.text[this.offset])) this.fail("invalid_number");
      while (this.isDigit(this.text[this.offset])) this.offset += 1;
    }
    if (this.text[this.offset] === "e" || this.text[this.offset] === "E") {
      this.offset += 1;
      if (this.text[this.offset] === "+" || this.text[this.offset] === "-") this.offset += 1;
      if (!this.isDigit(this.text[this.offset])) this.fail("invalid_number");
      while (this.isDigit(this.text[this.offset])) this.offset += 1;
    }

    const token = this.text.slice(start, this.offset);
    if (!/^-?(?:0|[1-9]\d*)$/.test(token) || !Number.isSafeInteger(Number(token))) {
      this.fail("invalid_number");
    }
  }

  private isDigit(character: string | undefined): boolean {
    return character !== undefined && character >= "0" && character <= "9";
  }
}

const isPlainJsonObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
};

const ownKeysExactly = (value: Record<string, unknown>, required: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return (
    keys.length === required.length &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
};

const codePointLengthWithin = (value: string, maximum: number): boolean => {
  const characters = value[Symbol.iterator]();
  for (let count = 0; count <= maximum; count += 1) {
    if (characters.next().done) return true;
  }
  return false;
};

const cloneJsonSafely = (value: unknown, containerDepth = 0): unknown => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  ) {
    return value;
  }
  if (containerDepth >= STRUCTURED_RECORD_IMPORT_MAXIMUM_NESTING_DEPTH) {
    throw new Error("bounded JSON structure changed after scanning");
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneJsonSafely(item, containerDepth + 1)));
  }
  if (!isPlainJsonObject(value)) throw new Error("bounded JSON structure changed after scanning");
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(copy, key, {
      value: cloneJsonSafely(item, containerDepth + 1),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(copy);
};

const decodeParsedDocument = (candidate: unknown): StructuredRecordImportDecodeResult => {
  if (!isPlainJsonObject(candidate)) return refused("invalid_document");
  const keys = Object.keys(candidate);
  if (
    keys.length !== 3 ||
    !Object.prototype.hasOwnProperty.call(candidate, "format") ||
    !Object.prototype.hasOwnProperty.call(candidate, "columns") ||
    !Object.prototype.hasOwnProperty.call(candidate, "rows")
  ) {
    return refused("invalid_document");
  }
  if (!structuredRecordImportFormatSchema.safeParse(candidate.format).success) {
    return refused("unsupported_format");
  }
  if (!Array.isArray(candidate.columns) || !Array.isArray(candidate.rows)) {
    return refused("invalid_document");
  }
  if (candidate.columns.length > STRUCTURED_RECORD_IMPORT_MAXIMUM_COLUMNS) {
    return refused("too_many_columns");
  }
  if (candidate.rows.length > STRUCTURED_RECORD_IMPORT_MAXIMUM_ROWS) {
    return refused("too_many_rows");
  }

  const columns: StructuredRecordImportColumn[] = [];
  const columnIds = new Set<string>();
  for (const value of candidate.columns) {
    if (!isPlainJsonObject(value)) return refused("invalid_document");
    const columnKeys = Object.keys(value);
    const hasLabel = Object.prototype.hasOwnProperty.call(value, "label");
    if (
      !ownKeysExactly(value, hasLabel ? ["columnId", "label"] : ["columnId"]) ||
      typeof value.columnId !== "string" ||
      !codePointLengthWithin(value.columnId, 256) ||
      (hasLabel &&
        (typeof value.label !== "string" || !codePointLengthWithin(value.label as string, 256)))
    ) {
      return refused("invalid_document");
    }
    if (columnKeys.includes("label") && typeof value.label !== "string") {
      return refused("invalid_document");
    }
    const parsedColumn = structuredRecordImportColumnSchema.safeParse(value);
    if (!parsedColumn.success) return refused("invalid_document");
    if (columnIds.has(parsedColumn.data.columnId)) return refused("invalid_document");
    columnIds.add(parsedColumn.data.columnId);
    columns.push(Object.freeze(parsedColumn.data));
  }

  const rows: DecodedRecordImportRow[] = [];
  for (let rowIndex = 0; rowIndex < candidate.rows.length; rowIndex += 1) {
    const rowCandidate = candidate.rows[rowIndex];
    const rowNumber = rowIndex + 1;
    if (!Array.isArray(rowCandidate)) return refused("invalid_document", { rowNumber });
    if (rowCandidate.length !== columns.length) {
      return refused("row_width_mismatch", { rowNumber });
    }
    if (rowCandidate.length > STRUCTURED_RECORD_IMPORT_MAXIMUM_COLUMNS) {
      return refused("invalid_document", { rowNumber });
    }

    const cells: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      const column = columns[columnIndex];
      if (column === undefined) return refused("invalid_document", { rowNumber });
      const cell = rowCandidate[columnIndex];
      let safeCell: unknown;
      try {
        safeCell = cloneJsonSafely(cell);
      } catch {
        return refused("invalid_document", { rowNumber, columnNumber: columnIndex + 1 });
      }
      Object.defineProperty(cells, column.columnId, {
        value: safeCell,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    rows.push(Object.freeze({ rowNumber, cells: Object.freeze(cells) }));
  }

  return Object.freeze({
    outcome: "decoded",
    columns: Object.freeze(columns),
    rows: Object.freeze(rows),
  });
};

/** Decode one complete, finite structured record-import document. */
export const decodeStructuredRecordImport = (
  source: Uint8Array,
): StructuredRecordImportDecodeResult => {
  if (!(source instanceof Uint8Array)) return refused("invalid_encoding");
  if (source.byteLength > STRUCTURED_RECORD_IMPORT_MAXIMUM_SOURCE_BYTES) {
    return refused("source_too_large");
  }

  let text: string;
  try {
    const ownedBytes = Buffer.from(source);
    text = new TextDecoder("utf-8", { fatal: true }).decode(ownedBytes);
  } catch {
    return refused("invalid_encoding");
  }

  try {
    new BoundedJsonScanner(text).scan();
  } catch (failure) {
    if (failure !== null && typeof failure === "object" && "reason" in failure) {
      const safeFailure = failure as SafeParseFailure;
      return refused(safeFailure.reason, safeFailure);
    }
    return refused("invalid_json");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return refused("invalid_json");
  }
  return decodeParsedDocument(parsed);
};
