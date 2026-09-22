import type { ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import { DisplayCellView } from "./cell";
import {
  DisplayHeader,
  PaginationControl,
  resolveDisplayContext,
  RowActionControl,
  rowName,
  SelectionControl,
} from "./controls";
import { DisplayStateContainer } from "./display-state-container";

/**
 * Shared browser-safe display component for lists of permission-projected records.
 * Preserves stable row identities and emits declared semantic events only on user interaction.
 * Never executes or fetches a Query.
 */
export function ListDisplay(props: PlatformBlockRenderProps): ReactElement {
  const { placementId, availability } = props;
  const { title, accessibleName, values, state, events } = resolveDisplayContext(
    props,
    "list",
    (list) => list.rows.length === 0,
  );

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={availability}
      projectedData={state}
      emptyMessage="No items to show"
    >
      {values === undefined ? null : (
        <section
          data-vortex-display="list"
          data-vortex-placement-id={placementId}
          className="vortex-display-list"
          aria-label={accessibleName}
        >
          <DisplayHeader title={title} accessibleName={accessibleName} events={events} />
          <ul className="vortex-list-items">
            {values.rows.map((row) => {
              const name = rowName(row, values.headingKey);
              const heading = row.cells[values.headingKey];
              const secondary =
                values.secondaryKey === undefined ? undefined : row.cells[values.secondaryKey];
              return (
                <li
                  key={row.recordId}
                  data-vortex-record-id={row.recordId}
                  className="vortex-list-item"
                >
                  <SelectionControl
                    row={row}
                    name={name}
                    selected={values.selectedRecordIds?.includes(row.recordId) ?? false}
                    events={events}
                  />
                  <div className="vortex-list-content">
                    <span className="vortex-list-heading">
                      <DisplayCellView value={heading ?? { kind: "empty" }} />
                    </span>
                    {secondary === undefined ? null : (
                      <span className="vortex-list-secondary">
                        <DisplayCellView value={secondary} />
                      </span>
                    )}
                  </div>
                  <RowActionControl recordId={row.recordId} name={name} events={events} />
                </li>
              );
            })}
          </ul>
          <PaginationControl
            page={values.page}
            pageCount={values.pageCount}
            accessibleName={accessibleName}
            events={events}
          />
        </section>
      )}
    </DisplayStateContainer>
  );
}
