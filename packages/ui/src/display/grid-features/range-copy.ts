import type {
  DisplayCellValue,
  DisplayRichTextBlock,
  DisplayRichTextInline,
  DisplayRow,
} from "../projected-data";
import type { GridColumn } from "../table-layout";

/**
 * The canonical text of a selected range, as tab-separated values for the clipboard. It is pure and
 * reads nothing: every value is the one the page already carries for a cell the viewer may read
 * (an exact decimal or "amount CURRENCY" from the page's `exact` values, an ISO date, a link's
 * title, a choice's label). A column whose selected cells are all withheld is left out, and a
 * withheld cell inside a readable column is empty; a hidden column is never in the range. A value
 * a spreadsheet would run as a formula (a leading `=`, `+`, `-` or `@`, a tab or a carriage
 * return) is prefixed with an apostrophe so it pastes as text.
 */

const inlineText = (inline: DisplayRichTextInline): string =>
  inline.kind === "text" ? inline.text : inline.children.map(inlineText).join("");

const blockText = (block: DisplayRichTextBlock): string =>
  "items" in block
    ? block.items.map((item) => item.map(inlineText).join("")).join("\n")
    : block.children.map(inlineText).join("");

/** A plain signed decimal: the only text left unprefixed when it starts with a sign. */
const plainNumber = /^-?\d+(\.\d+)?( [A-Z]{3})?$/;

/** The canonical text of one cell, and whether it is a system-produced number. */
const cellText = (
  cell: DisplayCellValue | undefined,
  exact: string | undefined,
): Readonly<{ text: string; number: boolean }> => {
  if (exact !== undefined) return { text: exact, number: plainNumber.test(exact) };
  if (cell === undefined) return { text: "", number: false };
  switch (cell.kind) {
    case "text":
      return { text: cell.text, number: false };
    case "number":
      return { text: String(cell.value), number: true };
    case "boolean":
      return { text: String(cell.value), number: false };
    case "date":
      return { text: cell.iso, number: false };
    case "choice":
      return { text: cell.label, number: false };
    case "link":
    case "record_link":
      return { text: cell.label, number: false };
    case "rich_text":
      return { text: cell.document.blocks.map(blockText).join("\n"), number: false };
    case "field_table":
      return { text: "", number: false };
    case "restricted":
    case "unavailable":
    case "empty":
      return { text: "", number: false };
  }
};

/** Makes a value that a spreadsheet would run as a formula paste as text. */
export const neutraliseFormula = (text: string, trustedNumber: boolean): string =>
  /^[=+\-@\t\r]/.test(text) && !(trustedNumber && plainNumber.test(text)) ? `'${text}` : text;

/** Quotes a field that holds a tab, a line break or a quote, as spreadsheets write TSV. */
const quoted = (text: string): string =>
  /[\t\r\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;

/**
 * The TSV of the rectangle: `rows` are the shown rows from the first to the last selected, `columns`
 * the shown columns from the first to the last selected, both in display order.
 */
export function rangeToTsv(rows: readonly DisplayRow[], columns: readonly GridColumn[]): string {
  const copied = columns.filter((column) =>
    rows.some((row) => {
      const cell = row.cells[column.key];
      return cell !== undefined && cell.kind !== "restricted";
    }),
  );
  return rows
    .map((row) =>
      copied
        .map((column) => {
          const { text, number } = cellText(row.cells[column.key], row.exact?.[column.key]);
          return quoted(neutraliseFormula(text, number));
        })
        .join("\t"),
    )
    .join("\n");
}
