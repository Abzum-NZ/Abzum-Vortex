import type { z } from "zod";
import { isSafeLinkAddress, type JsonValue } from "../catalogue/common";
import { timestampSchema } from "../catalogue/identifiers";
import type { RecordsDisplayFormat } from "../definition/application-composition/records-display";
import type { RecordLinkReference } from "../definition/viewer-safe-record-link";
import { richTextDocumentSchema } from "../records/rich-text";
import type { displayScalarCellSchema } from "./display-payload-parts";
import type { RecordsTableInlineEditor } from "./records-table-feature-projection";
import { formatDecimal, formatPageValue, isExactDecimal } from "./value-format";

/*
 * The one rule that turns a stored field value into the closed display value a cell shows. The
 * server projects every read with it; a Records table cell uses it to show a value its inline edit
 * just saved, so the cell looks exactly as the next read will show it.
 */

/** One display value that is not itself a table, as the display payload schema accepts it. */
export type ProjectedScalarCellValue = z.infer<typeof displayScalarCellSchema>;

/**
 * A linked record as the viewer may see it: its label, with the address of its detail page only
 * when the viewer may open that page, or a neutral `restricted` that carries nothing of the record.
 */
export type ProjectedRecordLink = Extract<
  ProjectedScalarCellValue,
  Readonly<{ kind: "record_link" | "restricted" }>
>;

/** A stored link value is exactly a record type identity and a record identity. */
export const asRecordLink = (value: JsonValue): RecordLinkReference | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  const { recordTypeId, recordId } = value;
  return keys.length === 2 && typeof recordTypeId === "string" && typeof recordId === "string"
    ? { recordTypeId, recordId }
    : undefined;
};

/** The field types whose stored text is an address a viewer can follow. */
export type LinkFieldType = "web_address" | "email_address" | "phone_number";

const ISO_CALENDAR_DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
export const emptyCell: ProjectedScalarCellValue = Object.freeze({ kind: "empty" as const });

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
export const projectCell = (
  value: JsonValue,
  declaredFormat: RecordsDisplayFormat,
  choiceLabels?: readonly Readonly<{ value: string; label: string }>[],
  dateType?: "date" | "date_time",
  /** The label of a linked record as the viewer may see it; undefined when it could not be read. */
  recordLinkOf?: (link: RecordLinkReference) => ProjectedRecordLink | undefined,
  linkType?: LinkFieldType,
): ProjectedScalarCellValue => {
  const format =
    declaredFormat === "automatic" && dateType !== undefined ? dateType : declaredFormat;
  if (value === null) return emptyCell;
  if (linkType !== undefined && typeof value === "string" && value.trim().length > 0)
    return projectLink(value, linkType);
  // A link shows its target's label as the viewer may read it; one that could not be resolved is
  // an explicit unavailable state, never a blank and never the stored identity.
  const link = asRecordLink(value);
  if (link !== undefined) {
    const resolved = recordLinkOf?.(link);
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
      return emptyCell;
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
      ? emptyCell
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
  ) {
    const text = formatPageValue("money", { currency: value.currency, amount: value.amount });
    if (text === undefined) throw new Error("Invalid stored money value in a display cell");
    return { kind: "text", text };
  }
  switch (format) {
    case "number":
    case "currency":
    case "percent":
      if (typeof value === "number" && Number.isFinite(value)) return numberCell(value, true);
      if (typeof value === "string" && isExactDecimal(value)) {
        const formatted = formatPageValue("number", value);
        if (formatted === undefined)
          throw new Error("Invalid stored number value in a display cell");
        return { kind: "number", value: Number(value), formatted };
      }
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
    : emptyCell;
};

const linkTypes: Readonly<Record<string, LinkFieldType>> = {
  email: "email_address",
  phone: "phone_number",
  web: "web_address",
};

/**
 * How a shown Records table column displays a value an inline edit saved, by the same rule and
 * field settings the read projects it with: the column's declared format, and from the field's
 * editor its choice labels, date type and address type. A link shows the title the
 * permission-checked picker offered; without one it is unavailable, as on a read.
 */
export const projectInlineEditedCell = (
  value: JsonValue,
  format: RecordsDisplayFormat,
  editor: RecordsTableInlineEditor,
  linkTitle: string | undefined,
): ProjectedScalarCellValue =>
  projectCell(
    value,
    format,
    editor.kind === "choice" ? editor.options : undefined,
    editor.kind === "date" || editor.kind === "date_time" ? editor.kind : undefined,
    () => (linkTitle === undefined ? undefined : { kind: "record_link", label: linkTitle }),
    editor.kind === "text" ? linkTypes[editor.input] : undefined,
  );
