import {
  recordsTableAggregateSupportsType,
  type BlockPropertySchemaContract,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import type { StudioQueryField } from "../contextual-palette";

/** A measure's operation narrows its field picker; the publication check judges the same types. */
export const studioTotalMeasureProperty = (
  property: BlockPropertySchemaContract,
  siblings: readonly BlockPropertySchemaContract[],
  values: Readonly<Record<string, SourceBlockPropertyValueContract>>,
  fields: readonly StudioQueryField[],
): BlockPropertySchemaContract => {
  if (
    property.kind !== "field_reference" ||
    property.key !== "field" ||
    !siblings.some(
      (sibling) =>
        sibling.key === "operation" &&
        sibling.kind === "choice" &&
        sibling.options.some((option) => option.key === "distinct_count"),
    )
  )
    return property;
  const operation = values.operation;
  if (operation?.kind !== "choice") return property;
  return {
    ...property,
    fieldTypes: fields
      .filter(
        (field) =>
          recordsTableAggregateSupportsType(operation.value, field.type) &&
          (operation.value !== "distinct_count" || field.filterable),
      )
      .map((field) => field.type) as NonNullable<typeof property.fieldTypes>,
  };
};
