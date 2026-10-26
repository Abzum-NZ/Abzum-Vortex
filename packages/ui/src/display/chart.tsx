import type { ReactElement } from "react";
import {
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  chartPayloadSchema,
  type ChartPayload,
} from "@vortex/platform/schema";
import { Progress } from "../components/progress";
import { createPayloadParser, type PlatformComponentRegistration } from "../registry";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/table";
import { DisplayHeader } from "./controls";
import { resolveDisplayContext, type DisplayRenderProps } from "./context";
import { DisplayStateContainer } from "./display-state-container";
import {
  parseDisplayData,
  parseDisplayEventHandlers,
  projectedValuesParser,
} from "./projected-data";

export type { ChartPayload };

const CHART_PAYLOAD_PARSER = createPayloadParser({
  data: (value, location) =>
    parseDisplayData(
      value,
      projectedValuesParser(chartPayloadSchema, "Projected chart values are invalid"),
      location,
    ),
  events: (value, location) => parseDisplayEventHandlers(value, location),
});

/**
 * Browser-safe bar chart over a grouped query summary. The chart is one accessible table: each
 * row names its group and measure as text, and the bar beside it is decoration only. It never
 * fetches or executes a Query.
 */
export function ChartDisplay(props: DisplayRenderProps<ChartPayload>): ReactElement {
  const { placementId, availability } = props;
  const {
    title,
    accessibleName,
    values,
    state,
    emptyMessage,
    refusedMessage,
    errorMessage,
    events,
  } = resolveDisplayContext<ChartPayload>(
    props,
    (chart) => chart.points.length === 0,
    "No data to chart",
  );
  const maximum = values === undefined ? 0 : Math.max(0, ...values.points.map((p) => p.value));

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={availability}
      projectedData={state}
      emptyMessage={emptyMessage}
      refusedMessage={refusedMessage ?? "This chart is unavailable."}
      {...(errorMessage === undefined ? {} : { errorMessage })}
    >
      {values === undefined ? null : (
        <section
          data-vortex-display="chart"
          data-vortex-placement-id={placementId}
          className="flex flex-col gap-2"
          aria-label={accessibleName}
        >
          <DisplayHeader title={title} accessibleName={accessibleName} events={events} />
          <Table>
            <TableCaption className="sr-only">
              {`${accessibleName}: ${values.measureLabel} by ${values.categoryLabel}`}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{values.categoryLabel}</TableHead>
                <TableHead scope="col" className="w-full">
                  {values.measureLabel}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {values.points.map((point) => (
                <TableRow key={point.key} data-vortex-chart-key={point.key}>
                  <TableCell className="whitespace-nowrap">{point.label}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Progress
                        aria-hidden="true"
                        className="min-w-0 flex-1"
                        value={maximum === 0 ? 0 : (point.value / maximum) * 100}
                      />
                      <span className="tabular-nums">{point.text}</span>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {values.moreGroups ? (
            <p className="text-sm text-muted-foreground" data-vortex-chart-more="true">
              {`Showing the first ${values.points.length} groups.`}
            </p>
          ) : null}
        </section>
      )}
    </DisplayStateContainer>
  );
}

export const CHART_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.CHART_BLOCK_RELEASE,
      parsePayload: CHART_PAYLOAD_PARSER,
    }),
  ]);
