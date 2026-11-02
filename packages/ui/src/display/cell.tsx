import type { ReactElement } from "react";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/table";
import { DefinitionRenderError } from "../definition-error";
import { NavigationLink } from "../routing/navigation-link";
import { FormattedTime } from "./date-format-context";
import { Badge } from "../components/badge";
import { optionToneFillClass } from "./option-tone";
import {
  isSafeLinkAddress,
  RESTRICTED_TEXT,
  UNAVAILABLE_TEXT,
  NO_ROWS_TEXT,
} from "@vortex/platform/schema";
import {
  isInternalAddress,
  isWebLinkAddress,
  type DisplayDetailCell,
  type DisplayTableField,
} from "./projected-data";
import { RichTextDocumentView } from "./rich-text";

const statusDot = "size-1.5 shrink-0 rounded-full";

/**
 * A table field's rows as a compact read-only table that scrolls sideways inside its own container,
 * with the declared column headings; a table with no rows says so, and one with more rows than are
 * shown says how many it holds.
 */
function TableFieldView({ value }: Readonly<{ value: DisplayTableField }>): ReactElement {
  if (value.rows.length === 0)
    return <span className="vortex-cell-empty text-muted-foreground">{NO_ROWS_TEXT}</span>;
  return (
    <Table containerClassName="border-0 bg-transparent">
      {value.rowCount > value.rows.length ? (
        <TableCaption>
          Showing the first {value.rows.length} of {value.rowCount} rows
        </TableCaption>
      ) : null}
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
 * Pure display renderer for one closed cell value.
 * Emits pure React elements without script execution or raw HTML injection.
 */
export function DisplayCellView({ value }: Readonly<{ value: DisplayDetailCell }>): ReactElement {
  switch (value.kind) {
    case "text":
      return <span className="vortex-cell-text">{value.text}</span>;
    case "number":
      return <span className="vortex-cell-number">{value.formatted ?? String(value.value)}</span>;
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
        <Badge
          variant="outline"
          data-vortex-choice-key={value.key}
          data-vortex-option-tone={value.tone ?? "neutral"}
        >
          <span
            aria-hidden="true"
            className={`${statusDot} ${optionToneFillClass[value.tone ?? "neutral"]}`}
          />
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
        <NavigationLink className="vortex-cell-link" href={value.address} target="_blank">
          {value.label}
          <span aria-hidden="true"> ↗</span>
          <span className="vortex-sr-only"> (external link, opens in a new page)</span>
        </NavigationLink>
      ) : (
        <NavigationLink className="vortex-cell-link" href={value.address}>
          {value.label}
        </NavigationLink>
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
        <NavigationLink className="vortex-cell-link" href={value.href}>
          {value.label}
        </NavigationLink>
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
