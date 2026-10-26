import "server-only";

import type { z } from "zod";
import type { JsonValue } from "../../catalogue/common";
import { describeFailure } from "../../catalogue/runtime-primitives";
import type { BlockPropertyValueContract } from "../../definition/application-composition/block-property-values";
import { queryTotalLabel } from "../../definition/module-query-edit";
import { exactDecimalTextSchema, moneyValueSchema } from "../../records/module-field-values";
import {
  protectedQuerySummaryCommandSchema,
  type ProtectedQuerySummaryAggregateResult,
  type ProtectedQuerySummaryCompleted,
} from "../../queries/protected-query-contracts";
import {
  collectRecordLinkValues,
  recordLinkPlainText,
  type ProjectedRecordLinks,
} from "../component-data-projection";
import type { DisplayScalarCell } from "../display-payload-parts";
import type {
  chartPayloadSchema,
  chartPointSchema,
  summaryPayloadSchema,
} from "../display-payload-summary";
import {
  logPlacementFailure,
  placementSettingsOf,
  queryRecordType,
  type PlacementField,
  type PlacementModule,
  type PlacementQuery,
  type PlacementReadEntry,
} from "./shared";
import type { PlacementReadInput } from "./types";

/** One summary cell: the closed display values a summary shows, or unavailable when refused. */
type SummaryCell = Extract<
  DisplayScalarCell,
  Readonly<{ kind: "number" | "text" | "boolean" | "date" | "empty" | "unavailable" }>
>;

/** One bar of a chart: a stable group key, its readable label, and the group's measure. */
type ChartPoint = z.input<typeof chartPointSchema>;

const summaryAggregateLabel = (alias: string): string =>
  alias
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[a-z]/, (letter) => letter.toUpperCase());

/** Projects one already-authorised Query aggregate into the closed summary cell contract. */
export const summaryAggregateCellValue = (
  aggregate: PlacementQuery["aggregates"][number],
  field: PlacementField | undefined,
  result: ProtectedQuerySummaryAggregateResult,
): SummaryCell | undefined => {
  if (result.outcome === "refused") return { kind: "unavailable" };
  if (aggregate.operation === "count" || aggregate.operation === "distinct_count")
    return typeof result.value === "number" && Number.isSafeInteger(result.value)
      ? { kind: "number", value: result.value }
      : undefined;
  if (result.value === null || result.valueCount === 0) return { kind: "empty" };
  if (field === undefined) return undefined;

  const fieldType =
    field.type === "calculation"
      ? ["add", "subtract", "multiply", "divide", "round"].includes(field.settings.expression.op) &&
        field.settings.evaluation === "stored" &&
        (field.settings.resultType === "whole_number" ||
          field.settings.resultType === "decimal_number")
        ? field.settings.resultType
        : undefined
      : field.type;
  if (fieldType === undefined) return undefined;

  switch (fieldType) {
    case "text":
      return (aggregate.operation === "minimum" || aggregate.operation === "maximum") &&
        typeof result.value === "string"
        ? { kind: "text", text: result.value }
        : undefined;
    case "yes_no":
      return (aggregate.operation === "minimum" || aggregate.operation === "maximum") &&
        typeof result.value === "boolean"
        ? { kind: "boolean", value: result.value }
        : undefined;
    case "whole_number": {
      if (typeof result.value === "number" && Number.isSafeInteger(result.value))
        return { kind: "number", value: result.value };
      const exactValue = exactDecimalTextSchema.safeParse(result.value);
      return exactValue.success ? { kind: "text", text: exactValue.data } : undefined;
    }
    case "decimal_number": {
      const exactValue = exactDecimalTextSchema.safeParse(result.value);
      return exactValue.success ? { kind: "text", text: exactValue.data } : undefined;
    }
    case "money": {
      const moneyValue = moneyValueSchema.safeParse(result.value);
      return moneyValue.success
        ? { kind: "text", text: `${moneyValue.data.currency} ${moneyValue.data.amount}` }
        : undefined;
    }
    case "date":
    case "date_time":
      return typeof result.value === "string" ? { kind: "date", iso: result.value } : undefined;
    default:
      return undefined;
  }
};

const settingText = (value: BlockPropertyValueContract | undefined): string | undefined =>
  value?.kind === "text" && value.value.trim().length > 0 ? value.value.trim() : undefined;

/**
 * A group value in its readable form: a choice's installed label, a link's viewer-safe target
 * label (or its restricted state), or the plain text of a scalar. Records without a value form
 * their own group, named after the field ("No team").
 */
const groupLabel = (
  field: PlacementField,
  value: JsonValue | undefined,
  recordLinks: ProjectedRecordLinks | undefined,
): string | undefined => {
  if (value === null || value === undefined) return `No ${field.label.toLowerCase()}`;
  // A link the viewer may not read arrives as the summary's "not_available" group, as in a pivot.
  if (field.type === "link")
    return value === "not_available"
      ? "Not available"
      : (recordLinkPlainText(value, recordLinks) ?? "Not available");
  if (field.type === "choice")
    return field.settings.options.find((candidate) => candidate.value === value)?.label;
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : undefined;
};

/**
 * Projects the groups of one completed summary into chart points. The chart reads the one field the
 * bound query groups by and one declared aggregate; any other shape is refused with its code
 * instead of being drawn from a guess.
 */
const projectChart = (input: {
  settings: Readonly<Record<string, BlockPropertyValueContract>>;
  query: PlacementQuery;
  fields: ReadonlyMap<string, PlacementField>;
  summary: ProtectedQuerySummaryCompleted;
  recordLinks?: ProjectedRecordLinks;
}):
  | Readonly<{ ok: true; chart: z.input<typeof chartPayloadSchema> }>
  | Readonly<{
      ok: false;
      code: "chart_settings_invalid" | "chart_group_invalid" | "chart_measure_invalid";
      cause: string;
    }> => {
  const { settings, query, fields, summary, recordLinks } = input;
  const category = settings.category_field;
  const categoryFieldId =
    category?.kind === "field_reference" ? String(category.fieldId) : undefined;
  const measure = settings.measure?.kind === "total_reference" ? settings.measure.value : undefined;
  if (categoryFieldId === undefined || measure === undefined)
    return {
      ok: false,
      code: "chart_settings_invalid",
      cause: "Category field or Measure has no valid reference",
    };

  const categoryId = categoryFieldId.toLowerCase();
  const categoryField = fields.get(categoryId);
  if (
    categoryField === undefined ||
    query.groupByFieldIds.length !== 1 ||
    String(query.groupByFieldIds[0]).toLowerCase() !== categoryId
  )
    return {
      ok: false,
      code: "chart_group_invalid",
      cause: "Category must be the query's one grouping field",
    };

  const aggregate = query.aggregates.find((candidate) => candidate.alias === measure);
  if (aggregate === undefined)
    return {
      ok: false,
      code: "chart_measure_invalid",
      cause: `Query ${query.key} has no total named ${measure}`,
    };
  const measureField =
    aggregate.fieldId === undefined ? undefined : fields.get(aggregate.fieldId.toLowerCase());
  const measureLabel =
    settingText(settings.measure_label) ??
    queryTotalLabel(aggregate.operation, measureField?.label);

  const points: ChartPoint[] = [];
  for (const group of summary.groups) {
    const groupValues: Readonly<Record<string, JsonValue>> = group.groupValues;
    const label = groupLabel(categoryField, groupValues[categoryId], recordLinks);
    const result = group.aggregates[aggregate.alias];
    if (label === undefined || result === undefined)
      return {
        ok: false,
        code: "chart_group_invalid",
        cause: "A summary group is missing its category or chosen total",
      };
    const cell = summaryAggregateCellValue(aggregate, measureField, result);
    const money =
      measureField?.type === "money" && result.outcome !== "refused"
        ? moneyValueSchema.safeParse(result.value)
        : undefined;
    const numeric = money?.success
      ? { value: Number(money.data.amount), text: `${money.data.currency} ${money.data.amount}` }
      : cell?.kind === "number"
        ? { value: cell.value, text: String(cell.value) }
        : cell?.kind === "text" && exactDecimalTextSchema.safeParse(cell.text).success
          ? { value: Number(cell.text), text: cell.text }
          : undefined;
    if (numeric === undefined || !Number.isFinite(numeric.value))
      return {
        ok: false,
        code: "chart_measure_invalid",
        cause: `Total ${aggregate.alias} (${aggregate.operation}) did not produce a numeric chart value`,
      };
    points.push({ key: group.groupKey, label, ...numeric });
  }
  return {
    ok: true,
    chart: {
      kind: "chart",
      categoryLabel: categoryField.label,
      measureLabel,
      points,
      // The summary pages its groups; the chart draws the first page and says more exist.
      moreGroups: summary.nextGroupKey !== null && summary.nextGroupKey !== undefined,
    },
  };
};

/** A summary-values or chart placement: one summary of its bound query for its resolved inputs. */
export const readSummaryOrChart = async (
  read: PlacementReadInput,
  placement: PlacementReadEntry,
  bound: Readonly<{ module: PlacementModule; query: PlacementQuery }>,
  inputValues: Readonly<Record<string, JsonValue>>,
  chart: boolean,
): Promise<void> => {
  const { placementId } = placement;
  const { address, data } = read;
  const command = protectedQuerySummaryCommandSchema.safeParse({
    mode: "published",
    moduleRootId: bound.module.rootId,
    queryId: bound.query.queryId,
    inputValues,
  });
  if (!command.success) {
    logPlacementFailure(address, placementId, "summary_query_invalid");
    data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }

  let summaryResult: Awaited<ReturnType<typeof read.services.queries.summarise>>;
  try {
    summaryResult = await read.services.queries.summarise(
      read.session,
      read.selection,
      command.data,
    );
  } catch (error) {
    logPlacementFailure(address, placementId, "summary_query_threw", describeFailure(error));
    data[placementId] = { status: "error" };
    return;
  }
  if (summaryResult.kind === "temporarily_unavailable") {
    logPlacementFailure(address, placementId, "summary_query_unavailable");
    data[placementId] = { status: "error" };
    return;
  }
  if (summaryResult.kind !== "available" || summaryResult.value.outcome !== "completed") {
    const refusal =
      summaryResult.kind === "available" && summaryResult.value.outcome === "refused"
        ? summaryResult.value
        : undefined;
    logPlacementFailure(
      address,
      placementId,
      refusal?.reasonCode === "dataset_limit_exceeded"
        ? "summary_dataset_limit_exceeded"
        : refusal?.reasonCode === "value_out_of_range"
          ? "summary_value_out_of_range"
          : "summary_query_refused",
      refusal?.reasonCode ?? summaryResult.kind,
    );
    data[placementId] = {
      status: "refused",
      reason:
        refusal?.reasonCode === "dataset_limit_exceeded" ||
        refusal?.reasonCode === "value_out_of_range"
          ? refusal.reasonCode
          : "not_permitted",
    };
    return;
  }

  const recordType = queryRecordType(read.context, bound.query);
  const fields = new Map(
    (recordType?.fields ?? []).map(
      (field) => [String(field.fieldId).toLowerCase(), field] as const,
    ),
  );
  if (chart) {
    // One labelled read per chart for the linked groups, never one per bar.
    const groupLinks = collectRecordLinkValues(
      summaryResult.value.groups.flatMap((group) => Object.values<JsonValue>(group.groupValues)),
    );
    const groupLabels =
      groupLinks.length === 0 ? undefined : await read.services.resolveRecordLinks(groupLinks);
    const projection = projectChart({
      settings: placementSettingsOf(placement),
      query: bound.query,
      fields,
      summary: summaryResult.value,
      ...(groupLabels === undefined ? {} : { recordLinks: groupLabels }),
    });
    if (!projection.ok) {
      logPlacementFailure(address, placementId, projection.code, projection.cause);
      data[placementId] = { status: "error" };
      return;
    }
    data[placementId] =
      projection.chart.points.length === 0
        ? { status: "empty" }
        : { status: "ready", values: projection.chart };
    return;
  }

  const declaredAggregates = bound.query.aggregates;
  const projectedAggregates = summaryResult.value.aggregates;
  const aliases = declaredAggregates.map((aggregate) => aggregate.alias);
  if (
    Object.keys(projectedAggregates).length !== aliases.length ||
    aliases.some((alias) => !Object.hasOwn(projectedAggregates, alias))
  ) {
    logPlacementFailure(address, placementId, "summary_result_invalid");
    data[placementId] = { status: "error" };
    return;
  }
  const values: Array<z.input<typeof summaryPayloadSchema>["values"][number]> = [];
  for (const aggregate of declaredAggregates) {
    const field =
      aggregate.fieldId === undefined ? undefined : fields.get(aggregate.fieldId.toLowerCase());
    const value = summaryAggregateCellValue(
      aggregate,
      field,
      projectedAggregates[aggregate.alias]!,
    );
    if (value === undefined) {
      logPlacementFailure(address, placementId, "summary_result_invalid");
      data[placementId] = { status: "error" };
      return;
    }
    values.push({
      key: aggregate.alias,
      label: summaryAggregateLabel(aggregate.alias) || aggregate.alias,
      value,
    });
  }
  data[placementId] =
    values.length === 0
      ? { status: "empty" }
      : {
          status: "ready",
          values: { kind: "summary_values", values } satisfies z.input<typeof summaryPayloadSchema>,
        };
};
