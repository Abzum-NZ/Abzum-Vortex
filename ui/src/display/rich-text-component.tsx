import type { ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import { RichTextDocumentView } from "./rich-text";
import { DisplayStateContainer, getAccessibleName } from "./display-state-container";
import { DefinitionRenderError } from "../definition-error";
import type { DisplayRichTextDocument } from "./projected-data";

/**
 * Shared browser-safe display component for validated structured rich text.
 * Renders closed structured contract using React elements only; never uses raw HTML or dangerouslySetInnerHTML.
 * Never executes or fetches a Query.
 */
export function RichTextDisplay({
  placementId,
  settings,
  projectedData,
  availability,
  unavailableReason,
}: PlatformBlockRenderProps): ReactElement {
  const accessibleName = getAccessibleName(settings, "Rich text");

  let richTextValue = projectedData?.status === "ready" ? projectedData.values : undefined;
  if (richTextValue !== undefined && richTextValue.kind !== "rich_text") {
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      `Rich text component expected 'rich_text' projected values, got '${richTextValue.kind}'`,
      { placementId },
    );
  }

  // Fallback to settings.document if projectedData was not provided
  if (richTextValue === undefined && projectedData === undefined && settings.document?.kind === "rich_text") {
    richTextValue = {
      kind: "rich_text",
      document: settings.document.value as DisplayRichTextDocument,
    };
  }

  const effectiveProjectedData =
    projectedData ??
    (richTextValue !== undefined
      ? { status: "ready", values: richTextValue }
      : { status: "empty" });

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={availability}
      unavailableReason={unavailableReason}
      projectedData={effectiveProjectedData}
      emptyMessage="No rich text content"
    >
      <div
        data-vortex-display="rich_text"
        data-vortex-placement-id={placementId}
        className="vortex-display-rich-text"
        aria-label={accessibleName}
      >
        {richTextValue ? <RichTextDocumentView document={richTextValue.document} /> : null}
      </div>
    </DisplayStateContainer>
  );
}
