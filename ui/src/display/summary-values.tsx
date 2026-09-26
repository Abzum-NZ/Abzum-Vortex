import type { ReactElement } from "react";
import { Card, CardContent } from "../components/card";
import { DisplayCellView } from "./cell";
import { DisplayHeader } from "./controls";
import { resolveDisplayContext, type DisplayRenderProps } from "./context";
import { DisplayStateContainer } from "./display-state-container";
import type { SummaryPayload } from "./projected-data";

/**
 * Shared browser-safe display component for labelled summary values, rendered as shadcn Cards
 * inside a named region. Renders stable-keyed values, each in its own small card.
 * Never executes or fetches a Query.
 */
export function SummaryValuesDisplay(props: DisplayRenderProps<SummaryPayload>): ReactElement {
  const { placementId, availability } = props;
  const { title, accessibleName, values, state, emptyMessage, events } =
    resolveDisplayContext<SummaryPayload>(
      props,
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
          className="flex flex-col gap-2"
          aria-label={accessibleName}
        >
          <DisplayHeader title={title} accessibleName={accessibleName} events={events} />
          <dl className="m-0 grid gap-3 sm:grid-cols-3">
            {values.values.map((item) => (
              <Card key={item.key} size="sm" data-vortex-summary-key={item.key}>
                <CardContent>
                  <dt className="text-sm text-muted-foreground">{item.label}</dt>
                  <dd className="mt-1 text-base font-medium">
                    <DisplayCellView value={item.value} />
                  </dd>
                </CardContent>
              </Card>
            ))}
          </dl>
        </section>
      )}
    </DisplayStateContainer>
  );
}
