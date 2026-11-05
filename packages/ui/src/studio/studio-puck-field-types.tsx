"use client";

import {
  createContext,
  memo,
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
  type ApplicationAudience,
  type ApplicationSourceDocument,
  plainSourceSettingValue,
  typedSourceSettingValue,
  type BlockPropertySchemaContract,
  type QueryBindingPageFacts,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import { Item } from "../components/item";
import type { StudioQueryChoice } from "./contextual-palette";
import { StudioField } from "./studio-field";
import { StudioEditButton } from "./studio-icon-buttons";
import { StudioGateSelect } from "./studio-gate-select";
import { StudioReferencePicker } from "./studio-reference-picker";
import type { StudioReactionSlot } from "./application-reaction-condition-commands";
import {
  StudioSettingControl,
  StudioSettingNote,
  studioSiblingSettingKeys,
} from "./studio-setting-controls";
import { StudioQueryBindings } from "./studio-query-bindings";
import { StudioQueryPicker } from "./studio-query-picker";
import {
  conditionalRequiredMessage,
  settleStudioSetting,
  studioSettingProblems,
  type SettingValue,
  type StudioSettingChoices,
  type StudioSettingValues,
} from "./studio-setting-model";
import { studioTotalMeasureProperty } from "./grid-features/totals";
import { StudioGridFeatures, type StudioGridFeaturesProps } from "./studio-grid-features";
import {
  StudioLayoutField,
  StudioOrderField,
  type StudioLayoutFieldValue,
} from "./studio-layout-fields";

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
  /** Who sees the block and when: its permission gate and conditions. */
  access?: StudioAccessFieldValue | undefined;
  /** The block's size and order on the canvas screen, and the commands that change them. */
  layout?: StudioLayoutFieldValue | undefined;
  /**
   * The Records table's grid features (board, formatting, export, inline edit, row actions, row
   * edit).
   */
  features?: StudioGridFeaturesProps | undefined;
  /** What follows the settings in their group: the selection bindings and the group's refusal. */
  settingsAfter?: ReactNode;
  /**
   * Said in the Settings group in place of the settings when the block's settings cannot be
   * drawn.
   */
  notice?: string | undefined;
}>;

/**
 * The permission gate and the four conditions of the selected block, edited through the
 * inspector's commands.
 */
export type StudioAccessFieldValue = Readonly<{
  /** The group's one-line summary while it is closed. */
  summary: string;
  gate:
    | Readonly<{
        kind: "available";
        source: ApplicationSourceDocument;
        /** The permission key the block needs, or an empty text. */
        permission: string;
        /** Sets the gate (null clears it); answers whether the draft took it. */
        onChange: (permission: string | null) => boolean;
        /** Why the draft refused the last change, shown at the field until the draft changes. */
        problem?: string | undefined;
        /** The permission that lets people use the block, or an empty text. */
        use: string;
        onUse: (permission: string | null) => boolean;
        useProblem?: string | undefined;
        /** Who the block is offered to, or an empty text for everyone. */
        audience: ApplicationAudience | "";
        onAudience: (audience: ApplicationAudience | null) => boolean;
        audienceProblem?: string | undefined;
      }>
    | Readonly<{ kind: "refused"; reason: string }>;
  /** One row per condition, or the reason they cannot be changed here. */
  conditions:
    | Readonly<{
        kind: "available";
        rows: readonly Readonly<{
          slot: StudioReactionSlot;
          title: string;
          words: string;
          onEdit: () => void;
        }>[];
      }>
    | Readonly<{ kind: "refused"; reason: string }>;
}>;

/**
 * The block's data choice and the bindings of its inputs, edited through the inspector's
 * commands.
 */
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

/** The selection the fields belong to, and how a field marks its setting as edited. */
type StudioSettingFieldsContextValue = Omit<StudioSettingFieldsValue, "access" | "layout"> &
  Readonly<{ scope: string; touch: (key: string) => void }>;

/**
 * The settings the person has edited since the selected block was chosen. Only the notes read
 * them, so the first edit of a setting draws the notes and not every setting.
 */
export const StudioSettingTouchedContext = createContext<ReadonlySet<string>>(new Set());

/**
 * Who sees the block, and its size and order, each in a context of its own: they change with the
 * draft far more often than the settings do, and only their own fields read them.
 */
export const StudioAccessFieldContext = createContext<Readonly<{
  access: StudioAccessFieldValue | undefined;
  disabled: boolean;
}> | null>(null);
export const StudioLayoutFieldContext = createContext<Readonly<{
  layout: StudioLayoutFieldValue | undefined;
  disabled: boolean;
}> | null>(null);

export const StudioSettingFieldsContext = createContext<StudioSettingFieldsContextValue | null>(
  null,
);

/**
 * The name of the inspector field that holds the block's data choice (it is not a prop of the
 * block).
 */
export const studioQueryFieldName = "vortexQuery";

/** The inspector fields that hold the block's access: its permission gate and each condition. */
export const studioGateFieldName = "vortexGate";
/**
 * The inspector fields of the Layout group: the block's size and its order on the canvas screen.
 */
export const studioLayoutFieldName = "vortexLayout";
export const studioOrderFieldName = "vortexOrder";
/**
 * The inspector field that holds the Records table's grid features (they are one setting group,
 * drawn as one panel).
 */
export const studioFeaturesFieldName = "vortexGridFeatures";
export const studioConditionFieldName = (slot: StudioReactionSlot) => `vortexCondition-${slot}`;

type SettingKind = Readonly<{
  kind: "setting";
  property: BlockPropertySchemaContract;
  properties: readonly BlockPropertySchemaContract[];
}>;

/**
 * What a Studio field carries: the setting and the control that edits it, or the block's data
 * choice.
 */
type StudioFieldKind =
  | SettingKind
  | Readonly<{ kind: "query" | "gate" | "layout" | "order" | "features" }>
  | Readonly<{ kind: "condition"; slot: StudioReactionSlot }>;

/** Studio's data travels in Puck's public field `metadata`; Puck's own render is not used. */
const studioCustomField = (label: string, key: string, studio: StudioFieldKind): Field =>
  ({
    type: "custom",
    label,
    key,
    metadata: { studio },
    render: () => null as never,
  }) satisfies CustomField<unknown>;

/**
 * The field of each declared setting, made once: the inspector asks for its fields on every edit
 * of the block, and a field that is the same object lets its control keep its place.
 */
const settingFields = new WeakMap<BlockPropertySchemaContract, Field>();

/** The field of a declared setting. */
export const studioSettingField = (
  release: Readonly<{ blockId: string; releaseVersion: number | string }>,
  property: BlockPropertySchemaContract,
  properties: readonly BlockPropertySchemaContract[],
): Field => {
  const made = settingFields.get(property);
  if (made !== undefined) return made;
  const field = studioCustomField(
    property.label,
    `${release.blockId}@${release.releaseVersion}:${property.key}`,
    { kind: "setting", property, properties },
  );
  settingFields.set(property, field);
  return field;
};

/** The field that chooses the data a block reads. */
export const studioQueryField: Field = studioCustomField("Data", studioQueryFieldName, {
  kind: "query",
});

/** The field that holds the block's permission gate. */
export const studioGateField: Field = studioCustomField("Permission gate", studioGateFieldName, {
  kind: "gate",
});

/**
 * The fields of the Layout group; they hold no prop of the block and write through its resize and
 * order commands.
 */
export const studioLayoutField: Field = studioCustomField("Size", studioLayoutFieldName, {
  kind: "layout",
});
export const studioOrderField: Field = studioCustomField("Order", studioOrderFieldName, {
  kind: "order",
});

/** The field that holds the Records table's grid features. */
export const studioFeaturesField: Field = studioCustomField("Features", studioFeaturesFieldName, {
  kind: "features",
});

/** The field of one condition (when the block shows, is required, is read-only or is enabled). */
export const studioConditionField = (slot: StudioReactionSlot, title: string): Field =>
  studioCustomField(title, studioConditionFieldName(slot), { kind: "condition", slot });

/**
 * The typed settings a block's plain props hold; a prop that is not a valid value of its
 * declaration is left out.
 */
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

/**
 * Puck hands every field a new props object when any setting of the block changes: a field draws
 * again only when its own value, its read-only state or its change function differs.
 */
const sameSettingField = (
  before: Readonly<{ setting: SettingKind; field: SettingFieldRenderProps }>,
  after: Readonly<{ setting: SettingKind; field: SettingFieldRenderProps }>,
) =>
  before.setting === after.setting &&
  before.field.readOnly === after.field.readOnly &&
  before.field.onChange === after.field.onChange &&
  JSON.stringify(before.field.value ?? null) === JSON.stringify(after.field.value ?? null);

/**
 * One setting as a field: its label, hint and message around its control; held input stays in the
 * control.
 */
const StudioSettingField = memo(function StudioSettingField({
  setting,
  field,
}: Readonly<{ setting: SettingKind; field: SettingFieldRenderProps }>) {
  const { property, properties } = setting;
  const context = useContext(StudioSettingFieldsContext);
  const getPuck = useGetPuck();
  // The sibling settings this field's notes and measure read, subscribed to as one string: a
  // keystroke in a setting that no other field reads draws no other field.
  const siblingKeys = studioSiblingSettingKeys(property, properties);
  const siblingsKey = usePuckSelector((state) => {
    const current = state.selectedItem?.props;
    return JSON.stringify(siblingKeys.map((key) => current?.[key] ?? null));
  });
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
  const values = useMemo(() => {
    const read = JSON.parse(siblingsKey) as unknown[];
    const siblings: Record<string, unknown> = {};
    studioSiblingSettingKeys(property, properties).forEach((key, at) => {
      if (read[at] !== null) siblings[key] = read[at];
    });
    return studioTypedSettings(siblings, properties);
  }, [siblingsKey, property, properties]);
  if (context === null) return null;
  const { choices, disabled, scope, touch } = context;
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
      <StudioSettingFieldNote
        property={property}
        properties={properties}
        values={values}
        choices={choices}
        disabled={disabled}
        scope={scope}
        onUseFieldLabel={() => change(undefined)}
      />
    </div>
  );
}, sameSettingField);

/** The notes under a setting, with the edited settings they read from their own context. */
function StudioSettingFieldNote(props: Omit<Parameters<typeof StudioSettingNote>[0], "touched">) {
  const touched = useContext(StudioSettingTouchedContext);
  return <StudioSettingNote {...props} touched={touched} />;
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

const audienceChoices = [
  { value: "builders", label: "Builders", description: "People who may build applications" },
  { value: "installers", label: "Installers", description: "People who may install applications" },
] as const;

/**
 * Who can see the block and use it: the permission that shows it, the permission that lets people
 * use it and who it is offered to. A refusal shows at its field until the draft changes.
 */
const StudioGateField = memo(function StudioGateField({
  readOnly,
}: Readonly<{ readOnly: boolean }>) {
  const context = useContext(StudioAccessFieldContext);
  const gate = context?.access?.gate;
  if (context === null || gate === undefined) return null;
  if (gate.kind === "refused")
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {gate.reason}
      </p>
    );
  const disabled = context.disabled || readOnly;
  return (
    <div className="space-y-4">
      <StudioField
        label="Permission gate"
        optional
        error={gate.problem}
        hint="Show this block only to people who hold its permission. Page and menu permissions still apply. Clearing this gate adds no block permission requirement. Create permissions in Access."
      >
        {(control) => (
          <StudioGateSelect
            id={control.id}
            aria-describedby={control["aria-describedby"]}
            aria-invalid={control["aria-invalid"]}
            source={gate.source}
            value={gate.permission}
            label="Permission gate"
            disabled={disabled}
            onGate={(next) => next.kind === "existing" && gate.onChange(next.key)}
            onClear={() => gate.onChange(null)}
            allowCreate={false}
          />
        )}
      </StudioField>
      <StudioField
        label="Use permission"
        optional
        error={gate.useProblem}
        hint="People who see the block but do not hold this permission cannot use it. Clearing it adds no use requirement. Create permissions in Access."
      >
        {(control) => (
          <StudioGateSelect
            id={control.id}
            aria-describedby={control["aria-describedby"]}
            aria-invalid={control["aria-invalid"]}
            source={gate.source}
            value={gate.use}
            label="Use permission"
            disabled={disabled}
            onGate={(next) => next.kind === "existing" && gate.onUse(next.key)}
            onClear={() => gate.onUse(null)}
            allowCreate={false}
            unsetLabel="No use permission"
          />
        )}
      </StudioField>
      <StudioField
        label="Offered to"
        error={gate.audienceProblem}
        hint="Everyone sees the block. Builders or Installers show it only to people who may build or install applications."
      >
        {(control) => (
          <StudioReferencePicker
            id={control.id}
            aria-describedby={control["aria-describedby"]}
            aria-invalid={control["aria-invalid"]}
            aria-label="Offered to"
            value={gate.audience}
            unset="Everyone"
            options={audienceChoices}
            disabled={disabled}
            onChange={(next) => gate.onAudience(next === "" ? null : (next as ApplicationAudience))}
          />
        )}
      </StudioField>
    </div>
  );
});

/** One condition of the block as a row: its title, the rule in words and an Edit button. */
const StudioConditionField = memo(function StudioConditionField({
  slot,
  readOnly,
}: Readonly<{ slot: StudioReactionSlot; readOnly: boolean }>) {
  const context = useContext(StudioAccessFieldContext);
  const conditions = context?.access?.conditions;
  if (context === null || conditions === undefined) return null;
  const row = conditions.kind === "available" ? conditions.rows.find((r) => r.slot === slot) : null;
  // One notice stands for the four conditions: the first row says it.
  if (conditions.kind === "refused")
    return slot === "visibility_condition" ? (
      <p role="status" className="text-sm text-muted-foreground">
        {conditions.reason}
      </p>
    ) : null;
  if (row === null || row === undefined) return null;
  return (
    <Item size="xs" role="listitem" className="justify-between" data-vortex-condition={slot}>
      <span className="min-w-0">
        <span className="block text-sm">{row.title}</span>
        <span className="block truncate text-xs text-muted-foreground" title={row.words}>
          {row.words}
        </span>
      </span>
      <StudioEditButton
        label={`Edit ${row.title.toLowerCase()} condition`}
        disabled={context.disabled || readOnly}
        onClick={row.onEdit}
      />
    </Item>
  );
});

/**
 * The grid features of a Records table: the existing feature editors, edited through the
 * inspector's settings command.
 */
function StudioFeaturesField({ readOnly }: Readonly<{ readOnly: boolean }>) {
  const features = useContext(StudioSettingFieldsContext)?.features;
  if (features === undefined) return null;
  return <StudioGridFeatures {...features} disabled={features.disabled || readOnly} />;
}

/** The size or the order of the block: the inspector's layout value drawn by the Layout fields. */
const StudioLayoutKind = memo(function StudioLayoutKind({
  kind,
  readOnly,
}: Readonly<{ kind: "layout" | "order"; readOnly: boolean }>) {
  const context = useContext(StudioLayoutFieldContext);
  if (context?.layout === undefined) return null;
  const disabled = context.disabled || readOnly;
  return kind === "layout" ? (
    <StudioLayoutField value={context.layout} disabled={disabled} />
  ) : (
    <StudioOrderField value={context.layout} disabled={disabled} />
  );
});

type CustomFieldRenderer = NonNullable<NonNullable<Overrides["fieldTypes"]>["custom"]>;

const StudioCustomField: CustomFieldRenderer = (props) => {
  const studio = (props.field.metadata as { studio?: StudioFieldKind } | undefined)?.studio;
  // A custom field Studio did not declare keeps Puck's own render.
  if (studio === undefined)
    return (props.field as unknown as CustomField<unknown>).render(props as never);
  const readOnly = props.readOnly === true;
  switch (studio.kind) {
    case "query":
      return <StudioQueryField readOnly={readOnly} />;
    case "gate":
      return <StudioGateField readOnly={readOnly} />;
    case "condition":
      return <StudioConditionField slot={studio.slot} readOnly={readOnly} />;
    case "features":
      return <StudioFeaturesField readOnly={readOnly} />;
    case "layout":
    case "order":
      return <StudioLayoutKind kind={studio.kind} readOnly={readOnly} />;
    case "setting":
      return (
        <StudioSettingField
          key={(props.field as { key?: string }).key}
          setting={studio}
          field={props as SettingFieldRenderProps}
        />
      );
  }
};

/** Puck's `overrides.fieldTypes` for the inspector: Studio draws every field it declares. */
export const studioFieldTypes: NonNullable<Overrides["fieldTypes"]> = {
  custom: StudioCustomField,
};
