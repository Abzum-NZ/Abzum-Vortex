import type { ProtectedQuerySummaryCompleted } from "@vortex/platform/server";
import {
  exactDecimalTextSchema,
  type BlockPropertyValueContract,
  type JsonValue,
} from "@vortex/platform/schema";
import type { ChartPayload } from "@vortex/ui";
import { summaryAggregateCellValue } from "./query-helpers";
import type { ModuleField, ModuleRelease } from "./types";

type ModuleQuery = ModuleRelease["content"]["queries"][number];

/** Why a chart placement cannot be projected; each is a stable code written to the placement log. */
export type ChartProjectionFailure =
  | "chart_settings_invalid"
  | "chart_group_invalid"
  | "chart_measure_invalid";

type ChartSettings = Readonly<{
  categoryField: string;
  measure: string;
  measureLabel: string;
}>;

const settingText = (value: BlockPropertyValueContract | undefined): string | undefined =>
  value?.kind === "text" && value.value.trim().length > 0 ? value.value.trim() : undefined;

const settingField = (value: BlockPropertyValueContract | undefined): string | undefined =>
  value?.kind === "field_reference" ? String(value.fieldId) : undefined;

const readChartSettings = (
  settings: Readonly<Record<string, BlockPropertyValueContract>>,
): ChartSettings | undefined => {
  const categoryField = settingField(settings.category_field);
  const measure = settingText(settings.measure);
  const measureLabel = settingText(settings.measure_label);
  return categoryField === undefined || measure === undefined || measureLabel === undefined
    ? undefined
    : { categoryField, measure, measureLabel };
};

const groupValueOf = (
  values: Readonly<Record<string, JsonValue>>,
  fieldId: string,
): JsonValue | undefined => values[fieldId];

/** A group value in its readable form: a choice's installed label, or the plain text of a scalar. */
const groupLabel = (field: ModuleField, value: JsonValue | undefined): string | undefined => {
  if (field.type === "choice") {
    const option = field.settings.options.find((candidate) => candidate.value === value);
    return option?.label;
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : undefined;
};

/**
 * Projects the groups of one completed summary into chart points. The chart reads the one field the
 * bound query groups by and one declared aggregate; any other shape is refused with its code
 * instead of being drawn from a guess.
 */
export const projectChartPlacement = (input: {
  settings: Readonly<Record<string, BlockPropertyValueContract>>;
  query: ModuleQuery;
  fields: ReadonlyMap<string, ModuleField>;
  summary: ProtectedQuerySummaryCompleted;
}): Readonly<{ ok: true; chart: ChartPayload }> | Readonly<{ ok: false; code: ChartProjectionFailure }> => {
  const { settings, query, fields, summary } = input;
  const chartSettings = readChartSettings(settings);
  if (chartSettings === undefined) return { ok: false, code: "chart_settings_invalid" };

  const categoryId = chartSettings.categoryField.toLowerCase();
  const categoryField = fields.get(categoryId);
  if (
    categoryField === undefined ||
    query.groupByFieldIds.length !== 1 ||
    String(query.groupByFieldIds[0]).toLowerCase() !== categoryId
  )
    return { ok: false, code: "chart_group_invalid" };

  const aggregate = query.aggregates.find((candidate) => candidate.alias === chartSettings.measure);
  if (aggregate === undefined) return { ok: false, code: "chart_measure_invalid" };
  const measureField =
    aggregate.fieldId === undefined ? undefined : fields.get(aggregate.fieldId.toLowerCase());

  const points: Array<ChartPayload["points"][number]> = [];
  for (const group of summary.groups) {
    const label = groupLabel(categoryField, groupValueOf(group.groupValues, categoryId));
    const result = group.aggregates[aggregate.alias];
    if (label === undefined || result === undefined) return { ok: false, code: "chart_group_invalid" };
    const cell = summaryAggregateCellValue(aggregate, measureField, result);
    const numeric =
      cell?.kind === "number"
        ? { value: cell.value, text: String(cell.value) }
        : cell?.kind === "text" && exactDecimalTextSchema.safeParse(cell.text).success
          ? { value: Number(cell.text), text: cell.text }
          : undefined;
    if (numeric === undefined) return { ok: false, code: "chart_measure_invalid" };
    points.push({ key: group.groupKey, label, ...numeric });
  }

  return {
    ok: true,
    chart: {
      kind: "chart",
      categoryLabel: categoryField.label,
      measureLabel: chartSettings.measureLabel,
      points,
    },
  };
};
