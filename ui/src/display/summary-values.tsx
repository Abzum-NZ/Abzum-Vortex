import type { ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import { DisplayCellView } from "./cell";
import { DisplayStateContainer, getAccessibleName } from "./display-state-container";
import { DefinitionRenderError } from "../definition-error";

/**
 * Shared browser-safe display component for metric cards and summary values.
 * Renders labelled summary values with stable keys and accessible region container.
 * Never executes or fetches a Query.
 */
export function SummaryValuesDisplay({
  placementId,
  settings,
  projectedData,
  displayEvents,
  availability,
  unavailableReason,
}: PlatformBlockRenderProps): ReactElement {
  const accessibleName = getAccessibleName(settings, "Summary values");

  if (projectedData?.status === "ready" && projectedData.values.kind !== "summary_values") {
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      `Summary values component expected 'summary_values' projected values, got '${projectedData.values.kind}'`,
      { placementId },
    );
  }

  const summaryData = projectedData?.status === "ready" ? projectedData.values : undefined;
  const values = summaryData?.values ?? [];

  const effectiveProjectedData =
    projectedData ?? { status: "empty" };

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={availability}
      unavailableReason={unavailableReason}
      projectedData={values.length === 0 && effectiveProjectedData.status === "ready" ? { status: "empty" } : effectiveProjectedData}
      emptyMessage="No summary values"
    >
      {summaryData ? (
        <div
          data-vortex-display="summary_values"
          data-vortex-placement-id={placementId}
          role="region"
          className="vortex-display-summary-values"
          aria-label={accessibleName}
        >
          <div className="vortex-display-header">
            <h2 className="vortex-display-title">{accessibleName}</h2>
            {displayEvents?.refresh ? (
              <button
                type="button"
                className="vortex-button-refresh"
                aria-label={`Refresh ${accessibleName}`}
                onClick={() => displayEvents.refresh?.({ event: "refresh" })}
              >
                Refresh
              </button>
            ) : null}
          </div>
          <div className="vortex-summary-grid">
            {values.map((item) => (
              <div
                key={item.key}
                data-vortex-summary-key={item.key}
                className="vortex-summary-card"
              >
                <div className="vortex-summary-label">{item.label}</div>
                <div className="vortex-summary-value">
                  <DisplayCellView value={item.value} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </DisplayStateContainer>
  );
}
