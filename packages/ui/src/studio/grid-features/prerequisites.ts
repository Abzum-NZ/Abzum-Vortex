import {
  recordsTableColumnFiltersFeature,
  recordsTableInlineEditFeature,
  recordsTablePivotFeature,
  recordsTableTotalsFeature,
  type RecordsTableFeatureKey,
  type RecordsTableQueryFacts,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";

type Group = Extract<SourceBlockPropertyValueContract, { kind: "group" }>;
const fieldValue = (field: string): SourceBlockPropertyValueContract => ({
  kind: "field_reference",
  field,
});
const fieldsValue = (fields: readonly string[]): SourceBlockPropertyValueContract => ({
  kind: "list",
  items: fields.map(fieldValue),
});

/** One feature's Fix writes every available prerequisite as one ordinary features edit. */
export const studioGridPrerequisites = (
  key: RecordsTableFeatureKey,
  whole: Group,
  facts: RecordsTableQueryFacts,
): Group | undefined => {
  const current = whole.properties[key];
  if (current?.kind !== "group") return undefined;
  const properties = { ...whole.properties };
  const own = { ...current.properties };
  if (key === recordsTablePivotFeature.key) {
    const dimensions = facts.fields.filter(
      (field) => field.filterable && ["choice", "link", "date", "date_time"].includes(field.type),
    );
    if (dimensions.length < 2) return undefined;
    const rowChoice = own.row_field;
    const columnChoice = own.column_field;
    const row =
      rowChoice?.kind === "field_reference" &&
      dimensions.some((field) => field.field === rowChoice.field)
        ? rowChoice.field
        : dimensions[0]!.field;
    const column =
      columnChoice?.kind === "field_reference" &&
      columnChoice.field !== row &&
      dimensions.some((field) => field.field === columnChoice.field)
        ? columnChoice.field
        : dimensions.find((field) => field.field !== row)!.field;
    own.row_field = fieldValue(row);
    own.column_field = fieldValue(column);
    for (const [part, field] of [
      ["row", row],
      ["column", column],
    ] as const)
      if (
        ["date", "date_time"].includes(facts.fields.find((entry) => entry.field === field)!.type) &&
        own[`${part}_date_unit`] === undefined
      )
        own[`${part}_date_unit`] = { kind: "choice", value: "month" };
    own.measure_function ??= { kind: "choice", value: "count" };
    if (
      own.measure_function.kind === "choice" &&
      own.measure_function.value !== "count" &&
      own.measure_field === undefined
    ) {
      const measure = facts.fields.find((field) =>
        ["whole_number", "decimal_number", "money"].includes(field.type),
      );
      if (measure !== undefined) own.measure_field = fieldValue(measure.field);
    }
    own.row_page_size ??= { kind: "number", value: 40 };
    const filter = properties[recordsTableColumnFiltersFeature.key];
    const before = filter?.kind === "group" ? filter.properties.fields : undefined;
    const fields =
      before?.kind === "list"
        ? before.items.flatMap((item) => (item.kind === "field_reference" ? [item.field] : []))
        : [];
    properties[recordsTableColumnFiltersFeature.key] = {
      kind: "group",
      properties: {
        ...(filter?.kind === "group" ? filter.properties : {}),
        enabled: { kind: "boolean", value: true },
        fields: fieldsValue([...new Set([...fields, row, column])]),
      },
    };
  } else if (key === recordsTableTotalsFeature.key) {
    const field = facts.fields.find(
      (field) =>
        ["whole_number", "decimal_number", "money"].includes(field.type) &&
        facts.columnFieldIds.includes(field.field),
    );
    if (field === undefined) return undefined;
    own.measures = {
      kind: "list",
      items: [
        {
          kind: "group",
          properties: {
            field: fieldValue(field.field),
            operation: { kind: "choice", value: "sum" },
          },
        },
      ],
    };
  } else if (key === recordsTableInlineEditFeature.key) {
    const fields = facts.fields
      .filter((field) => field.editable && facts.columnFieldIds.includes(field.field))
      .map((field) => field.field);
    if (fields.length === 0) return undefined;
    own.fields = fieldsValue(fields);
  } else if (key === recordsTableColumnFiltersFeature.key) {
    const field = facts.fields.find((field) => field.filterable);
    if (field === undefined) return undefined;
    own.fields = fieldsValue([field.field]);
  } else return undefined;
  properties[key] = { ...current, properties: own };
  return { ...whole, properties };
};
