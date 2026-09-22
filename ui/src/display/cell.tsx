import type { ReactElement } from "react";
import type { DisplayCellValue } from "./projected-data";
import { RichTextDocumentView, richTextToPlainText } from "./rich-text";

/**
 * Formats an ISO timestamp safely to a standard presentation string.
 * Falls back to the raw ISO string if invalid.
 */
export function formatIsoDate(iso: string): string {
  try {
    const timestamp = Date.parse(iso);
    if (!Number.isNaN(timestamp)) {
      const date = new Date(timestamp);
      return date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    }
  } catch {
    // Return raw iso if parsing fails
  }
  return iso;
}

/**
 * Extracts a plain text representation from any display cell value.
 * Useful for accessible names, aria-labels and tooltips.
 */
export function cellValueToText(value: DisplayCellValue): string {
  switch (value.kind) {
    case "text":
      return value.text;
    case "number":
      return value.formatted ?? String(value.value);
    case "boolean":
      return value.value ? "Yes" : "No";
    case "date":
      return formatIsoDate(value.iso);
    case "choice":
      return value.label;
    case "link":
      return value.label;
    case "rich_text":
      return richTextToPlainText(value.document);
    case "empty":
      return "";
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
      return (
        <time className="vortex-cell-date" dateTime={value.iso}>
          {formatIsoDate(value.iso)}
        </time>
      );
    case "choice":
      return (
        <span className="vortex-cell-choice" data-vortex-choice-key={value.key}>
          {value.label}
        </span>
      );
    case "link":
      return (
        <a
          className="vortex-cell-link"
          href={value.address}
          target="_blank"
          rel="noopener noreferrer"
        >
          {value.label}
          <span className="vortex-sr-only"> (external link)</span>
        </a>
      );
    case "rich_text":
      return (
        <span className="vortex-cell-rich-text">
          <RichTextDocumentView document={value.document} />
        </span>
      );
    case "empty":
      return (
        <span className="vortex-cell-empty" aria-label="Empty">
          —
        </span>
      );
  }
}
