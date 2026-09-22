import type { ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import { DisplayCellView } from "./cell";
import { DisplayStateContainer, getAccessibleName } from "./display-state-container";
import { DefinitionRenderError } from "../definition-error";

/**
 * Shared browser-safe display component for grouped data.
 * Preserves stable group and record identities and declared semantic event names.
 * Never executes or fetches a Query.
 */
export function GroupedDataDisplay({
  placementId,
  settings,
  projectedData,
  displayEvents,
  availability,
  unavailableReason,
}: PlatformBlockRenderProps): ReactElement {
  const accessibleName = getAccessibleName(settings, "Grouped data");

  if (projectedData?.status === "ready" && projectedData.values.kind !== "grouped_data") {
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      `Grouped data component expected 'grouped_data' projected values, got '${projectedData.values.kind}'`,
      { placementId },
    );
  }

  const groupedValues = projectedData?.status === "ready" ? projectedData.values : undefined;
  const groups = groupedValues?.groups ?? [];

  const effectiveProjectedData =
    projectedData ?? { status: "empty" };

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={availability}
      unavailableReason={unavailableReason}
      projectedData={groups.length === 0 && effectiveProjectedData.status === "ready" ? { status: "empty" } : effectiveProjectedData}
      emptyMessage="No grouped data"
    >
      {groupedValues ? (
        <div
          data-vortex-display="grouped_data"
          data-vortex-placement-id={placementId}
          className="vortex-display-grouped-data"
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
          <div className="vortex-groups-container">
            {groups.map((group) => (
              <section
                key={group.groupId}
                data-vortex-group-id={group.groupId}
                className="vortex-data-group"
                aria-label={group.label}
              >
                <h3 className="vortex-group-heading">{group.label}</h3>
                {group.rows.length === 0 ? (
                  <div className="vortex-group-empty">No items in group</div>
                ) : (
                  <ul role="list" className="vortex-group-items">
                    {group.rows.map((row) => {
                      const isSelected = group.selectedRecordIds?.includes(row.recordId) ?? false;
                      const headingValue = row.cells[group.headingKey] ?? {
                        kind: "text",
                        text: row.recordId,
                      };
                      const secondaryValue =
                        group.secondaryKey !== undefined
                          ? row.cells[group.secondaryKey]
                          : undefined;
                      return (
                        <li
                          key={row.recordId}
                          data-vortex-record-id={row.recordId}
                          className="vortex-group-item"
                        >
                          {displayEvents?.selection_changed ? (
                            <input
                              type="checkbox"
                              className="vortex-selection-checkbox"
                              aria-label={`Select ${row.recordId}`}
                              checked={isSelected}
                              onChange={(e) =>
                                displayEvents.selection_changed?.({
                                  event: "selection_changed",
                                  recordId: row.recordId,
                                  selected: e.target.checked,
                                })
                              }
                            />
                          ) : null}
                          <div className="vortex-group-item-content">
                            <span className="vortex-group-item-heading">
                              <DisplayCellView value={headingValue} />
                            </span>
                            {secondaryValue !== undefined ? (
                              <span className="vortex-group-item-secondary">
                                <DisplayCellView value={secondaryValue} />
                              </span>
                            ) : null}
                          </div>
                          {displayEvents?.row_action ? (
                            <button
                              type="button"
                              className="vortex-button-row-action"
                              aria-label={`Action for ${row.recordId}`}
                              onClick={() =>
                                displayEvents.row_action?.({
                                  event: "row_action",
                                  recordId: row.recordId,
                                  action: "select",
                                })
                              }
                            >
                              Select
                            </button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {group.summary && group.summary.length > 0 ? (
                  <div className="vortex-group-summary">
                    {group.summary.map((sum) => (
                      <div
                        key={sum.key}
                        data-vortex-summary-key={sum.key}
                        className="vortex-group-summary-item"
                      >
                        <span className="vortex-group-summary-label">{sum.label}:</span>
                        <span className="vortex-group-summary-value">
                          <DisplayCellView value={sum.value} />
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            ))}
          </div>
        </div>
      ) : null}
    </DisplayStateContainer>
  );
}
