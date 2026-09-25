import type { ReactElement } from "react";
import { DisplayCellView } from "./cell";
import { DisplayHeader, RowActionControl, SelectionControl } from "./controls";
import { resolveDisplayContext, rowName, type DisplayRenderProps } from "./context";
import { DisplayStateContainer } from "./display-state-container";
import type { GroupedPayload } from "./projected-data";

/**
 * Shared browser-safe display component for grouped data.
 * Preserves stable group and record identities and declared semantic event names.
 * Never executes or fetches a Query.
 */
export function GroupedDataDisplay(props: DisplayRenderProps<GroupedPayload>): ReactElement {
  const { placementId, availability } = props;
  const { title, accessibleName, values, state, emptyMessage, events } =
    resolveDisplayContext<GroupedPayload>(
      props,
      (grouped) => grouped.groups.length === 0,
      "No groups to show",
    );

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={availability}
      projectedData={state}
      emptyMessage={emptyMessage}
    >
      {values === undefined ? null : (
        <section
          data-vortex-display="grouped_data"
          data-vortex-placement-id={placementId}
          className="vortex-display-grouped-data"
          aria-label={accessibleName}
        >
          <DisplayHeader title={title} accessibleName={accessibleName} events={events} />
          {values.groups.map((group) => (
            <section
              key={group.groupId}
              data-vortex-group-id={group.groupId}
              className="vortex-data-group"
              aria-label={group.label}
            >
              <h3 className="vortex-group-heading">{group.label}</h3>
              {group.rows.length === 0 ? (
                <p className="vortex-group-empty">No items in this group</p>
              ) : (
                <ul className="vortex-group-items">
                  {group.rows.map((row) => {
                    const name = rowName(row, group.headingKey);
                    const heading = row.cells[group.headingKey];
                    const secondary =
                      group.secondaryKey === undefined ? undefined : row.cells[group.secondaryKey];
                    return (
                      <li
                        key={row.recordId}
                        data-vortex-record-id={row.recordId}
                        className="vortex-group-item"
                      >
                        <SelectionControl
                          row={row}
                          name={name}
                          selected={group.selectedRecordIds?.includes(row.recordId) ?? false}
                          events={events}
                        />
                        <div className="vortex-group-item-content">
                          <span className="vortex-group-item-heading">
                            <DisplayCellView value={heading ?? { kind: "empty" }} />
                          </span>
                          {secondary === undefined ? null : (
                            <span className="vortex-group-item-secondary">
                              <DisplayCellView value={secondary} />
                            </span>
                          )}
                        </div>
                        <RowActionControl recordId={row.recordId} name={name} events={events} />
                      </li>
                    );
                  })}
                </ul>
              )}
              {group.summary === undefined || group.summary.length === 0 ? null : (
                <dl className="vortex-group-summary">
                  {group.summary.map((summary) => (
                    <div
                      key={summary.key}
                      data-vortex-summary-key={summary.key}
                      className="vortex-group-summary-item"
                    >
                      <dt className="vortex-group-summary-label">{summary.label}</dt>
                      <dd className="vortex-group-summary-value">
                        <DisplayCellView value={summary.value} />
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>
          ))}
        </section>
      )}
    </DisplayStateContainer>
  );
}
