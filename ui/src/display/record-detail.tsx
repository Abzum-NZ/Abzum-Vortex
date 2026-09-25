import type { ReactElement } from "react";
import { readRecordDetailContract } from "@vortex/contracts";
import { DisplayCellView } from "./cell";
import {
  DisplayHeader,
  resolveDisplayContext,
  RowActionControl,
  type DisplayRenderProps,
} from "./controls";
import { DisplayStateContainer } from "./display-state-container";
import type { DisplayField, RecordDetailPayload } from "./projected-data";

/**
 * Shared browser-safe display component for record details.
 * Renders labelled fields for one permission-projected record identity. A placement that declares
 * detail fields shows exactly those fields in declared order; the projected fields supply their
 * values and any label the placement left unset. Never executes or fetches a Query.
 */
export function RecordDetailDisplay(
  props: DisplayRenderProps<RecordDetailPayload>,
): ReactElement {
  const { placementId, availability } = props;
  const { title, accessibleName, values, state, emptyMessage, refusedMessage, errorMessage, events } =
    resolveDisplayContext<RecordDetailPayload>(
      props,
      (detail) => detail.fields.length === 0,
      "No details to show",
    );
  const contract = readRecordDetailContract(props.settings);
  const fields: readonly DisplayField[] =
    values === undefined
      ? []
      : contract === undefined
        ? values.fields
        : contract.fields.flatMap((declared): DisplayField[] => {
            const projected = values.fields.find((field) => field.key === declared.field);
            return projected === undefined
              ? []
              : [{ ...projected, label: declared.label ?? projected.label }];
          });

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={availability}
      projectedData={state}
      emptyMessage={emptyMessage}
      {...(refusedMessage === undefined ? {} : { refusedMessage })}
      {...(errorMessage === undefined ? {} : { errorMessage })}
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
          <RowActionControl recordId={values.recordId} name={accessibleName} events={events} />
        </section>
      )}
    </DisplayStateContainer>
  );
}
