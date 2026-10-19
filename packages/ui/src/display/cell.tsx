import type { ReactElement } from "react";
import { Badge } from "../components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/table";
import { DefinitionRenderError } from "../definition-error";
import { formatIsoDate, INVALID_DATE_TEXT, type DateFormatOptions } from "./date-format";
import { FormattedTime } from "./date-format-context";
import { isSafeLinkAddress } from "@vortex/platform/schema";
import {
  isInternalAddress,
  isWebLinkAddress,
  type DisplayCellValue,
  type DisplayTableFieldValue,
} from "./projected-data";
import { RichTextDocumentView, richTextToPlainText } from "./rich-text";

const RESTRICTED_TEXT = "Restricted";
const UNAVAILABLE_TEXT = "Unavailable";
const NO_ROWS_TEXT = "No rows";

const rowCountText = (count: number): string =>
  count === 0 ? NO_ROWS_TEXT : count === 1 ? "1 row" : `${count} rows`;

/**
 * A table field's rows as a compact read-only table that scrolls sideways inside its own container,
 * with the declared column headings; a table with no rows says so.
 */
function TableFieldView({ value }: Readonly<{ value: DisplayTableFieldValue }>): ReactElement {
  if (value.rows.length === 0)
    return <span className="vortex-cell-empty text-muted-foreground">{NO_ROWS_TEXT}</span>;
  return (
    <Table containerClassName="rounded-md">
      <TableHeader>
        <TableRow>
          {value.columns.map((column) => (
            <TableHead key={column.key} scope="col">
              {column.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {value.rows.map((row, index) => (
          <TableRow key={index}>
            {value.columns.map((column) => {
              const cell = row[column.key];
              return (
                <TableCell key={column.key}>
                  {cell === undefined ? null : <DisplayCellView value={cell} />}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * Extracts a plain text representation from any display cell value.
 * Useful for accessible names, aria-labels and tooltips.
 */
export function cellValueToText(value: DisplayCellValue, options?: DateFormatOptions): string {
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
      return rowCountText(value.rows.length);
  }
}

/**
 * Pure display renderer for one closed cell value.
 * Emits pure React elements without script execution or raw HTML injection.
 */
export function DisplayCellView({
  value,
}: Readonly<{ value: DisplayCellValue }>): ReactElement {
  switch (value.kind) {
    case "text":
      return <span className="vortex-cell-text">{value.text}</span>;
    case "number":
      return (
        <span className="vortex-cell-number">
          {value.formatted ?? String(value.value)}
        </span>
      );
    case "boolean":
      return (
        <span className="vortex-cell-boolean" data-vortex-boolean={String(value.value)}>
          {value.value ? "Yes" : "No"}
        </span>
      );
    case "date":
      return <FormattedTime className="vortex-cell-date" iso={value.iso} />;
    case "choice":
      return (
        <Badge variant="outline" data-vortex-choice-key={value.key}>
          {value.label}
        </Badge>
      );
    case "link":
      // Re-checked here because this view is exported and may receive unparsed values.
      if (!isSafeLinkAddress(value.address))
        throw new DefinitionRenderError(
          "INVALID_COMPOSITION",
          "A link display value requires a safe web, mail or telephone address",
        );
      return isWebLinkAddress(value.address) ? (
        <a
          className="vortex-cell-link"
          href={value.address}
          target="_blank"
          rel="noopener noreferrer"
        >
          {value.label}
          <span aria-hidden="true"> ↗</span>
          <span className="vortex-sr-only"> (external link, opens in a new page)</span>
        </a>
      ) : (
        <a className="vortex-cell-link" href={value.address} rel="noopener noreferrer">
          {value.label}
        </a>
      );
    case "rich_text":
      return (
        <div className="vortex-cell-rich-text">
          <RichTextDocumentView document={value.document} />
        </div>
      );
    case "record_link":
      // Re-checked here because this view is exported and may receive unparsed values.
      if (value.href !== undefined && !isInternalAddress(value.href))
        throw new DefinitionRenderError(
          "INVALID_COMPOSITION",
          "A record link display value requires an address inside this application",
        );
      return value.href === undefined ? (
        <span className="vortex-cell-text">{value.label}</span>
      ) : (
        <a className="vortex-cell-link" href={value.href}>
          {value.label}
        </a>
      );
    case "restricted":
      return <span className="vortex-cell-restricted">{RESTRICTED_TEXT}</span>;
    case "unavailable":
      return (
        <span className="vortex-cell-unavailable" role="status">
          {UNAVAILABLE_TEXT}
        </span>
      );
    case "empty":
      return (
        <span className="vortex-cell-empty">
          <span aria-hidden="true">—</span>
          <span className="vortex-sr-only">No value</span>
        </span>
      );
    case "field_table":
      return <TableFieldView value={value} />;
  }
}
