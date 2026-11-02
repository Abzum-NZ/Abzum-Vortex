import type { JsonValue } from "../../catalogue/common";
import { isRecord } from "../../catalogue/runtime-primitives";
import type { RecordsDisplayFormat } from "../../definition/application-composition/records-display";
import { recordLinkLabelKey } from "../../definition/viewer-safe-record-link";
import { compareExactDecimals, parseExactDecimal } from "../../records/exact-decimal";
import type { RecordsExportCell } from "../../queries/export-records";
import { cellValueToText, NO_TEXT, RESTRICTED_TEXT, YES_TEXT } from "../cell-text";
import {
  PLAIN_NUMBER_TEXT,
  recordsTableExportableTypes,
} from "../../definition/application-composition/records-table-features/export";
import {
  asRecordLink,
  projectCell,
  type LinkFieldType,
  type ProjectedRecordLink,
} from "../cell-projection";
import { isoDateExcelFormat, zonedDateTimeParts, type DateFormatOptions } from "../date-format";
import type { PlacementField } from "../placement-read/shared";
import { moneyDisplayShape } from "../value-format";

/** One exported column: the field, its heading and width, and how its file cells hold values. */
export type ExportColumn = Readonly<{
  fieldId: string;
  label: string;
  field: PlacementField;
  width: number;
  /** The format the table declares for the column; it decides what the grid shows. */
  format: RecordsDisplayFormat;
  /** The stored value instead of what the table shows. */
  raw: boolean;
}>;

/** What a cell needs besides its stored value, all read once per export. */
export type ExportCellContext = Readonly<{
  /** The viewer's locale and time zone, the ones the grid shows dates in. */
  presentation: DateFormatOptions;
  choices: Parameters<typeof projectCell>[2];
  dateType: "date" | "date_time" | undefined;
  linkType: LinkFieldType | undefined;
  /** The permitted titles of the page's links. */
  titles: ReadonlyMap<string, ProjectedRecordLink>;
}>;

/** The value type a column's cells carry: a calculation's or total's result type, else its own. */
export const valueTypeOf = (field: PlacementField): string =>
  field.type === "calculation" || field.type === "total" ? field.settings.resultType : field.type;

/** Whether Excel's date system holds this value without losing digits: 1900 to 9999, whole milliseconds. */
const excelCanHoldDate = (iso: string, presentation: DateFormatOptions): boolean => {
  if (/\.\d{3}\d*[1-9]/.test(iso)) return false;
  const year =
    iso.length === 10
      ? Number(iso.slice(0, 4))
      : zonedDateTimeParts(new Date(iso), presentation.timeZone).year;
  return year >= 1900 && year <= 9999;
};

/** The spreadsheet number format of an exact decimal: its own digits, no grouping. */
const plainFormat = (amount: string): string => {
  const scale = amount.split(".")[1]?.length ?? 0;
  return scale === 0 ? "0" : `0.${"0".repeat(scale)}`;
};

/**
 * The spreadsheet number format that shows an exact decimal as the table shows it (grouped or not,
 * with the same fraction digits); undefined when the shown text is not that number, so the cell
 * stays the text the table shows rather than a number that reads differently.
 */
const shownNumberFormat = (shown: string, amount: string): string | undefined => {
  const match = PLAIN_NUMBER_TEXT.exec(shown);
  if (match === null) return undefined;
  const [, sign, integer, fraction] = match;
  const exact = parseExactDecimal(amount);
  const read = parseExactDecimal(
    `${sign}${integer!.replaceAll(",", "")}${fraction === undefined ? "" : `.${fraction}`}`,
  );
  if (exact === undefined || read === undefined || compareExactDecimals(exact, read) !== 0)
    return undefined;
  const digits = fraction === undefined ? "" : `.${"0".repeat(fraction.length)}`;
  return `${integer!.includes(",") ? "#,##0" : "0"}${digits}`;
};

const quoted = (text: string): string => (text === "" ? "" : `"${text.replaceAll('"', "")}"`);

/** A value the field's type does not allow stops the export rather than being written as something else. */
const unreadable = (type: string): never => {
  throw Object.assign(new Error("The export is incomplete. Please try again."), {
    part: "export",
    reason: `cell_unreadable:${type}`,
  });
};

/**
 * One stored value as its file cell. As shown (the default), the text is exactly what the table
 * shows, through the table's own cell projection and text rule and the viewer's locale and time
 * zone; numbers, dates and yes/no also carry the exact value and a number format that reproduces
 * the text, so Excel keeps real numbers and dates that read the same. Raw holds the stored value:
 * choice keys, ISO dates, canonical numbers and the id of a linked record.
 */
export const exportCellOf = (
  column: ExportColumn,
  value: JsonValue | undefined,
  context: ExportCellContext,
): RecordsExportCell => {
  // A value withheld on this row reads "Restricted" in the table; a raw file leaves it empty.
  if (value === undefined) return column.raw ? null : { text: RESTRICTED_TEXT };
  if (value === null) return null;
  const type = valueTypeOf(column.field);
  const invalid = (): never => unreadable(type);
  switch (type) {
    case "text":
    case "long_text":
    case "reference_number":
    case "email_address":
    case "phone_number":
    case "web_address":
    case "choice":
      if (typeof value !== "string") return invalid();
      break;
    case "several_choices":
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
        return invalid();
      break;
    case "whole_number":
      if (typeof value !== "number" || !Number.isFinite(value)) return invalid();
      break;
    case "decimal_number":
    case "date":
    case "date_time":
      if (typeof value !== "string") return invalid();
      break;
    case "yes_no":
      if (typeof value !== "boolean") return invalid();
      break;
    case "money":
      if (
        !isRecord(value) ||
        typeof value.amount !== "string" ||
        typeof value.currency !== "string"
      )
        return invalid();
      break;
    case "link":
    case "link_to_one_of_several":
      if (asRecordLink(value) === undefined) return invalid();
      break;
    case "formatted_text":
      break;
    default:
      return invalid();
  }
  const projected = projectCell(
    value,
    column.format,
    context.choices,
    context.dateType,
    (link) => context.titles.get(recordLinkLabelKey(link)),
    context.linkType,
  );
  if (type === "formatted_text" && projected.kind !== "rich_text") return invalid();
  const stored = value as Exclude<JsonValue, null>;
  if (column.raw) {
    switch (type) {
      case "several_choices":
        return { text: (stored as string[]).join("; ") };
      case "whole_number":
      case "decimal_number": {
        const amount = String(stored);
        return { text: amount, typed: { kind: "number", amount, format: plainFormat(amount) } };
      }
      case "money": {
        const { amount, currency } = stored as { amount: string; currency: string };
        return {
          text: `${currency} ${amount}`,
          typed: { kind: "number", amount, format: `"${currency}" ${plainFormat(amount)}` },
        };
      }
      case "yes_no":
        return {
          text: String(stored),
          typed: { kind: "yes_no", value: stored as boolean },
        };
      case "date":
        // Typed only once the strict ISO check of the table's own cell projection has passed.
        return projected.kind === "date"
          ? {
              text: stored as string,
              typed: { kind: "date", iso: stored as string, format: "yyyy-mm-dd" },
            }
          : { text: stored as string };
      case "link":
      case "link_to_one_of_several": {
        // Only a link the viewer may read exports its record's id; a restricted one stays empty.
        const link = asRecordLink(stored)!;
        const title = context.titles.get(recordLinkLabelKey(link));
        return title?.kind === "record_link" ? { text: link.recordId } : null;
      }
      case "formatted_text":
        return { text: cellValueToText(projected) };
      default:
        return { text: stored as string };
    }
  }
  const text = cellValueToText(projected, context.presentation);
  if (projected.kind === "empty" || text === "") return null;
  switch (type) {
    case "whole_number":
    case "decimal_number": {
      const amount = String(stored);
      const format = shownNumberFormat(text, amount);
      return format === undefined ? { text } : { text, typed: { kind: "number", amount, format } };
    }
    case "money": {
      const money = stored as { amount: string; currency: string };
      const shape = moneyDisplayShape(money);
      const digits = shape.fractionDigits === 0 ? "" : `.${"0".repeat(shape.fractionDigits)}`;
      return {
        text,
        typed: {
          kind: "number",
          amount: money.amount,
          format: `${quoted(shape.prefix)}#,##0${digits}${quoted(shape.suffix)}`,
        },
      };
    }
    case "yes_no":
      return projected.kind === "boolean"
        ? {
            text,
            typed: {
              kind: "yes_no",
              value: projected.value,
              format: `"${YES_TEXT}";"${YES_TEXT}";"${NO_TEXT}"`,
            },
          }
        : { text };
    case "date":
    case "date_time": {
      // Excel holds only some dates; anything else stays the text the table shows.
      if (projected.kind !== "date" || !excelCanHoldDate(projected.iso, context.presentation))
        return { text };
      const format = isoDateExcelFormat(projected.iso, context.presentation);
      return format === undefined
        ? { text }
        : { text, typed: { kind: "date", iso: projected.iso, format } };
    }
    default:
      return { text };
  }
};
