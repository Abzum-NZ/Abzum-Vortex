import { z } from "zod";
import { builderKeySchema, recordIdSchema, revisionSchema } from "../catalogue/identifiers";
import {
  displayScalarCellSchema,
  displayTextSchema,
  refineUniqueKeys,
} from "./display-payload-parts";

/** One summary aggregate: its stable key, readable label and value, which may be unavailable. */
export const displaySummaryMetricSchema = z
  .object({ key: builderKeySchema, label: displayTextSchema, value: displayScalarCellSchema })
  .strict()
  .readonly();
export type DisplaySummaryMetric = z.output<typeof displaySummaryMetricSchema>;

/** Summary aggregates, each key once. */
export const displaySummaryMetricsSchema = z
  .array(displaySummaryMetricSchema)
  .readonly()
  .superRefine((metrics, context) =>
    refineUniqueKeys(
      metrics,
      (metric) => metric.key,
      context,
      "Each summary value key appears once",
    ),
  );

/** The ready values a summary-values block renders. */
export const summaryPayloadSchema = z
  .object({ kind: z.literal("summary_values"), values: displaySummaryMetricsSchema })
  .strict()
  .readonly();
export type SummaryPayload = z.output<typeof summaryPayloadSchema>;

/** One bar: a stable group key, its readable label, and the group's measure as number and text. */
export const chartPointSchema = z
  .object({ key: z.string().min(1), label: z.string(), value: z.number(), text: z.string() })
  .strict()
  .readonly();

/** The ready values a chart block renders: one bar per group of the bound query's summary. */
export const chartPayloadSchema = z
  .object({
    kind: z.literal("chart"),
    categoryLabel: z.string(),
    measureLabel: z.string(),
    points: z
      .array(chartPointSchema)
      .readonly()
      .superRefine((points, context) =>
        refineUniqueKeys(points, (point) => point.key, context, "A chart reports each group once"),
      ),
    moreGroups: z.boolean(),
  })
  .strict()
  .readonly();
export type ChartPayload = z.output<typeof chartPayloadSchema>;

export const queryNoticeSeverities = ["info", "success", "warning", "critical"] as const;
export type QueryNoticeSeverity = (typeof queryNoticeSeverities)[number];

const noticeTextSchema = z.string().max(1_000_000);

/** One notice a query row carries: its message and severity, with an optional title and link. */
export const queryNoticeItemSchema = z
  .object({
    recordId: recordIdSchema,
    revision: revisionSchema,
    message: noticeTextSchema,
    severity: z.enum(queryNoticeSeverities),
    title: noticeTextSchema.exactOptional(),
    link: z
      .object({ label: noticeTextSchema, href: noticeTextSchema })
      .strict()
      .readonly()
      .exactOptional(),
  })
  .strict()
  .readonly();
export type QueryNoticeItem = z.output<typeof queryNoticeItemSchema>;

/** The ready values a query notice block renders: one bounded page of notices. */
export const queryNoticePayloadSchema = z
  .object({
    kind: z.literal("query_notice"),
    items: z
      .array(queryNoticeItemSchema)
      .max(200)
      .readonly()
      .superRefine((items, context) =>
        refineUniqueKeys(
          items,
          (item) => item.recordId.toLowerCase(),
          context,
          "Each notice record appears once",
        ),
      ),
    truncated: z.boolean(),
  })
  .strict()
  .readonly();
export type QueryNoticePayload = z.output<typeof queryNoticePayloadSchema>;
