import type { ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import { DisplayCellView } from "./cell";
import { DisplayHeader, resolveDisplayContext, RowActionControl } from "./controls";
import { DisplayStateContainer } from "./display-state-container";

/**
 * Shared browser-safe display component for record details.
 * Renders labelled fields for one permission-projected record identity.
 * Never executes or fetches a Query.
 */
export function RecordDetailDisplay(props: PlatformBlockRenderProps): ReactElement {
  const { placementId, availability } = props;
  const { title, accessibleName, values, state, events } = resolveDisplayContext(
    props,
    "record_detail",
    (detail) => detail.fields.length === 0,
  );

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={availability}
      projectedData={state}
      emptyMessage="No details to show"
    >
      {values === undefined ? null : (
        <section
          data-vortex-display="record_detail"
          data-vortex-placement-id={placementId}
          data-vortex-record-id={values.recordId}
          className="vortex-display-record-detail"
          aria-label={accessibleName}
        >
          <DisplayHeader title={title} accessibleName={accessibleName} events={events} />
          <dl className="vortex-record-detail-fields">
            {values.fields.map((field) => (
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
          <RowActionControl recordId={values.recordId} name={accessibleName} events={events} />
        </section>
      )}
    </DisplayStateContainer>
  );
}
