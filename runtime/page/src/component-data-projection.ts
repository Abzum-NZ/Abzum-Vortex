import "server-only";

import {
  readRecordDetailContract,
  readRecordsTableContract,
  timestampSchema,
  type BlockPropertyValueV2Contract,
  type JsonValue,
  type RecordsDisplayFormat,
} from "@vortex/contracts";
import type { ProtectedQueryRow } from "@vortex/query";

/**
 * One closed display value. It is structurally the value the shared display components render, so
 * the payload passes their projected-data parser unchanged; this module never imports the UI.
 */
export type ProjectedCellValue =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "number"; value: number }>
  | Readonly<{ kind: "boolean"; value: boolean }>
  | Readonly<{ kind: "date"; iso: string }>
  | Readonly<{ kind: "empty" }>;

/**
 * One row addressed by the record identity the Query engine returned; cells are keyed by field.
 * The row carries the record revision the engine returned and the per-row capabilities the engine
 * computed from the same exact access decision it read the row with, so an inline edit can send a
 * revision and a row action can be hidden for a row the viewer cannot act on. Neither is ever
 * inferred: a row the engine returned without them withholds the whole projection.
 */
export type ProjectedTableRow = Readonly<{
  recordId: string;
  revision: number;
  capabilities: NonNullable<ProtectedQueryRow["capabilities"]>;
  cells: Readonly<Record<string, ProjectedCellValue>>;
}>;

/** A query row proven to carry the revision and capabilities the engine decided for a list row. */
type ListRow = ProtectedQueryRow & Pick<ProjectedTableRow, "revision" | "capabilities">;

const isListRow = (row: ProtectedQueryRow): row is ListRow =>
  row.revision !== undefined && row.capabilities !== undefined;

export type ProjectedTableValues = Readonly<{
  kind: "table";
  columns: readonly Readonly<{ key: string; label: string }>[];
  rows: readonly ProjectedTableRow[];
}>;

export type ProjectedRecordDetailValues = Readonly<{
  kind: "record_detail";
  recordId: string;
  fields: readonly Readonly<{ key: string; label: string; value: ProjectedCellValue }>[];
}>;

/**
 * The display payload for one placement. Only `ready` carries values; a refusal never does, so a
 * caller cannot render data the projection did not authorise.
 */
export type ProjectedComponentData<Values> =
  | Readonly<{ status: "empty" }>
  | Readonly<{ status: "ready"; values: Values }>;

/**
 * What the projector combines with the component's declared contract. `settings` are the
 * placement's compiled settings, the same ones the query request was built from. `fieldLabels`
 * supplies a heading for a declared field that sets no label of its own and comes from the
 * installed definition (field identity to label); the projector never invents a heading.
 * `readableFieldIds`, when supplied, narrows the readable fields further; it can never widen the
 * fields the Query engine returned.
 */
export type ComponentDataProjectionInput = Readonly<{
  settings: Readonly<Record<string, BlockPropertyValueV2Contract>>;
  fieldLabels?: Readonly<Record<string, string>>;
  readableFieldIds?: readonly string[];
}>;

const ISO_CALENDAR_DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const empty: ProjectedCellValue = Object.freeze({ kind: "empty" as const });

const hasOwn = (record: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const projectDate = (value: string): ProjectedCellValue =>
  (ISO_CALENDAR_DATE.test(value) && !Number.isNaN(Date.parse(value))) ||
  timestampSchema.safeParse(value).success
    ? { kind: "date", iso: value }
    : { kind: "text", text: value };

/**
 * Maps one stored value to a closed display value by the declared format. A value that does not
 * fit its declared format is shown as plain text, and a structured value that is not a display
 * value at all is shown as empty; neither ever reaches the component as raw JSON.
 */
const projectCell = (value: JsonValue, format: RecordsDisplayFormat): ProjectedCellValue => {
  if (value === null) return empty;
  switch (format) {
    case "number":
    case "currency":
    case "percent":
      if (typeof value === "number" && Number.isFinite(value)) return { kind: "number", value };
      break;
    case "boolean":
      if (typeof value === "boolean") return { kind: "boolean", value };
      break;
    case "date":
    case "date_time":
      if (typeof value === "string" && value.length > 0) return projectDate(value);
      break;
    case "automatic":
      if (typeof value === "number" && Number.isFinite(value)) return { kind: "number", value };
      if (typeof value === "boolean") return { kind: "boolean", value };
      break;
    case "text":
      break;
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? { kind: "text", text: String(value) }
    : empty;
};

/**
 * Field identities are UUIDs compared without regard to case: the Query engine keys row values by
 * the lowercase identity, while a declaration may spell it in either case.
 */
const sameField = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** The row's value for a declared field, or undefined when the engine withheld it (absent). */
const valueOf = (row: ProtectedQueryRow, field: string): { value: JsonValue } | undefined => {
  const values: Readonly<Record<string, JsonValue>> = row.values;
  const key = hasOwn(values, field)
    ? field
    : Object.keys(values).find((candidate) => sameField(candidate, field));
  return key === undefined ? undefined : { value: values[key] as JsonValue };
};

const headingFor = (
  field: string,
  declared: string | undefined,
  fieldLabels: ComponentDataProjectionInput["fieldLabels"],
): string | undefined => {
  const key =
    fieldLabels === undefined
      ? undefined
      : Object.keys(fieldLabels).find((candidate) => sameField(candidate, field));
  const label = declared ?? (key === undefined ? undefined : fieldLabels?.[key]);
  return label !== undefined && label.trim().length > 0 ? label : undefined;
};

const isReadable = (field: string, input: ComponentDataProjectionInput): boolean =>
  input.readableFieldIds === undefined ||
  input.readableFieldIds.some((readable) => sameField(readable, field));

/**
 * Projects a Records table's query rows into its display payload. Columns and headings come only
 * from the declared contract. A declared column appears only when every returned row carries its
 * field, because the Query engine omits a field the viewer cannot read; a column with any missing
 * value is withheld whole, heading included, and is never blanked. Undeclared fields the engine
 * returned are dropped, and each row keeps only the record identity, revision and per-row
 * capabilities the engine returned. Returns undefined when the placement declares no data
 * contract, a heading is missing, a row carries no revision or capabilities, or the rows are not a
 * valid page (a repeated record identity), so the caller refuses neutrally.
 */
export const projectRecordsTableData = (
  input: ComponentDataProjectionInput,
  rows: readonly ProtectedQueryRow[],
): ProjectedComponentData<ProjectedTableValues> | undefined => {
  const contract = readRecordsTableContract(input.settings);
  if (contract === undefined || contract.columns.length === 0) return undefined;
  if (new Set(rows.map((row) => row.recordId)).size !== rows.length) return undefined;
  if (rows.length === 0) return { status: "empty" };
  // A list row must carry the revision and capabilities the engine decided for it; a row without
  // them is withheld whole, never displayed with an inferred or absent capability.
  const completeRows = rows.filter(isListRow);
  if (completeRows.length !== rows.length) return undefined;

  const columns: { key: string; label: string; format: RecordsDisplayFormat }[] = [];
  for (const column of contract.columns) {
    if (columns.some((shown) => sameField(shown.key, column.field))) continue;
    if (!isReadable(column.field, input)) continue;
    if (!rows.every((row) => valueOf(row, column.field) !== undefined)) continue;
    const label = headingFor(column.field, column.label, input.fieldLabels);
    if (label === undefined) return undefined;
    columns.push({ key: column.field, label, format: column.format });
  }
  if (columns.length === 0) return { status: "empty" };

  return {
    status: "ready",
    values: {
      kind: "table",
      columns: columns.map(({ key, label }) => ({ key, label })),
      rows: completeRows.map((row) => ({
        recordId: row.recordId,
        revision: row.revision,
        capabilities: row.capabilities,
        cells: Object.fromEntries(
          columns.map((column) => [
            column.key,
            projectCell(valueOf(row, column.key)?.value ?? null, column.format),
          ]),
        ),
      })),
    },
  };
};

/**
 * Projects the one record a Record detail placement reads into its display payload, using the same
 * rules as the table: declared fields in declared order, a field the viewer cannot read is omitted
 * with its label, nothing undeclared is included. The query must return exactly one record; any
 * other count returns undefined so the caller refuses neutrally rather than guessing a record.
 */
export const projectRecordDetailData = (
  input: ComponentDataProjectionInput,
  rows: readonly ProtectedQueryRow[],
): ProjectedComponentData<ProjectedRecordDetailValues> | undefined => {
  const contract = readRecordDetailContract(input.settings);
  const row = rows[0];
  if (contract === undefined || contract.fields.length === 0 || rows.length !== 1 || row === undefined)
    return undefined;

  const fields: { key: string; label: string; value: ProjectedCellValue }[] = [];
  for (const declared of contract.fields) {
    if (fields.some((shown) => sameField(shown.key, declared.field))) continue;
    const stored = isReadable(declared.field, input) ? valueOf(row, declared.field) : undefined;
    if (stored === undefined) continue;
    const label = headingFor(declared.field, declared.label, input.fieldLabels);
    if (label === undefined) return undefined;
    fields.push({ key: declared.field, label, value: projectCell(stored.value, declared.format) });
  }
  return fields.length === 0
    ? { status: "empty" }
    : { status: "ready", values: { kind: "record_detail", recordId: row.recordId, fields } };
};
