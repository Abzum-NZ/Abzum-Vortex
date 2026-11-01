import { formatIsoDate, INVALID_DATE_TEXT, type DateFormatOptions } from "./date-format";
import type { DisplayDetailCell } from "./display-payload-parts";

/** What a cell shows for a value the viewer may not read, and for one that could not be read. */
export const RESTRICTED_TEXT = "Restricted";
export const UNAVAILABLE_TEXT = "Unavailable";
export const NO_ROWS_TEXT = "No rows";

/** The text of a table field's cell: how many rows it holds. */
export const rowCountText = (count: number): string =>
  count === 0 ? NO_ROWS_TEXT : count === 1 ? "1 row" : `${count} rows`;

type RichTextDocument = Extract<DisplayDetailCell, { kind: "rich_text" }>["document"];
type RichTextBlock = RichTextDocument["blocks"][number];
type RichTextInline = Extract<RichTextBlock, { kind: "paragraph" }>["children"][number];

/** Flattens a validated rich-text document to plain text. */
export function richTextToPlainText(document: RichTextDocument): string {
  const inlineText = (inline: RichTextInline): string => {
    switch (inline.kind) {
      case "text":
        return inline.text;
      case "emphasis":
        return inline.children.map(inlineText).join("");
      case "link":
        return inline.children.map(inlineText).join("");
    }
  };
  const blockText = (block: RichTextBlock): string => {
    switch (block.kind) {
      case "paragraph":
      case "heading":
        return block.children.map(inlineText).join("");
      case "bulleted_list":
      case "numbered_list":
        return block.items.map((item) => item.map(inlineText).join("")).join(" ");
    }
  };
  return document.blocks.map(blockText).join(" ");
}

/**
 * The one plain-text form of any display cell value: what a cell reads as, for accessible names,
 * a copied range, Find and an export file. Dates read in the given locale and time zone.
 */
export function cellValueToText(value: DisplayDetailCell, options?: DateFormatOptions): string {
  switch (value.kind) {
    case "text":
      return value.text;
    case "number":
      return value.formatted ?? String(value.value);
    case "boolean":
      return value.value ? "Yes" : "No";
    case "date":
      return formatIsoDate(value.iso, options) ?? INVALID_DATE_TEXT;
    case "choice":
      return value.label;
    case "link":
      return value.label;
    case "rich_text":
      return richTextToPlainText(value.document);
    case "record_link":
      return value.label;
    case "restricted":
      return RESTRICTED_TEXT;
    case "unavailable":
      return UNAVAILABLE_TEXT;
    case "empty":
      return "";
    case "field_table":
      return rowCountText(value.rowCount);
  }
}
