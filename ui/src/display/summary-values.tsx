import type { ReactElement } from "react";
import { Card, CardContent } from "../components/card";
import { cn } from "../lib/utils";
import { DisplayCellView } from "./cell";
import { DisplayHeader } from "./controls";
import { resolveDisplayContext, type DisplayRenderProps } from "./context";
import { DisplayStateContainer } from "./display-state-container";
import type { SummaryPayload } from "./projected-data";

/**
 * Shared browser-safe display component for labelled summary values.
 * Renders stable-keyed values as shadcn Cards inside a named region.
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
          className={cn("flex flex-col gap-2", "vortex-display-summary-values")}
          aria-label={accessibleName}
        >
          <DisplayHeader title={title} accessibleName={accessibleName} events={events} />
          <dl className={cn("grid gap-3 sm:grid-cols-3", "vortex-summary-grid")}>
            {values.values.map((item) => (
              <Card
                key={item.key}
                size="sm"
                data-vortex-summary-key={item.key}
                className={cn("vortex-summary-card")}
              >
                <CardContent>
                  <dt className={cn("text-sm text-muted-foreground", "vortex-summary-label")}>
                    {item.label}
                  </dt>
                  <dd className={cn("text-base font-medium", "vortex-summary-value")}>
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
