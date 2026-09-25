import type { ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import { DisplayCellView } from "./cell";
import { DisplayHeader, resolveDisplayContext } from "./controls";
import { DisplayStateContainer } from "./display-state-container";

/**
 * Shared browser-safe display component for labelled summary values.
 * Renders stable-keyed values inside a named region.
 * Never executes or fetches a Query.
 */
export function SummaryValuesDisplay(props: PlatformBlockRenderProps): ReactElement {
  const { placementId, availability } = props;
  const { title, accessibleName, values, state, emptyMessage, events } = resolveDisplayContext(
    props,
    "summary_values",
    (summary) => summary.values.length === 0,
    "No values to show",
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
          data-vortex-display="summary_values"
          data-vortex-placement-id={placementId}
          className="vortex-display-summary-values"
          aria-label={accessibleName}
        >
          <DisplayHeader title={title} accessibleName={accessibleName} events={events} />
          <dl className="vortex-summary-grid">
            {values.values.map((item) => (
              <div
                key={item.key}
                data-vortex-summary-key={item.key}
                className="vortex-summary-card"
              >
                <dt className="vortex-summary-label">{item.label}</dt>
                <dd className="vortex-summary-value">
                  <DisplayCellView value={item.value} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </DisplayStateContainer>
  );
}
