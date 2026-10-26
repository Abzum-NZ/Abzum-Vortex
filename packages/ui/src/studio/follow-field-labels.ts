import type {
  BlockPropertySchemaContract,
  SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import type { StudioQueryField } from "./contextual-palette";
import type { StudioSettingValues } from "./studio-setting-controls";
type SettingValue = SourceBlockPropertyValueContract | undefined;

/** Remove copied field labels in one update, including every column affected by a query change. */
export const followFieldLabels = (
  properties: readonly BlockPropertySchemaContract[],
  values: StudioSettingValues,
  previous: StudioSettingValues,
  fields: readonly StudioQueryField[],
  previousFields: readonly StudioQueryField[],
): StudioSettingValues => {
  let result = values;
  const write = (key: string, value: SettingValue) => {
    const next = { ...result };
    if (value === undefined) delete next[key];
    else next[key] = value;
    result = next;
  };
  const fieldProperty = properties.find(
    (property) => property.key === "field" && property.kind === "field_reference",
  );
  const labelProperty = properties.find(
    (property) =>
      property.key === "label" &&
      property.kind === "text" &&
      !property.required &&
      property.defaultValue === undefined,
  );
  const oldField = fieldProperty === undefined ? undefined : previous.field;
  const newField = fieldProperty === undefined ? undefined : values.field;
  const oldLabel =
    oldField?.kind === "field_reference"
      ? previousFields.find((field) => field.reference === oldField.field)?.label
      : undefined;
  const newLabel =
    newField?.kind === "field_reference"
      ? fields.find((field) => field.reference === newField.field)?.label
      : undefined;
  const label = labelProperty === undefined ? undefined : values.label;
  if (
    label?.kind === "text" &&
    previous.label?.kind === "text" &&
    label.value === previous.label.value &&
    label.value === oldLabel &&
    oldField?.kind === "field_reference" &&
    (newField?.kind !== "field_reference" ||
      oldField.field !== newField.field ||
      oldLabel !== newLabel)
  )
    write("label", undefined);

  const visit = (
    property: BlockPropertySchemaContract,
    value: SettingValue,
    before: SettingValue,
  ): SettingValue => {
    if (property.kind === "group" && value?.kind === "group") {
      const children = followFieldLabels(
        property.properties,
        value.properties,
        before?.kind === "group" ? before.properties : {},
        fields,
        previousFields,
      );
      return children === value.properties ? value : { ...value, properties: { ...children } };
    }
    if (property.kind === "list" && value?.kind === "list") {
      const items = value.items.map((item, index) =>
        visit(property.item, item, before?.kind === "list" ? before.items[index] : undefined)!,
      );
      return items.every((item, index) => item === value.items[index])
        ? value
        : { ...value, items };
    }
    return value;
  };
  for (const property of properties) {
    const value = visit(property, values[property.key], previous[property.key]);
    if (value !== values[property.key]) write(property.key, value);
  }
  return result;
};
