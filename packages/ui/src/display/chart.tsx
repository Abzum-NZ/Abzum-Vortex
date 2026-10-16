import type { ReactElement } from "react";
import { PLATFORM_BLOCK_RELEASE_IDENTITIES } from "@vortex/platform/schema";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
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
import { parseDisplayData, parseDisplayEventHandlers } from "./projected-data";

/** One bar: a stable group key, its readable label, and the group's measure. */
type ChartPoint = Readonly<{ key: string; label: string; value: number; text: string }>;

/** The ready values a chart block renders: one bar per group of the bound query's summary. */
export type ChartPayload = Readonly<{
  kind: "chart";
  categoryLabel: string;
  measureLabel: string;
  points: readonly ChartPoint[];
}>;

const refuse = (message: string, location: DefinitionRenderErrorLocation): never => {
  throw new DefinitionRenderError("INVALID_COMPOSITION", message, location);
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));

const parsePoint = (value: unknown, location: DefinitionRenderErrorLocation): ChartPoint => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["key", "label", "value", "text"]) ||
    typeof value.key !== "string" ||
    value.key.length === 0 ||
    typeof value.label !== "string" ||
    typeof value.value !== "number" ||
    !Number.isFinite(value.value) ||
    typeof value.text !== "string"
  )
    return refuse("A chart point is a closed key, label, finite value and text", location);
  return Object.freeze({
    key: value.key,
    label: value.label,
    value: value.value,
    text: value.text,
  });
};

/** The ready values a chart block accepts. */
const parseChartPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): ChartPayload => {
  if (
    !isRecord(value) ||
    value.kind !== "chart" ||
    !hasExactKeys(value, ["kind", "categoryLabel", "measureLabel", "points"]) ||
    typeof value.categoryLabel !== "string" ||
    typeof value.measureLabel !== "string" ||
    !Array.isArray(value.points)
  )
    return refuse("Projected chart values must be a closed chart payload", location);
  const points = value.points.map((point) => parsePoint(point, location));
  if (new Set(points.map((point) => point.key)).size !== points.length)
    return refuse("A chart reports each group once", location);
  return Object.freeze({
    kind: "chart",
    categoryLabel: value.categoryLabel,
    measureLabel: value.measureLabel,
    points: Object.freeze(points),
  });
};

const CHART_PAYLOAD_PARSER = createPayloadParser({
  data: (value, location) => parseDisplayData(value, parseChartPayload, location),
  events: (value, location) => parseDisplayEventHandlers(value, location),
});

/**
 * Browser-safe bar chart over a grouped query summary. The chart is one accessible table: each
 * row names its group and measure as text, and the bar beside it is decoration only. It never
 * fetches or executes a Query.
 */
export function ChartDisplay(props: DisplayRenderProps<ChartPayload>): ReactElement {
  const { placementId, availability } = props;
  const { title, accessibleName, values, state, emptyMessage, refusedMessage, errorMessage, events } =
    resolveDisplayContext<ChartPayload>(
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
        </section>
      )}
    </DisplayStateContainer>
  );
}

export const CHART_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] = Object.freeze([
  Object.freeze({
    releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.CHART_BLOCK_RELEASE,
    parsePayload: CHART_PAYLOAD_PARSER,
  }),
]);
