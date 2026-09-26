import type { ReactElement } from "react";
import { readRecordDetailContract } from "@vortex/contracts";
import { Card, CardContent, CardHeader } from "../components/card";
import { Separator } from "../components/separator";
import { cn } from "../lib/utils";
import { DisplayCellView } from "./cell";
import { DisplayHeader, RowActionControl } from "./controls";
import { resolveDisplayContext, type DisplayRenderProps } from "./context";
import { DisplayStateContainer } from "./display-state-container";
import type { DisplayField, RecordDetailPayload } from "./projected-data";

/**
 * Shared browser-safe display component for record details, rendered with shadcn Card parts.
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
  const hasHeader = title !== undefined || events?.refresh !== undefined;

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
        <Card
          data-vortex-display="record_detail"
          data-vortex-placement-id={placementId}
          data-vortex-record-id={values.recordId}
          className={cn("vortex-display-record-detail")}
          role="region"
          aria-label={accessibleName}
        >
          {hasHeader ? (
            <CardHeader className={cn("vortex-display-header")}>
              <DisplayHeader title={title} accessibleName={accessibleName} events={events} />
            </CardHeader>
          ) : null}
          {hasHeader ? <Separator /> : null}
          <CardContent>
            <dl className={cn("grid gap-4 sm:grid-cols-2", "vortex-record-detail-fields")}>
              {fields.map((field) => (
                <div
                  key={field.key}
                  data-vortex-field-key={field.key}
                  className={cn("flex flex-col gap-1", "vortex-record-detail-field")}
                >
                  <dt className={cn("text-sm text-muted-foreground", "vortex-field-label")}>
                    {field.label}
                  </dt>
                  <dd className={cn("text-sm", "vortex-field-value")}>
                    <DisplayCellView value={field.value} />
                  </dd>
                </div>
              ))}
            </dl>
            <RowActionControl recordId={values.recordId} name={accessibleName} events={events} />
          </CardContent>
        </Card>
      )}
    </DisplayStateContainer>
  );
}
