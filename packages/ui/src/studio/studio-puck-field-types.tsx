"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  createUsePuck,
  useGetPuck,
  type CustomField,
  type Field,
  type Overrides,
} from "@puckeditor/core";
import {
  plainSourceSettingValue,
  typedSourceSettingValue,
  type BlockPropertySchemaContract,
  type QueryBindingPageFacts,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import type { StudioQueryChoice } from "./contextual-palette";
import { StudioField } from "./studio-field";
import { StudioSettingControl } from "./studio-setting-controls";
import { StudioQueryBindings } from "./studio-query-bindings";
import { StudioQueryPicker } from "./studio-query-picker";
import { StudioSettingNote } from "./studio-setting-controls";
import {
  conditionalRequiredMessage,
  settleStudioSetting,
  studioSettingProblems,
  type SettingValue,
  type StudioSettingChoices,
  type StudioSettingValues,
} from "./studio-setting-model";
import { studioTotalMeasureProperty } from "./grid-features/totals";

/**
 * Studio's Puck field types, drawn through `overrides.fieldTypes.custom`. Every field of a block
 * is a custom field that carries what Studio draws it with, so one stable component renders it
 * and a field is not remounted when Puck resolves its fields again. A setting field is the label,
 * hint and message of the setting around the control of its kind (the reference, record and field
 * pickers are controls of their own); the query field is the block's data choice with its New
 * query button and the bindings of its inputs.
 */

export const usePuckSelector = createUsePuck();

/** What the setting controls need that a field's own value does not hold. */
export type StudioSettingFieldsValue = Readonly<{
  /** What reference settings can point at, for the selected block's data. */
  choices: StudioSettingChoices;
  disabled: boolean;
  /** The data the block reads, when it reads any: its picker, New query and input bindings. */
  query?: StudioQueryFieldValue | undefined;
}>;

/** The block's data choice and the bindings of its inputs, edited through the inspector's commands. */
type StudioQueryFieldValue = Readonly<{
  value: string;
  queries: readonly StudioQueryChoice[];
  recordQueries: readonly StudioQueryChoice[];
  /** Why the data is not valid yet (the block needs some). */
  problem?: string | undefined;
  onChange: (reference: string) => void;
  /** Opens the New-query sheet; it comes back with the new query chosen. */
  onNewQuery?: (() => void) | undefined;
  bindings: Readonly<{
    value: SourceBlockPropertyValueContract | undefined;
    facts: QueryBindingPageFacts;
    onChange: (value: SourceBlockPropertyValueContract) => void;
  }>;
  /** What follows the data and its bindings: a Records table's add-records control. */
  after?: ReactNode;
}>;

/** The settings the person has edited since the selected block was chosen (the label note reads them). */
type StudioSettingFieldsContextValue = StudioSettingFieldsValue &
  Readonly<{ scope: string; touched: ReadonlySet<string>; touch: (key: string) => void }>;

export const StudioSettingFieldsContext = createContext<StudioSettingFieldsContextValue | null>(
  null,
);

/** The name of the inspector field that holds the block's data choice (it is not a prop of the block). */
export const studioQueryFieldName = "vortexQuery";

type SettingKind = Readonly<{
  kind: "setting";
  property: BlockPropertySchemaContract;
  properties: readonly BlockPropertySchemaContract[];
}>;

/** What a Studio field carries: the setting and the control that edits it, or the block's data choice. */
type StudioFieldKind = SettingKind | Readonly<{ kind: "query" }>;

/** Studio's data travels in Puck's public field `metadata`; Puck's own render is not used. */
const studioCustomField = (label: string, key: string, studio: StudioFieldKind): Field =>
  ({
    type: "custom",
    label,
    key,
    metadata: { studio },
    render: () => null as never,
  }) satisfies CustomField<unknown>;

/** The field of a declared setting. */
export const studioSettingField = (
  release: Readonly<{ blockId: string; releaseVersion: number | string }>,
  property: BlockPropertySchemaContract,
  properties: readonly BlockPropertySchemaContract[],
): Field =>
  studioCustomField(
    property.label,
    `${release.blockId}@${release.releaseVersion}:${property.key}`,
    { kind: "setting", property, properties },
  );

/** The field that chooses the data a block reads. */
export const studioQueryField: Field = studioCustomField("Data", studioQueryFieldName, {
  kind: "query",
});

const noProps: Readonly<Record<string, unknown>> = {};

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

/** One setting as a field: its label, hint and message around its control; held input stays in the control. */
function StudioSettingField({
  setting,
  field,
}: Readonly<{ setting: SettingKind; field: SettingFieldRenderProps }>) {
  const { property, properties } = setting;
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

/** The data a block reads and the bindings of its inputs, in the inspector's own commands. */
function StudioQueryField({ readOnly }: Readonly<{ readOnly: boolean }>) {
  const id = useId();
  const context = useContext(StudioSettingFieldsContext);
  const query = context?.query;
  if (context === null || query === undefined) return null;
  const disabled = context.disabled || readOnly;
  return (
    <div className="space-y-4" data-vortex-query-field>
      <StudioQueryPicker
        id={id}
        queries={query.queries}
        recordQueries={query.recordQueries}
        value={query.value}
        disabled={disabled}
        onNewQuery={query.onNewQuery}
        onChange={query.onChange}
        error={query.problem}
      />
      <StudioQueryBindings
        choices={context.choices}
        query={query.queries.find((candidate) => candidate.reference === query.value)}
        value={query.bindings.value}
        facts={query.bindings.facts}
        disabled={disabled}
        onChange={query.bindings.onChange}
      />
      {query.after}
    </div>
  );
}

type CustomFieldRenderer = NonNullable<NonNullable<Overrides["fieldTypes"]>["custom"]>;

const StudioCustomField: CustomFieldRenderer = (props) => {
  const studio = (props.field.metadata as { studio?: StudioFieldKind } | undefined)?.studio;
  // A custom field Studio did not declare keeps Puck's own render.
  if (studio === undefined)
    return (props.field as unknown as CustomField<unknown>).render(props as never);
  return studio.kind === "query" ? (
    <StudioQueryField readOnly={props.readOnly === true} />
  ) : (
    <StudioSettingField
      key={(props.field as { key?: string }).key}
      setting={studio}
      field={props as SettingFieldRenderProps}
    />
  );
};

/** Puck's `overrides.fieldTypes` for the inspector: Studio draws every field it declares. */
export const studioFieldTypes: NonNullable<Overrides["fieldTypes"]> = {
  custom: StudioCustomField,
};
