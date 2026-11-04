"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createUsePuck, useGetPuck, type ComponentConfig, type Field } from "@puckeditor/core";
import {
  componentSettingApplies,
  plainSettingValue,
  plainSourceSettingValue,
  typedSourceSettingValue,
  type BlockPropertySchemaContract,
  type PlatformBlockRelease,
} from "@vortex/platform/schema";
import { Button } from "../components/button";
import { StudioField } from "./studio-field";
import { studioGridFeaturesProperty } from "./studio-grid-features";
import { splitMoreSettings } from "./studio-more-settings";
import { StudioSettingControl } from "./studio-setting-controls";
import {
  conditionalRequiredMessage,
  settleStudioSetting,
  studioSettingProblems,
  type SettingValue,
  type StudioSettingChoices,
  type StudioSettingValues,
} from "./studio-setting-model";
import { studioTotalMeasureProperty } from "./grid-features/totals";
import { studioOwnsSetting } from "./contextual-palette";

/**
 * A block's settings are Puck fields: each declared setting is a custom field whose control is
 * Studio's shadcn setting control for its kind, shown by `Puck.Fields` in the inspector. A value
 * Puck holds is the setting's plain stored form; the field converts it to the typed value the
 * control edits, and hands the plain form back only while the setting is valid. Input that is not
 * valid yet stays in the control with its message at the field and never reaches Puck.
 */

/** What the setting controls need that a field's own value does not hold. */
export type StudioSettingFieldsValue = Readonly<{
  /** What reference settings can point at, for the selected block's data. */
  choices: StudioSettingChoices;
  disabled: boolean;
}>;

const StudioSettingFieldsContext = createContext<StudioSettingFieldsValue | null>(null);
export const StudioSettingFieldsProvider = StudioSettingFieldsContext.Provider;

const usePuckSelector = createUsePuck();

/**
 * The declared settings that are plain fields of the inspector. The others have a control of their
 * own: the Records table's features, the query bindings, row actions, the selection bindings and
 * the add-records switch; and the settings Studio owns.
 */
export const studioFieldSettings = (
  properties: readonly BlockPropertySchemaContract[],
): readonly BlockPropertySchemaContract[] => {
  const features = studioGridFeaturesProperty(properties);
  const addsFromList =
    properties.some((property) => property.key === "inline_create") &&
    properties.some((property) => property.key === "create_page");
  return properties.filter(
    (property) =>
      property !== features &&
      property.key !== "query_parameters" &&
      property.key !== "row_actions" &&
      property.key !== "open_with" &&
      property.key !== "record_from" &&
      !(addsFromList && (property.key === "inline_create" || property.key === "create_page")) &&
      !studioOwnsSetting(property.key),
  );
};

/** The typed settings a block's plain props hold; a prop that is not a valid value of its declaration is left out. */
export const studioTypedSettings = (
  props: Readonly<Record<string, unknown>>,
  properties: readonly BlockPropertySchemaContract[],
): StudioSettingValues => {
  const typed: Record<string, NonNullable<SettingValue>> = {};
  for (const property of properties) {
    const plain = props[property.key];
    if (plain === undefined) continue;
    const value = typedSourceSettingValue(plain, property, [property.key], []);
    if (value !== undefined) typed[property.key] = value;
  }
  return typed;
};

type SettingFieldRenderProps = Readonly<{
  value: unknown;
  onChange: (value: unknown) => void;
  readOnly?: boolean | undefined;
}>;

/** A field's note under its control: what auto-size and full screen offer, and the label that follows the field. */
function SettingNotes({
  property,
  properties,
  values,
  choices,
  disabled,
  onChange,
}: Readonly<{
  property: BlockPropertySchemaContract;
  properties: readonly BlockPropertySchemaContract[];
  values: StudioSettingValues;
  choices: StudioSettingChoices;
  disabled: boolean;
  onChange: (next: SettingValue) => void;
}>): ReactNode {
  const fieldProperty = properties.find(
    (candidate) => candidate.key === "field" && candidate.kind === "field_reference",
  );
  const fieldValue = fieldProperty === undefined ? undefined : values[fieldProperty.key];
  const fieldReference = fieldValue?.kind === "field_reference" ? fieldValue.field : undefined;
  const field =
    fieldReference === undefined
      ? undefined
      : choices.fields.find((candidate) => candidate.reference === fieldReference);
  if (property.key === "auto_size" && fieldProperty !== undefined) {
    const label = values.label;
    return (
      <p className="text-sm text-muted-foreground">
        {fieldReference !== undefined
          ? "Available"
          : `Not possible - ${(label?.kind === "text" ? label.value : "").trim() || "Column"} has no field to measure`}
      </p>
    );
  }
  if (property.key === "allow_full_screen")
    return <p className="text-sm text-muted-foreground">Available</p>;
  if (
    property.key === "label" &&
    property.kind === "text" &&
    !property.required &&
    property.defaultValue === undefined &&
    fieldProperty !== undefined &&
    field !== undefined
  ) {
    const label = values.label;
    return label?.kind === "text" ? (
      <Button
        type="button"
        variant="link"
        size="sm"
        disabled={disabled}
        className="h-auto px-0 whitespace-normal text-left"
        onClick={() => onChange(undefined)}
      >
        Use field label: {field.label}
      </Button>
    ) : (
      <p className="text-sm text-muted-foreground">Uses field label: {field.label}</p>
    );
  }
  return null;
}

/** The control of one declared setting as a Puck custom field. */
function StudioSettingField({
  property,
  properties,
  field,
}: Readonly<{
  property: BlockPropertySchemaContract;
  properties: readonly BlockPropertySchemaContract[];
  field: SettingFieldRenderProps;
}>) {
  const context = useContext(StudioSettingFieldsContext);
  const getPuck = useGetPuck();
  // Input that is not valid yet: the control shows it and the field says why; Puck never sees it.
  const [held, setHeld] = useState<Readonly<{ value: SettingValue; problem: string }> | null>(null);
  const plain = field.value;
  const plainKey = JSON.stringify(plain ?? null);
  // The draft changed under the held input (Undo, Redo, another block): it is dropped.
  useEffect(() => setHeld(null), [plainKey]);
  const typed = useMemo(
    () =>
      plain === undefined
        ? undefined
        : typedSourceSettingValue(plain, property, [property.key], []),
    // The plain value is compared by content: Puck hands over a fresh object for the same setting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plainKey, property],
  );
  if (context === null) return null;
  const { choices, disabled } = context;
  const props = getPuck().selectedItem?.props ?? {};
  const values = studioTypedSettings(props, properties);
  const change = (next: SettingValue) => {
    const settled = settleStudioSetting(properties, studioTypedSettings(getPuck().selectedItem?.props ?? {}, properties), property.key, next);
    const problems = studioSettingProblems(settled, properties, choices);
    if (problems.length > 0) {
      setHeld({ value: next, problem: problems.join(" ") });
      return;
    }
    setHeld(null);
    field.onChange(next === undefined ? undefined : plainSourceSettingValue(next));
  };
  const shown = held === null ? typed : held.value;
  const requiredBySibling =
    property.required &&
    property.showWhen !== undefined &&
    property.defaultValue === undefined &&
    typed === undefined;
  const error =
    held !== null
      ? held.problem
      : requiredBySibling
        ? conditionalRequiredMessage(property)
        : undefined;
  return (
    <div className="space-y-2" data-vortex-setting={property.key}>
      <StudioField
        label={property.label}
        optional={!property.required}
        hint={property.help}
        error={error}
      >
        {(control) => (
          <StudioSettingControl
            id={control.id}
            descriptionId={control["aria-describedby"]}
            property={studioTotalMeasureProperty(property, properties, values, choices.fields)}
            value={shown}
            onChange={change}
            choices={choices}
            disabled={disabled || field.readOnly === true}
          />
        )}
      </StudioField>
      <SettingNotes
        property={property}
        properties={properties}
        values={values}
        choices={choices}
        disabled={disabled}
        onChange={change}
      />
    </div>
  );
}

/** A declared setting as a Puck field. */
const settingField = (
  property: BlockPropertySchemaContract,
  properties: readonly BlockPropertySchemaContract[],
): Field =>
  ({
    type: "custom",
    label: property.label,
    render: (field: SettingFieldRenderProps) => (
      <StudioSettingField property={property} properties={properties} field={field} />
    ),
  }) as unknown as Field;

/** The fields of one placement: its shown settings first, every other prop hidden from the inspector. */
export const studioSettingFields = (
  release: PlatformBlockRelease,
  base: Readonly<Record<string, Field>>,
  props: Readonly<Record<string, unknown>> | undefined,
): Record<string, Field> => {
  const listed = studioFieldSettings(release.properties as readonly BlockPropertySchemaContract[]);
  const values = props === undefined ? undefined : studioTypedSettings(props, release.properties as never);
  const fields: Record<string, Field> = {};
  for (const property of listed) {
    if (values !== undefined && !componentSettingApplies(property, values)) continue;
    fields[property.key] = settingField(property, release.properties as never);
  }
  for (const [key, field] of Object.entries(base))
    if (fields[key] === undefined) fields[key] = { ...field, visible: false } as Field;
  return fields;
};

/**
 * Lays the settings out: the ones in use first, and the optional ones nobody has set in a closed
 * "More settings" section, decided once for the selected block so a field does not jump while it is
 * typed into.
 */
function StudioSettingFieldList({
  release,
  fields,
}: Readonly<{ release: PlatformBlockRelease; fields: Partial<Record<string, ReactNode>> }>) {
  const selectedId = usePuckSelector((state) => state.selectedItem?.props.id as string | undefined);
  const getPuck = useGetPuck();
  const decided = useRef<{ id: string | undefined; keys: ReadonlySet<string> } | null>(null);
  if (decided.current === null || decided.current.id !== selectedId) {
    const props = getPuck().selectedItem?.props ?? {};
    decided.current = {
      id: selectedId,
      keys: new Set(
        studioFieldSettings(release.properties as never)
          .filter((property) => {
            const value = props[property.key];
            return (
              !property.required &&
              (value === undefined ||
                (property.defaultValue !== undefined &&
                  JSON.stringify(value) ===
                    JSON.stringify(plainSettingValue(property.defaultValue))))
            );
          })
          .map((property) => property.key),
      ),
    };
  }
  const controls = Object.entries(fields)
    .filter(([key, node]) => node !== undefined && release.properties.some((p) => p.key === key))
    .map(([key, node]) => ({ key, node: <div key={key}>{node}</div> }));
  return <div className="space-y-4">{splitMoreSettings(controls, decided.current.keys)}</div>;
}

/**
 * A canvas component with its settings declared as Puck fields: `fields` for the block as stored,
 * `resolveFields` for the settings that apply to the values it holds, and `renderFields` laying
 * them out.
 */
export const withSettingFields = (
  component: ComponentConfig<Record<string, unknown>>,
  release: PlatformBlockRelease | undefined,
  resolveBase: ((data: { props: Record<string, unknown> }, params: unknown) => Record<string, Field>) | undefined,
): Partial<ComponentConfig<Record<string, unknown>>> => {
  if (release === undefined) return { fields: (component.fields ?? {}) as Record<string, Field> };
  const base = (component.fields ?? {}) as Record<string, Field>;
  return {
    fields: studioSettingFields(release, base, undefined),
    resolveFields: (data: { props: Record<string, unknown> }, params: unknown) =>
      studioSettingFields(
        release,
        resolveBase === undefined ? base : resolveBase(data, params),
        data.props,
      ),
    renderFields: ({ fields }: { fields: Partial<Record<string, ReactNode>> }) => (
      <StudioSettingFieldList release={release} fields={fields} />
    ),
  } as never;
};

