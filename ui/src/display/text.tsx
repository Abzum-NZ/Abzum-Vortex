import type { ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import { DisplayCellView } from "./cell";
import { DisplayStateContainer, getAccessibleName } from "./display-state-container";
import { DefinitionRenderError } from "../definition-error";

/**
 * Shared browser-safe display component for plain text values.
 * Consumes caller-supplied permission-projected text or explicit text setting.
 * Never executes or fetches a Query.
 */
export function PlainTextDisplay({
  placementId,
  settings,
  projectedData,
  availability,
  unavailableReason,
}: PlatformBlockRenderProps): ReactElement {
  const accessibleName = getAccessibleName(settings, "Plain text");

  let cellValue = projectedData?.status === "ready" ? projectedData.values : undefined;
  if (cellValue !== undefined && cellValue.kind !== "text") {
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      `Plain text component expected 'text' projected values, got '${cellValue.kind}'`,
      { placementId },
    );
  }

  // Fallback to settings.text if projectedData was not provided
  if (cellValue === undefined && projectedData === undefined && settings.text?.kind === "text") {
    cellValue = { kind: "text", value: { kind: "text", text: settings.text.value } };
  }

  const effectiveProjectedData =
    projectedData ??
    (cellValue !== undefined
      ? { status: "ready", values: cellValue }
      : { status: "empty" });

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={availability}
      unavailableReason={unavailableReason}
      projectedData={effectiveProjectedData}
      emptyMessage="No text content"
    >
      <div
        data-vortex-display="text"
        data-vortex-placement-id={placementId}
        className="vortex-display-text"
        aria-label={accessibleName}
      >
        {cellValue ? <DisplayCellView value={cellValue.value} /> : null}
      </div>
    </DisplayStateContainer>
  );
}
