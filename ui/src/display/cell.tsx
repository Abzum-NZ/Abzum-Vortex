import type { ReactElement } from "react";
import { safeHttpsUrlSchema } from "@vortex/contracts";
import { DefinitionRenderError } from "../definition-error";
import { formatIsoDate, type DateFormatOptions } from "./date-format";
import { FormattedDate } from "./date-format-context";
import type { DisplayCellValue } from "./projected-data";
import { RichTextDocumentView, richTextToPlainText } from "./rich-text";

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
      return formatIsoDate(value.iso, options);
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
          <FormattedDate iso={value.iso} />
        </time>
      );
    case "choice":
      return (
        <span className="vortex-cell-choice" data-vortex-choice-key={value.key}>
          {value.label}
        </span>
      );
    case "link":
      // Re-checked here because this view is exported and may receive unparsed values.
      if (!safeHttpsUrlSchema.safeParse(value.address).success)
        throw new DefinitionRenderError(
          "INVALID_COMPOSITION",
          "A link display value requires a safe HTTPS address",
        );
      return (
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
      );
    case "rich_text":
      return (
        <div className="vortex-cell-rich-text">
          <RichTextDocumentView document={value.document} />
        </div>
      );
    case "empty":
      return (
        <span className="vortex-cell-empty">
          <span aria-hidden="true">—</span>
          <span className="vortex-sr-only">No value</span>
        </span>
      );
  }
}
