import type { ReactElement } from "react";
import { readRecordDetailContract } from "@vortex/platform/schema";
import { DefinitionRenderError } from "../definition-error";
import { Card, CardContent, CardHeader } from "../components/card";
import { Separator } from "../components/separator";
import { cn } from "../lib/utils";
import { cellValueToText, DisplayCellView } from "./cell";
import { DisplayHeader, RowActionControl } from "./controls";
import { resolveDisplayContext, rowActionEventIdOf, type DisplayRenderProps } from "./context";
import { DisplayStateContainer } from "./display-state-container";
import type { DisplayDetailField, RecordDetailPayload } from "./projected-data";

/**
 * Shared browser-safe display component for record details, rendered with the shadcn Card and
 * Separator parts. Renders labelled fields for one permission-projected record identity inside a
 * named region. A placement that declares detail fields shows exactly those fields in declared
 * order; the projected fields supply their values and any label the placement left unset. A field
 * the viewer cannot read is absent from the projection and stays absent here. Never executes or
 * fetches a Query.
 */
export function RecordDetailDisplay(props: DisplayRenderProps<RecordDetailPayload>): ReactElement {
  const { placementId, availability } = props;
  const {
    title: configuredTitle,
    accessibleName,
    values,
    state,
    emptyMessage,
    refusedMessage,
    errorMessage,
    events,
  } = resolveDisplayContext<RecordDetailPayload>(
    props,
    (detail) => detail.fields.length === 0 && detail.heading === undefined,
    "No details to show",
  );
  const contract = readRecordDetailContract(props.settings);
  if (contract?.headingField !== undefined && values !== undefined && values.heading === undefined)
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "A record heading requires its projected field value",
      { placementId },
    );
  const title =
    contract?.headingField === undefined
      ? configuredTitle
      : values?.heading === undefined
        ? undefined
        : cellValueToText(values.heading);
  const fields: readonly DisplayDetailField[] =
    values === undefined
      ? []
      : contract === undefined
        ? values.fields
        : contract.fields.flatMap((declared): DisplayDetailField[] => {
            const projected = values.fields.find((field) => field.key === declared.field);
            return projected === undefined
              ? []
              : [{ ...projected, label: declared.label ?? projected.label }];
          });
  const actions = props.slots.actions ?? undefined;
  const hasHeader = title !== undefined || events?.refresh !== undefined;
  // An actions slot with no placements adds nothing: its band shows only once a placement is in it.
  const headerClassName = cn(!hasHeader && "hidden has-[[data-vortex-layout-wrapper]]:block");

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
          role="region"
          aria-label={accessibleName}
        >
          {hasHeader || actions !== undefined ? (
            <div className={headerClassName}>
              <CardHeader
                className="*:mb-0"
                // The heading shows a field's value, so a projection refresh can find it on screen.
                data-vortex-field-key={contract?.headingField}
                data-vortex-heading-field-key={contract?.headingField}
              >
                <div className="flex min-w-0 items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 *:mb-0">
                    <DisplayHeader title={title} accessibleName={accessibleName} events={events} />
                  </div>
                  {actions === undefined ? null : <div className="shrink-0">{actions}</div>}
                </div>
              </CardHeader>
              <Separator />
            </div>
          ) : null}
          <CardContent className="flex flex-col items-start gap-4">
            <dl className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2">
              {fields.map((field) => (
                <div
                  key={field.key}
                  data-vortex-field-key={field.key}
                  className={cn(
                    "flex min-w-0 flex-col gap-1",
                    // A table field spans both columns so its own columns have room beside each other.
                    field.value.kind === "field_table" && "sm:col-span-2",
                  )}
                >
                  <dt className="text-sm font-medium text-muted-foreground">{field.label}</dt>
                  <dd className="break-words text-sm">
                    <DisplayCellView value={field.value} />
                  </dd>
                </div>
              ))}
            </dl>
            {events?.row_action === undefined ? null : (
              <RowActionControl
                recordId={values.recordId}
                name={accessibleName}
                eventId={rowActionEventIdOf(props)}
                events={events}
              />
            )}
          </CardContent>
        </Card>
      )}
    </DisplayStateContainer>
  );
}
