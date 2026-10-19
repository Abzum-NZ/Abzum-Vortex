import type { ReactElement } from "react";
import { createDeclaredSettingsReader } from "../controls/control-context";
import { DefinitionRenderError } from "../definition-error";
import { DisplayCellView } from "./cell";
import { DisplayHeader } from "./controls";
import { resolveDisplayContext, type DisplayRenderProps } from "./context";
import { DisplayStateContainer } from "./display-state-container";
import { MetricCard } from "./metric-card";
import type { SummaryPayload } from "./projected-data";

/**
 * Shared browser-safe display component for labelled summary values, rendered as metric cards
 * inside a named region. Renders stable-keyed values, each in its own card.
 * Never executes or fetches a Query.
 */
export function SummaryValuesDisplay(props: DisplayRenderProps<SummaryPayload>): ReactElement {
  const { placementId, availability } = props;
  const location = {
    placementId,
    blockId: props.metadata.blockId,
    releaseVersion: props.metadata.releaseVersion,
    propertyPath: ["card_min_width"],
  };
  const minimumWidth = createDeclaredSettingsReader(props, location).read(
    "card_min_width",
    "number",
  );
  if (
    minimumWidth?.kind !== "number" ||
    !Number.isFinite(minimumWidth.value) ||
    minimumWidth.value <= 0
  )
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "Summary card minimum width must be set to a positive number",
      location,
    );
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
      refusedMessage="This summary is unavailable."
    >
      {values === undefined ? null : (
        <section
          data-vortex-display="summary_values"
          data-vortex-placement-id={placementId}
          className="flex flex-col gap-2"
          aria-label={accessibleName}
        >
          <DisplayHeader title={title} accessibleName={accessibleName} events={events} />
          <div
            className="grid gap-3"
            style={{
              gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${minimumWidth.value}px), 1fr))`,
            }}
          >
            {values.values.map((item) => (
              <MetricCard key={item.key} label={item.label} data-vortex-summary-key={item.key}>
                {item.value.kind === "unavailable" ? (
                  <span role="status" data-vortex-summary-value-state="unavailable">
                    Unavailable
                  </span>
                ) : (
                  <DisplayCellView value={item.value} />
                )}
              </MetricCard>
            ))}
          </div>
        </section>
      )}
    </DisplayStateContainer>
  );
}
