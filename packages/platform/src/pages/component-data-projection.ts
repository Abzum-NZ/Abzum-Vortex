import "server-only";

import {
  gridLayoutVisibleFieldIds,
  isSafeLinkAddress,
  readRecordDetailContract,
  readRecordsTableContract,
  richTextDocumentSchema,
  timestampSchema,
  type BlockPropertyValueContract,
  type GridLayoutState,
  type JsonValue,
  type RecordsDisplayFormat,
  type RecordsTableFilterField,
  type RecordsTableFilterValue,
  type RecordsTableSortState,
  type tableCellTypeKeys,
} from "../schema";
import type { ProtectedQueryFieldBounds, ProtectedQueryRow } from "../queries/index";
import { formatDecimal, formatMoney, isExactDecimal } from "./value-format";
import { recordLinkLabelKey, type RecordLinkReference } from "../definition/app-index";
import { defaultQueryPageSize } from "../definition/module-query-edit";
import {
  evaluateConditionalFormatting,
  personalFormattingRules,
  projectRecordsTableFeatures,
  rowMayChangeField,
  type RecordsTableInlineEditor,
  type ConditionalFormattingContext,
  type RecordsTableFeatureProjection,
  type RecordsTableRowFormat,
} from "./records-table-features";

/**
 * One closed display value. It is structurally the value the shared display components render, so
 * the payload passes their projected-data parser unchanged; this module never imports the UI.
 */
export type ProjectedCellValue = ProjectedScalarCellValue | ProjectedTableField;

/**
 * A table field's stored rows as a record detail shows them: its declared columns in declared order
 * with readable headings, at most the first page of rows with each row's cells for exactly those
 * columns, each a scalar display value, and how many rows the field holds in total.
 */
export type ProjectedTableField = Readonly<{
  kind: "field_table";
  columns: readonly Readonly<{ key: string; label: string }>[];
  rows: readonly Readonly<Record<string, ProjectedScalarCellValue>>[];
  rowCount: number;
}>;

/** One display value that is not itself a table. */
export type ProjectedScalarCellValue =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "choice"; key: string; label: string }>
  | Readonly<{ kind: "number"; value: number; formatted: string }>
  | Readonly<{ kind: "boolean"; value: boolean }>
  | Readonly<{ kind: "date"; iso: string }>
  | Readonly<{ kind: "link"; address: string; label: string }>
  | Readonly<{ kind: "rich_text"; document: ReturnType<typeof richTextDocumentSchema.parse> }>
  | ProjectedRecordLink
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "empty" }>;

/**
 * A linked record as the viewer may see it: its label, with the address of its detail page only
 * when the viewer may open that page, or a neutral `restricted` that carries nothing of the record.
 */
export type ProjectedRecordLink =
  | Readonly<{ kind: "record_link"; label: string; href?: string }>
  | Readonly<{ kind: "restricted" }>;

/** The resolved links of one page, keyed by `recordLinkLabelKey`; absent when the read failed. */
export type ProjectedRecordLinks = ReadonlyMap<string, ProjectedRecordLink>;

/**
 * Reads the labels of every linked record one page shows in one batched read per link target
 * record type. Undefined when the read failed; the failure is already logged with its cause.
 */
export type RecordLinkResolver = (
  links: readonly RecordLinkReference[],
) => Promise<ProjectedRecordLinks | undefined>;

/** A stored link value is exactly a record type identity and a record identity. */
const asRecordLink = (value: JsonValue): RecordLinkReference | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  const { recordTypeId, recordId } = value;
  return keys.length === 2 && typeof recordTypeId === "string" && typeof recordId === "string"
    ? { recordTypeId, recordId }
    : undefined;
};

/** The distinct linked records among the given stored values. */
export const collectRecordLinkValues = (
  values: Iterable<JsonValue>,
): readonly RecordLinkReference[] => {
  const links = new Map<string, RecordLinkReference>();
  for (const value of values) {
    const link = asRecordLink(value);
    if (link !== undefined) links.set(recordLinkLabelKey(link), link);
  }
  return [...links.values()];
};

/** The distinct linked records among every value of the rows the Query engine returned. */
export const collectRecordLinks = (
  rows: readonly ProtectedQueryRow[],
): readonly RecordLinkReference[] =>
  collectRecordLinkValues(rows.flatMap((row) => Object.values<JsonValue>(row.values)));

/** The plain text a label-only surface shows for a linked record; never the stored identity. */
export const recordLinkPlainText = (
  value: JsonValue | undefined,
  recordLinks: ProjectedRecordLinks | undefined,
): string | undefined => {
  const link = value === undefined ? undefined : asRecordLink(value);
  if (link === undefined) return undefined;
  const resolved = recordLinks?.get(recordLinkLabelKey(link));
  if (resolved === undefined) {
    console.error("[page] record link label missing: RECORD_LINK_LABEL_UNAVAILABLE");
    return "Unavailable";
  }
  return resolved.kind === "restricted" ? "Restricted" : resolved.label;
};

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
  cells: Readonly<Record<string, ProjectedScalarCellValue>>;
  /**
   * The stored value of each inline-editable field this row lets the viewer change (null when
   * empty), kept apart from the displayed cells: an editor starts from this, never from a display
   * string. Absent when the row has none.
   */
  edit?: Readonly<Record<string, JsonValue>>;
  /** The style keys and measures the table's formatting gives this row; absent when none. */
  format?: RecordsTableRowFormat;
  /** A tree row the viewer may read a child of; absent on every other row. */
  hasChildren?: true;
}>;

/** A row of a table read: a tree level's rows also say whether the viewer may read a child. */
type TableSourceRow = ProtectedQueryRow & Readonly<{ hasChildren?: boolean }>;

/** A query row proven to carry the revision and capabilities the engine decided for a list row. */
type ListRow = TableSourceRow & Pick<ProjectedTableRow, "revision" | "capabilities">;

const isListRow = (row: TableSourceRow): row is ListRow =>
  row.revision !== undefined && row.capabilities !== undefined;

/** One group of a grouped table: its key, its label and how many records it holds right now. */
export type ProjectedTableGroup = Readonly<{
  /** The canonical key of the group's value (see `recordsTableGroupKey`), never a display label. */
  key: string;
  label: string;
  count: number;
  /** The group of records that hold no value, or whose value the viewer cannot see. */
  unassigned?: true;
}>;

/**
 * The groups a grouped table was read with. `ready` carries one bounded count per group, read with
 * the table's own filters, search and access; `too_many` says the filtered records are more than a
 * grouped read counts, so the table shows its records flat until the viewer narrows them.
 */
export type ProjectedTableGroups =
  | Readonly<{
      status: "ready";
      fieldId: string;
      groups: readonly ProjectedTableGroup[];
      /** The records the groups hold together, as the same read counted them. */
      total: number;
      /** The key of the open group; absent while every group is closed. */
      expanded?: string;
      /**
       * Where this page of groups sits: `first` when no group page precedes it, and `next` the
       * opaque position that reads the following page (absent on the last page).
       */
      page: Readonly<{ first: boolean; next?: string }>;
    }>
  | Readonly<{ status: "too_many" }>;

export type ProjectedTableValues = Readonly<{
  kind: "table";
  columns: readonly Readonly<{ key: string; label: string }>[];
  /**
   * The declared columns the read did not request, in declared order: their headings only, never a
   * value, so the person can show one again (which reads the page again with that column).
   */
  hiddenColumns: readonly Readonly<{ key: string; label: string }>[];
  /** The person's layout of this grid: order, shown columns, widths and density. */
  layout: GridLayoutState;
  rows: readonly ProjectedTableRow[];
  /** Present when the table is grouped: its rows are then the open group's members only. */
  groups?: ProjectedTableGroups;
  /** The grid features this viewer may use on this read; absent when every feature is off. */
  features?: RecordsTableFeatureProjection;
  /** The order the page was read in, when it is the viewer's or the authored default sort. */
  sort?: RecordsTableSortState;
  /**
   * The search and filters the page was read with, so the table shows them in its controls and
   * tells a page that matched nothing apart from a table that has no records.
   */
  narrowing?: RecordsTableNarrowing;
  page?: number;
  hasNextPage?: boolean;
  nextContinuationToken?: string;
  /** The read's scan budget ran out before the page filled: more records may match on the next page. */
  scanLimited?: boolean;
  hasPreviousPage?: boolean;
  previousContinuationToken?: string;
  /**
   * The sealed "every matching record" descriptor of this read, present only when bulk actions are
   * on: the browser hands it back to select every matching record without listing them.
   */
  selectionToken?: string;
}>;

/** The viewer's search and filters a table page was read with; both empty when it was not narrowed. */
export type RecordsTableNarrowing = Readonly<{
  search: string | null;
  filters: readonly RecordsTableFilterValue[];
  /**
   * The titles of the records the link filters name, read under the viewer's access in the page's
   * one batched link read (record identity to title); a record the viewer may not read is
   * "Restricted record".
   */
  recordTitles?: Readonly<Record<string, string>>;
}>;

export type ProjectedRecordDetailValues = Readonly<{
  kind: "record_detail";
  recordId: string;
  fields: readonly Readonly<{ key: string; label: string; value: ProjectedCellValue }>[];
  heading?: ProjectedScalarCellValue;
}>;

/**
 * The display payload for one placement. Only `ready` carries values; a refusal never does, so a
 * caller cannot render data the projection did not authorise.
 */
export type ProjectedComponentData<Values> =
  Readonly<{ status: "empty" }> | Readonly<{ status: "ready"; values: Values }>;

/**
 * What the projector combines with the component's declared contract. `settings` are the
 * placement's compiled settings, the same ones the query request was built from. `fieldLabels`
 * supplies a heading for a declared field that sets no label of its own and comes from the
 * installed definition (field identity to label); the projector never invents a heading.
 * `readableFieldIds`, when supplied, narrows the readable fields further; it can never widen the
 * fields the Query engine returned.
 */
export type ComponentDataProjectionInput = Readonly<{
  settings: Readonly<Record<string, BlockPropertyValueContract>>;
  fieldLabels?: Readonly<Record<string, string>>;
  /** Every declared option in definition order for choice fields, used only to label stored values. */
  fieldChoiceLabels?: Readonly<
    Record<string, readonly Readonly<{ value: string; label: string }>[]>
  >;
  readableFieldIds?: readonly string[];
  /** The date or date-time fields of the installed definition (field identity to field type), so a column declared "automatic" shows them as dates. */
  fieldDateTypes?: Readonly<Record<string, "date" | "date_time">>;
  /** The web, email and phone fields of the installed definition (field identity to field type), so their values show as links. */
  fieldLinkTypes?: Readonly<Record<string, LinkFieldType>>;
  /** The labels of the linked records the rows carry; absent when they could not be read. */
  recordLinks?: ProjectedRecordLinks;
  /** The filterable fields of a table, described for their filter controls (field identity to field). */
  filterFields?: Readonly<Record<string, RecordsTableFilterField>>;
  /** The declared columns of every table field of the installed definition (field identity to columns), so a record detail shows its rows. */
  fieldTableColumns?: Readonly<Record<string, readonly TableFieldColumn[]>>;
  /** What a Records table's formatting rules are evaluated with; supplied only when they are on. */
  formatting?: ConditionalFormattingContext;
  /** How a cell edits each field of the installed definition (field identity to editor); supplied only when inline editing is on. */
  fieldEditors?: Readonly<Record<string, RecordsTableInlineEditor>>;
  /** The pivot view the address opens the table in; absent shows the ordinary grid. */
  pivotView?: Readonly<{ cursor?: string }>;
  /** The viewer's export permission, decided in the same read; absent when Export is off. */
  exportAllowed?: boolean;
  /** The groups a grouped read counted; absent for an ordinary read. */
  groups?: ProjectedTableGroups;
}>;

/** One declared column of a table field: its key, readable heading, cell type and, for a choice, its options. */
export type TableFieldColumn = Readonly<{
  key: string;
  label: string;
  type: (typeof tableCellTypeKeys)[number];
  options?: readonly Readonly<{ value: string; label: string }>[];
}>;

/** The field types whose stored text is an address a viewer can follow. */
export type LinkFieldType = "web_address" | "email_address" | "phone_number";

const ISO_CALENDAR_DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const empty: ProjectedScalarCellValue = Object.freeze({ kind: "empty" as const });

const hasOwn = (record: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

/** A calendar date whose day exists in its month; `Date.parse` alone rolls 2026-02-31 over to March. */
const isRealCalendarDate = (value: string): boolean => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
};

/**
 * A stored value of a date or date-time column. One that is not an ISO date or offset timestamp is
 * logged with a stable code and shown as an explicit invalid-value text, never as the raw stored text.
 */
const projectDate = (value: string): ProjectedScalarCellValue => {
  if (
    (ISO_CALENDAR_DATE.test(value) && isRealCalendarDate(value)) ||
    timestampSchema.safeParse(value).success
  )
    return { kind: "date", iso: value };
  console.error("[page] records display value refused DATE_VALUE_INVALID");
  return { kind: "text", text: "Invalid date value" };
};

/**
 * A stored web, email or phone value as a link: its own text is the label and the address uses the
 * scheme of its field type. A value that cannot form a safe address is logged with a stable code
 * and shown as plain text, never as a link.
 */
const projectLink = (value: string, linkType: LinkFieldType): ProjectedScalarCellValue => {
  const text = value.trim();
  const address =
    linkType === "web_address"
      ? text
      : linkType === "email_address"
        ? `mailto:${text}`
        : `tel:${text.replace(/[\s]/g, "")}`;
  if (isSafeLinkAddress(address)) return { kind: "link", address, label: text };
  console.error(`[page] link value refused LINK_VALUE_INVALID type=${linkType}`);
  return { kind: "text", text: value };
};

const numberCell = (value: number, grouped: boolean): ProjectedScalarCellValue => ({
  kind: "number",
  value,
  formatted: grouped ? formatDecimal(value) : String(value),
});

/**
 * Maps one stored value to a closed display value by the declared format. A value that does not
 * fit its declared format is shown as plain text, and a formatted-text document is shown as rich text,
 * and a structured value that is not a display value at all is shown as empty; neither ever reaches the component as raw JSON.
 */
const projectCell = (
  value: JsonValue,
  declaredFormat: RecordsDisplayFormat,
  choiceLabels?: readonly Readonly<{ value: string; label: string }>[],
  dateType?: "date" | "date_time",
  recordLinks?: ProjectedRecordLinks,
  linkType?: LinkFieldType,
): ProjectedScalarCellValue => {
  const format =
    declaredFormat === "automatic" && dateType !== undefined ? dateType : declaredFormat;
  if (value === null) return empty;
  if (linkType !== undefined && typeof value === "string" && value.trim().length > 0)
    return projectLink(value, linkType);
  // A link shows its target's label as the viewer may read it; one that could not be resolved is
  // an explicit unavailable state, never a blank and never the stored identity.
  const link = asRecordLink(value);
  if (link !== undefined) {
    const resolved = recordLinks?.get(recordLinkLabelKey(link));
    if (resolved !== undefined) return resolved;
    console.error("[page] record link label missing: RECORD_LINK_LABEL_UNAVAILABLE");
    return { kind: "unavailable" };
  }
  if (Array.isArray(value) && choiceLabels !== undefined) {
    const selected = value.filter((entry): entry is string => typeof entry === "string");
    if (
      selected.length === 0 ||
      selected.length !== value.length ||
      new Set(selected).size !== selected.length ||
      selected.some((entry) => !choiceLabels.some((option) => option.value === entry))
    )
      return empty;
    const selectedSet = new Set(selected);
    return {
      kind: "text",
      text: choiceLabels
        .filter((option) => selectedSet.has(option.value))
        .map((option) => option.label)
        .join(", "),
    };
  }
  // One selected choice shows its label; a value the field no longer offers shows no value.
  if (typeof value === "string" && choiceLabels !== undefined) {
    const option = choiceLabels.find((candidate) => candidate.value === value);
    return option === undefined
      ? empty
      : { kind: "choice", key: option.value, label: option.label };
  }
  // A formatted-text value is shown as its document, never flattened or dropped.
  const document = richTextDocumentSchema.safeParse(value);
  if (document.success) return { kind: "rich_text", document: document.data };
  if (typeof value === "object" && !Array.isArray(value) && "blocks" in value)
    console.error(
      `[page] formatted text value is not a valid document: RICH_TEXT_DOCUMENT_INVALID issues=${document.error.issues.length}`,
    );
  // A money value is its exact amount with its currency code.
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.amount === "string" &&
    typeof value.currency === "string"
  )
    return { kind: "text", text: formatMoney({ currency: value.currency, amount: value.amount }) };
  switch (format) {
    case "number":
    case "currency":
    case "percent":
      if (typeof value === "number" && Number.isFinite(value)) return numberCell(value, true);
      if (typeof value === "string" && isExactDecimal(value))
        return { kind: "number", value: Number(value), formatted: formatDecimal(value) };
      break;
    case "boolean":
      if (typeof value === "boolean") return { kind: "boolean", value };
      break;
    case "date":
    case "date_time":
      if (typeof value === "string" && value.length > 0) return projectDate(value);
      break;
    case "automatic":
      if (typeof value === "number" && Number.isFinite(value)) return numberCell(value, false);
      if (typeof value === "boolean") return { kind: "boolean", value };
      break;
    case "text":
      break;
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? { kind: "text", text: String(value) }
    : empty;
};

/** The display format each table cell type is shown in; money and choices are recognised by value. */
const TABLE_CELL_FORMATS: Readonly<Record<TableFieldColumn["type"], RecordsDisplayFormat>> = {
  text: "text",
  whole_number: "number",
  decimal_number: "number",
  money: "text",
  yes_no: "boolean",
  date: "date",
  date_time: "date_time",
  choice: "text",
};

/**
 * A table field's stored rows as its declared columns and rows. Each row carries exactly the
 * declared column keys, in declared order, projected through the same cell rules as any field; an
 * undeclared key is never read. Only the first page of rows is sent, with the total, so a detail
 * never ships rows it does not show. A field with no rows is an empty table, so the detail can say
 * so. A stored value that is not a list of rows is logged with a stable code and shown as unavailable.
 */
const projectTableField = (
  value: JsonValue,
  columns: readonly TableFieldColumn[],
): ProjectedCellValue => {
  const rows = value === null ? [] : value;
  if (
    !Array.isArray(rows) ||
    rows.some((row) => row === null || typeof row !== "object" || Array.isArray(row))
  ) {
    console.error("[page] table field value refused TABLE_VALUE_INVALID");
    return { kind: "unavailable" };
  }
  return {
    kind: "field_table",
    columns: columns.map(({ key, label }) => ({ key, label })),
    rowCount: rows.length,
    rows: rows.slice(0, defaultQueryPageSize).map((row) =>
      Object.fromEntries(
        columns.map((column) => {
          const cells = row as Readonly<Record<string, JsonValue>>;
          const stored = hasOwn(cells, column.key) ? cells[column.key] : undefined;
          return [
            column.key,
            stored === undefined
              ? empty
              : projectCell(stored, TABLE_CELL_FORMATS[column.type], column.options),
          ];
        }),
      ),
    ),
  };
};

/**
 * Field identities are UUIDs compared without regard to case: the Query engine keys row values by
 * the lowercase identity, while a declaration may spell it in either case.
 */
const sameField = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

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

/** The cell of a declared field the viewer may not read: never blank, never the stored value. */
const RESTRICTED_CELL: ProjectedScalarCellValue = Object.freeze({ kind: "restricted" });

/**
 * The stored values of the inline-editable fields of one row, for the shown columns only: a field
 * this row does not let the viewer change, or the engine withheld, carries no value.
 */
const editValuesOf = (
  row: ListRow,
  columns: readonly Readonly<{ key: string }>[],
  editable: readonly Readonly<{ field: string }>[],
  input: ComponentDataProjectionInput,
): Pick<ProjectedTableRow, "edit"> => {
  const entries = editable.flatMap(({ field }): [string, JsonValue][] => {
    if (!columns.some((column) => sameField(column.key, field))) return [];
    if (!rowMayChangeField(row, field) || !isReadable(field, input)) return [];
    const stored = valueOf(row, field);
    return stored === undefined ? [] : [[field, stored.value]];
  });
  return entries.length === 0 ? {} : { edit: Object.fromEntries(entries) };
};

/**
 * Projects a Records table's query rows into its display payload. Columns and headings come only
 * from the declared contract, narrowed to the columns the person's layout arranges (already
 * resolved against the declared columns and their field policy) and shown by the columns it shows,
 * so a hidden column carries only its heading, never a value. The Query engine omits a field the viewer cannot read, including a
 * calculation or total whose inputs the viewer cannot read, so a row without a declared field
 * shows it as Restricted, never blank and never inferred. Undeclared fields the engine
 * returned are dropped, and each row keeps only the record identity, revision and per-row
 * capabilities the engine returned; a row's changeable fields are narrowed to the visible columns,
 * so its capability metadata never names a field the payload does not carry. Returns undefined when the placement declares no data
 * contract, a heading is missing, a row carries no revision or capabilities, or the rows are not a
 * valid page (a repeated record identity), so the caller refuses neutrally. An empty page keeps
 * its columns and controls, so the viewer can search, clear filters or page back. `fieldBounds` is the
 * viewer's current field bound from the same read, which decides the filters, search and saved views.
 */
export const projectRecordsTableData = (
  layout: GridLayoutState,
  input: ComponentDataProjectionInput,
  rows: readonly TableSourceRow[],
  fieldBounds: ProtectedQueryFieldBounds,
): ProjectedComponentData<ProjectedTableValues> | undefined => {
  const contract = readRecordsTableContract(input.settings);
  if (contract === undefined || contract.columns.length === 0) return undefined;
  if (new Set(rows.map((row) => row.recordId)).size !== rows.length) return undefined;
  // A list row must carry the revision and capabilities the engine decided for it; a row without
  // them is withheld whole, never displayed with an inferred or absent capability.
  const completeRows = rows.filter(isListRow);
  if (completeRows.length !== rows.length) return undefined;

  const visibleFieldIds = gridLayoutVisibleFieldIds(layout.layout);
  const arranged = layout.layout.columns.map((column) => column.fieldId);
  const columns: { key: string; label: string; format: RecordsDisplayFormat }[] = [];
  const hiddenColumns: { key: string; label: string }[] = [];
  for (const column of contract.columns) {
    if ([...columns, ...hiddenColumns].some((held) => sameField(held.key, column.field))) continue;
    // A column the person's field policy leaves out of the layout is neither listed nor offered.
    if (!arranged.some((fieldId) => sameField(fieldId, column.field))) continue;
    const label = headingFor(column.field, column.label, input.fieldLabels);
    if (label === undefined) return undefined;
    if (visibleFieldIds.some((fieldId) => sameField(fieldId, column.field)))
      columns.push({ key: column.field, label, format: column.format });
    else hiddenColumns.push({ key: column.field, label });
  }
  if (columns.length === 0) return { status: "empty" };
  // Formatting rules read only the values the viewer may read on each row; the style keys they
  // produce are all the page carries of them.
  const formatting =
    input.formatting === undefined
      ? undefined
      : evaluateConditionalFormatting(
          contract,
          columns.map((column) => column.key),
          input.readableFieldIds === undefined
            ? completeRows
            : completeRows.map((row) => ({
                ...row,
                values: Object.fromEntries(
                  Object.entries(row.values).filter(([key]) => isReadable(key, input)),
                ),
              })),
          input.formatting,
          personalFormattingRules(contract, layout),
        );
  // The viewer's grid features, decided from the field bound and per-row capabilities of the same read.
  const features = projectRecordsTableFeatures(
    contract,
    fieldBounds,
    completeRows,
    input.filterFields,
    input.fieldEditors,
    formatting?.projection,
    input.pivotView,
    input.fieldLabels,
    input.exportAllowed,
  );
  const editableFields = [
    ...(features?.inlineEdit?.fields ?? []),
    ...(features?.rowEdit?.fields ?? []),
  ];

  return {
    status: "ready",
    values: {
      kind: "table",
      columns: columns.map(({ key, label }) => ({ key, label })),
      hiddenColumns,
      layout,
      ...(input.groups === undefined ? {} : { groups: input.groups }),
      ...(features === undefined ? {} : { features }),
      rows: completeRows.map((row) => {
        const format = formatting?.rows.get(row.recordId);
        return {
          recordId: row.recordId,
          revision: row.revision,
          capabilities: {
            ...row.capabilities,
            changeableFieldIds: row.capabilities.changeableFieldIds.filter((fieldId) =>
              columns.some((column) => sameField(column.key, fieldId)),
            ),
          },
          ...editValuesOf(row, columns, editableFields, input),
          cells: Object.fromEntries(
            columns.map((column) => {
              const stored = isReadable(column.key, input) ? valueOf(row, column.key) : undefined;
              return [
                column.key,
                stored === undefined
                  ? RESTRICTED_CELL
                  : projectCell(
                      stored.value,
                      column.format,
                      input.fieldChoiceLabels?.[column.key.toLowerCase()],
                      input.fieldDateTypes?.[column.key.toLowerCase()],
                      input.recordLinks,
                      input.fieldLinkTypes?.[column.key.toLowerCase()],
                    ),
              ];
            }),
          ),
          ...(format === undefined ? {} : { format }),
          ...(row.hasChildren === true ? { hasChildren: true as const } : {}),
        };
      }),
    },
  };
};

/**
 * Projects the one record a Record detail placement reads into its display payload, using the same
 * rules as the table: declared fields in declared order, a field the viewer cannot read shows as
 * Restricted under its label, nothing undeclared is included. The query must return exactly one record; any
 * other count returns undefined so the caller refuses neutrally rather than guessing a record.
 */
export const projectRecordDetailData = (
  input: ComponentDataProjectionInput,
  rows: readonly ProtectedQueryRow[],
): ProjectedComponentData<ProjectedRecordDetailValues> | undefined => {
  const contract = readRecordDetailContract(input.settings);
  const row = rows[0];
  if (
    contract === undefined ||
    contract.fields.length === 0 ||
    rows.length !== 1 ||
    row === undefined
  )
    return undefined;

  const fields: { key: string; label: string; value: ProjectedCellValue }[] = [];
  for (const declared of contract.fields) {
    if (fields.some((shown) => sameField(shown.key, declared.field))) continue;
    const stored = isReadable(declared.field, input) ? valueOf(row, declared.field) : undefined;
    const label = headingFor(declared.field, declared.label, input.fieldLabels);
    if (label === undefined) return undefined;
    const choiceLabels = input.fieldChoiceLabels?.[declared.field.toLowerCase()];
    const tableColumns = input.fieldTableColumns?.[declared.field.toLowerCase()];
    fields.push({
      key: declared.field,
      label,
      value:
        stored === undefined
          ? RESTRICTED_CELL
          : tableColumns !== undefined
            ? projectTableField(stored.value, tableColumns)
            : projectCell(
                stored.value,
                declared.format,
                choiceLabels,
                input.fieldDateTypes?.[declared.field.toLowerCase()],
                input.recordLinks,
                input.fieldLinkTypes?.[declared.field.toLowerCase()],
              ),
    });
  }
  const headingValue =
    contract.headingField === undefined || !isReadable(contract.headingField, input)
      ? undefined
      : valueOf(row, contract.headingField);
  const heading =
    contract.headingField === undefined
      ? undefined
      : headingValue === undefined
        ? RESTRICTED_CELL
        : projectCell(
            headingValue.value,
            "automatic",
            input.fieldChoiceLabels?.[contract.headingField.toLowerCase()],
            input.fieldDateTypes?.[contract.headingField.toLowerCase()],
            input.recordLinks,
            input.fieldLinkTypes?.[contract.headingField.toLowerCase()],
          );
  return fields.length === 0
    ? { status: "empty" }
    : {
        status: "ready",
        values: {
          kind: "record_detail",
          recordId: row.recordId,
          fields,
          ...(heading === undefined ? {} : { heading }),
        },
      };
};
