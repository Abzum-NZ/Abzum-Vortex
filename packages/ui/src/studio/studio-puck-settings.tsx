"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createUsePuck,
  Puck,
  useGetPuck,
  type ComponentConfig,
  type Field,
} from "@puckeditor/core";
import {
  canonicalJson,
  componentSettingApplies,
  plainSettingValue,
  plainSourceSettingValue,
  typedSourceSettingValue,
  type BlockPropertySchemaContract,
  type PlatformBlockRelease,
} from "@vortex/platform/schema";
import { FieldGroup } from "../components/field";
import { StudioField } from "./studio-field";
import { studioGridFeaturesProperty } from "./studio-grid-features";
import { splitMoreSettings } from "./studio-more-settings";
import { StudioSettingControl, StudioSettingNote } from "./studio-setting-controls";
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

/**
 * Studio's own `vortex` prop (placement, screen sizes and orders) is declared as an object with no
 * fields, so Puck's data walk takes its keys (`slot_orders` names slots) for nothing but data and
 * never reads a stored screen order as the content of the slot it is named after.
 */
export const studioVortexField = { type: "object", objectFields: {}, visible: false } as Field;

/** What the setting controls need that a field's own value does not hold. */
export type StudioSettingFieldsValue = Readonly<{
  /** What reference settings can point at, for the selected block's data. */
  choices: StudioSettingChoices;
  disabled: boolean;
}>;

/** The settings the person has edited since the selected block was chosen (the label note reads them). */
type StudioSettingFieldsContextValue = StudioSettingFieldsValue &
  Readonly<{ scope: string; touched: ReadonlySet<string>; touch: (key: string) => void }>;

const StudioSettingFieldsContext = createContext<StudioSettingFieldsContextValue | null>(null);

const noKeys: ReadonlySet<string> = new Set();

const usePuckSelector = createUsePuck();

/**
 * The declared settings that are plain fields of the inspector. The others have a control of their
 * own: the Records table's features, the query bindings, row actions, the selection bindings and
 * the add-records switch; and the settings Studio owns.
 */
const studioFieldSettings = (
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
const studioTypedSettings = (
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
  // The selected block's values, subscribed to: the label note and the total measure depend on the
  // sibling settings.
  const props = usePuckSelector((state) => state.selectedItem?.props) ?? noProps;
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
    [plainKey, property],
  );
  if (context === null) return null;
  const { choices, disabled, scope, touched, touch } = context;
  const values = studioTypedSettings(props, properties);
  const change = (next: SettingValue) => {
    touch(property.key);
    const now = studioTypedSettings(getPuck().selectedItem?.props ?? {}, properties);
    const settled = settleStudioSetting(properties, now, property.key, next);
    // Only what this change introduced holds the input: a problem the block already has, or a
    // sibling that now needs a value, is not this field's.
    const before = new Set(studioSettingProblems(now, properties, choices));
    const problems = studioSettingProblems(settled, properties, choices).filter(
      (problem) => !before.has(problem),
    );
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
            invalid={control["aria-invalid"] === true}
            property={studioTotalMeasureProperty(property, properties, values, choices.fields)}
            value={shown}
            onChange={change}
            choices={choices}
            disabled={disabled || field.readOnly === true}
          />
        )}
      </StudioField>
      <StudioSettingNote
        property={property}
        properties={properties}
        values={values}
        choices={choices}
        disabled={disabled}
        scope={scope}
        touched={touched}
        onUseFieldLabel={() => change(undefined)}
      />
    </div>
  );
}

const noProps: Readonly<Record<string, unknown>> = {};

/** A declared setting as a Puck field. */
const settingField = (
  release: PlatformBlockRelease,
  property: BlockPropertySchemaContract,
  properties: readonly BlockPropertySchemaContract[],
): Field =>
  ({
    type: "custom",
    label: property.label,
    // Puck keeps a custom field's render per key: a release change in place must not keep the first
    // release's declaration.
    key: `${release.blockId}@${release.releaseVersion}:${property.key}`,
    render: (field: SettingFieldRenderProps) => (
      <StudioSettingField property={property} properties={properties} field={field} />
    ),
  }) as unknown as Field;

/** The fields of one placement: its shown settings first, every other prop hidden from the inspector. */
const studioSettingFields = (
  release: PlatformBlockRelease,
  base: Readonly<Record<string, Field>>,
  props: Readonly<Record<string, unknown>> | undefined,
): Record<string, Field> => {
  const listed = studioFieldSettings(release.properties as readonly BlockPropertySchemaContract[]);
  const values =
    props === undefined ? undefined : studioTypedSettings(props, release.properties as never);
  const fields: Record<string, Field> = {};
  for (const property of listed) {
    if (values !== undefined && !componentSettingApplies(property, values)) continue;
    fields[property.key] = settingField(release, property, release.properties as never);
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
  releaseOf,
  fields,
}: Readonly<{
  releaseOf: StudioSettingRelease;
  fields: Partial<Record<string, ReactNode>>;
}>) {
  const props = usePuckSelector((state) => state.selectedItem?.props) ?? noProps;
  const selectedId = props.id as string | undefined;
  const decided = useRef<{ id: string | undefined; keys: ReadonlySet<string> } | null>(null);
  const release = releaseOf(props);
  if (release === undefined) return null;
  if (decided.current === null || decided.current.id !== selectedId) {
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
                  canonicalJson(value) === canonicalJson(plainSettingValue(property.defaultValue))))
            );
          })
          .map((property) => property.key),
      ),
    };
  }
  const controls = Object.entries(fields)
    .filter(([key, node]) => node !== undefined && release.properties.some((p) => p.key === key))
    .map(([key, node]) => ({ key, node: <div key={key}>{node}</div> }));
  return <FieldGroup>{splitMoreSettings(controls, decided.current.keys)}</FieldGroup>;
}

/** The release a placed block's props name, when the catalogue holds it. */
export type StudioSettingRelease = (
  props: Readonly<Record<string, unknown>>,
) => PlatformBlockRelease | undefined;

const hidden = (fields: Readonly<Record<string, Field>>): Record<string, Field> =>
  Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [key, { ...field, visible: false } as Field]),
  );

/**
 * A canvas component with its settings declared as Puck fields: `fields` hides every prop until
 * the block is resolved, `resolveFields` gives the settings that apply to the values the block
 * holds, and `renderFields` lays them out.
 */
export const withSettingFields = (
  component: ComponentConfig<Record<string, unknown>>,
  releaseOf: StudioSettingRelease,
  resolveBase:
    | ((data: { props: Record<string, unknown> }, params: unknown) => Record<string, Field>)
    | undefined,
): Partial<ComponentConfig<Record<string, unknown>>> => {
  const base = { ...(component.fields ?? {}), vortex: studioVortexField } as Record<string, Field>;
  return {
    fields: hidden(base),
    resolveFields: (data: { props: Record<string, unknown> }, params: unknown) => {
      const release = releaseOf(data.props);
      const resolved = {
        ...(resolveBase === undefined ? base : resolveBase(data, params)),
        vortex: studioVortexField,
      };
      return release === undefined
        ? hidden(resolved)
        : studioSettingFields(release, resolved, data.props);
    },
    renderFields: ({ fields }: { fields: Partial<Record<string, ReactNode>> }) => (
      <StudioSettingFieldList releaseOf={releaseOf} fields={fields} />
    ),
  } as never;
};

/** The selected block's settings in the inspector: Puck's fields, drawn by Studio's setting controls. */
export function StudioBlockSettingFields({
  choices,
  disabled,
  placementAlias,
}: Readonly<
  StudioSettingFieldsValue & {
    /** The block the inspector names; only that block's settings are drawn. */
    placementAlias: string;
  }
>): ReactNode {
  const scope =
    usePuckSelector((state) => state.selectedItem?.props.id as string | undefined) ?? "";
  const [touched, setTouched] = useState<{ scope: string; keys: ReadonlySet<string> }>({
    scope,
    keys: noKeys,
  });
  const touch = useCallback(
    (key: string) =>
      setTouched((previous) => ({
        scope,
        keys: new Set([...(previous.scope === scope ? previous.keys : []), key]),
      })),
    [scope],
  );
  const value = useMemo(
    () => ({
      choices,
      disabled,
      scope,
      touched: touched.scope === scope ? touched.keys : noKeys,
      touch,
    }),
    [choices, disabled, scope, touched, touch],
  );
  return (
    <StudioSettingFieldsContext.Provider value={value}>
      {scope === placementAlias && <Puck.Fields wrapFields={false} />}
    </StudioSettingFieldsContext.Provider>
  );
}
