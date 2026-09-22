import type { ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import { DisplayCellView } from "./cell";
import { DisplayStateContainer, getAccessibleName } from "./display-state-container";
import { DefinitionRenderError } from "../definition-error";

/**
 * Shared browser-safe display component for record details.
 * Renders labelled fields for one permission-projected record identity.
 * Never executes or fetches a Query.
 */
export function RecordDetailDisplay({
  placementId,
  settings,
  projectedData,
  displayEvents,
  availability,
  unavailableReason,
}: PlatformBlockRenderProps): ReactElement {
  const accessibleName = getAccessibleName(settings, "Record detail");

  if (projectedData?.status === "ready" && projectedData.values.kind !== "record_detail") {
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      `Record detail component expected 'record_detail' projected values, got '${projectedData.values.kind}'`,
      { placementId },
    );
  }

  const detailValues = projectedData?.status === "ready" ? projectedData.values : undefined;
  const fields = detailValues?.fields ?? [];

  const effectiveProjectedData =
    projectedData ?? { status: "empty" };

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={availability}
      unavailableReason={unavailableReason}
      projectedData={fields.length === 0 && effectiveProjectedData.status === "ready" ? { status: "empty" } : effectiveProjectedData}
      emptyMessage="No record details"
    >
      {detailValues ? (
        <div
          data-vortex-display="record_detail"
          data-vortex-placement-id={placementId}
          data-vortex-record-id={detailValues.recordId}
          className="vortex-display-record-detail"
          aria-label={accessibleName}
        >
          <div className="vortex-display-header">
            <h2 className="vortex-display-title">{accessibleName}</h2>
            <div className="vortex-display-actions">
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
              {displayEvents?.row_action ? (
                <button
                  type="button"
                  className="vortex-button-row-action"
                  aria-label={`Action for record ${detailValues.recordId}`}
                  onClick={() =>
                    displayEvents.row_action?.({
                      event: "row_action",
                      recordId: detailValues.recordId,
                      action: "view",
                    })
                  }
                >
                  Action
                </button>
              ) : null}
            </div>
          </div>
          <dl className="vortex-record-detail-fields">
            {fields.map((field) => (
              <div
                key={field.key}
                data-vortex-field-key={field.key}
                className="vortex-record-detail-field"
              >
                <dt className="vortex-field-label">{field.label}</dt>
                <dd className="vortex-field-value">
                  <DisplayCellView value={field.value} />
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </DisplayStateContainer>
  );
}
