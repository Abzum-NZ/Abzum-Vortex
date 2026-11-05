"use client";

import { useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Puck, type ComponentConfig, type Field } from "@puckeditor/core";
import {
  canonicalJson,
  componentSettingApplies,
  plainSettingValue,
  type BlockPropertySchemaContract,
  type PlatformBlockRelease,
} from "@vortex/platform/schema";
import { ItemGroup } from "../components/item";
import { Icon } from "../icons";
import {
  StudioSettingFieldsContext,
  studioConditionField,
  studioConditionFieldName,
  studioGateField,
  studioGateFieldName,
  studioQueryField,
  studioQueryFieldName,
  studioSettingField,
  studioTypedSettings,
  usePuckSelector,
  type StudioSettingFieldsValue,
} from "./studio-puck-field-types";
import { studioGridFeaturesProperty } from "./studio-grid-features";
import { StudioHelp } from "./studio-field";
import { StudioInspectorGroup } from "./studio-inspector-group";
import { StudioInspectorActions, type StudioInspectorAction } from "./studio-inspector-actions";
import { studioReleaseIcon } from "./studio-puck-drawer";
import { studioReactionSlots } from "./application-reaction-condition-commands";
import { studioBlockReadsQuery } from "./application-composition-commands";
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

const noKeys: ReadonlySet<string> = new Set();

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

const noProps: Readonly<Record<string, unknown>> = {};

/** Who sees the block and when: the fields of the Visibility and access group. */
const addAccessFields = (fields: Record<string, Field>): void => {
  fields[studioGateFieldName] = studioGateField;
  for (const reaction of studioReactionSlots)
    fields[studioConditionFieldName(reaction.slot)] = studioConditionField(
      reaction.slot,
      reaction.title,
    );
};

/** The fields of one placement: its shown settings first, every other prop hidden from the inspector. */
const studioSettingFields = (
  release: PlatformBlockRelease,
  base: Readonly<Record<string, Field>>,
  props: Readonly<Record<string, unknown>> | undefined,
): Record<string, Field> => {
  const listed = studioFieldSettings(release.properties as readonly BlockPropertySchemaContract[]);
  const values =
    props === undefined ? undefined : studioTypedSettings(props, release.properties as never);
  // A block that reads data chooses it first, and the bindings of its inputs follow.
  const readsQuery = props !== undefined && studioBlockReadsQuery(release, props);
  const fields: Record<string, Field> = readsQuery
    ? { [studioQueryFieldName]: studioQueryField }
    : {};
  for (const property of listed) {
    if (values !== undefined && !componentSettingApplies(property, values)) continue;
    fields[property.key] = studioSettingField(release, property, release.properties as never);
  }
  addAccessFields(fields);
  for (const [key, field] of Object.entries(base))
    if (fields[key] === undefined) fields[key] = { ...field, visible: false } as Field;
  return fields;
};

/**
 * Lays the inspector out in groups: the settings in use first, the optional ones nobody has set in
 * a closed "More settings" group (decided once for the selected block, so a field does not jump
 * while it is typed into), and the closed "Visibility and access" group.
 */
function StudioInspectorFieldGroups({
  releaseOf,
  fields,
}: Readonly<{
  releaseOf: StudioSettingRelease;
  fields: Partial<Record<string, ReactNode>>;
}>) {
  const props = usePuckSelector((state) => state.selectedItem?.props) ?? noProps;
  const context = useContext(StudioSettingFieldsContext);
  const selectedId = props.id as string | undefined;
  const decided = useRef<{ id: string | undefined; keys: ReadonlySet<string> } | null>(null);
  const release = releaseOf(props);
  if (decided.current === null || decided.current.id !== selectedId) {
    decided.current = {
      id: selectedId,
      keys: new Set(
        studioFieldSettings((release?.properties ?? []) as never)
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
  // A block whose settings cannot be changed draws no setting control: its notice stands for them.
  const controls = (context?.notice !== undefined ? [] : Object.entries(fields))
    .filter(
      ([key, node]) =>
        node !== undefined &&
        (key === studioQueryFieldName || release?.properties.some((p) => p.key === key)),
    )
    .map(([key, node]) => ({ key, node: <div key={key}>{node}</div> }));
  const more = controls.filter((control) => decided.current?.keys.has(control.key) === true);
  const primary = controls.filter((control) => !more.includes(control));
  const access = context?.access;
  return (
    <>
      {(primary.length > 0 || context?.settingsAfter || context?.notice) && (
        <StudioInspectorGroup title="Settings" hint="A setting you leave unset uses its default.">
          {context?.notice === undefined ? (
            <>
              {primary.map((control) => control.node)}
              {context?.settingsAfter}
            </>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {context.notice}
            </p>
          )}
        </StudioInspectorGroup>
      )}
      {more.length > 0 && (
        <StudioInspectorGroup
          title="More settings"
          defaultOpen={false}
          persist={false}
          summary={`${more.length} more`}
        >
          {more.map((control) => control.node)}
        </StudioInspectorGroup>
      )}
      {access !== undefined && (
        <StudioInspectorGroup
          title="Visibility and access"
          defaultOpen={false}
          summary={access.summary}
        >
          {fields[studioGateFieldName]}
          {access.conditions.kind === "available" ? (
            <ItemGroup className="gap-2" aria-label="Conditions">
              {studioReactionSlots.map((reaction) => (
                <div key={reaction.slot} role="presentation">
                  {fields[studioConditionFieldName(reaction.slot)]}
                </div>
              ))}
            </ItemGroup>
          ) : (
            fields[studioConditionFieldName("visibility_condition")]
          )}
        </StudioInspectorGroup>
      )}
    </>
  );
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
 * holds, and `renderFields` lays them out. Puck takes a new config when a page's tab keys change
 * and, until it resolves the selected block's fields again, shows its static `fields`: a block that
 * holds repeating slots (`repeating` is its release) declares its settings there, so the inspector
 * keeps what it draws and the field being typed in keeps its focus.
 */
export const withSettingFields = (
  component: ComponentConfig<Record<string, unknown>>,
  releaseOf: StudioSettingRelease,
  resolveBase:
    | ((data: { props: Record<string, unknown> }, params: unknown) => Record<string, Field>)
    | undefined,
  repeating?: PlatformBlockRelease | undefined,
): Partial<ComponentConfig<Record<string, unknown>>> => {
  const base = { ...(component.fields ?? {}), vortex: studioVortexField } as Record<string, Field>;
  return {
    fields:
      repeating === undefined ? hidden(base) : studioSettingFields(repeating, base, undefined),
    resolveFields: (data: { props: Record<string, unknown> }, params: unknown) => {
      const release = releaseOf(data.props);
      const resolved = {
        ...(resolveBase === undefined ? base : resolveBase(data, params)),
        vortex: studioVortexField,
      };
      if (release !== undefined) return studioSettingFields(release, resolved, data.props);
      // A block whose release the catalogue lacks still shows who sees it and when.
      const fields = hidden(resolved);
      addAccessFields(fields);
      return fields;
    },
    renderFields: ({ fields }: { fields: Partial<Record<string, ReactNode>> }) => (
      <StudioInspectorFieldGroups releaseOf={releaseOf} fields={fields} />
    ),
  } as never;
};

/**
 * The inspector header of the selected block: the name of this instance, its kind with the block's
 * description as help, and the More menu. The block's own settings follow it in groups.
 */
function StudioBlockHeader({
  titleId,
  name,
  actions,
  releases,
}: Readonly<{
  titleId: string;
  name: string;
  actions: readonly StudioInspectorAction[];
  releases: readonly PlatformBlockRelease[];
}>) {
  const block = usePuckSelector(
    (state) => (state.selectedItem?.props.vortex as { block?: Record<string, unknown> })?.block,
  );
  const release = releases.find(
    (candidate) =>
      candidate.blockId === block?.block_id && candidate.releaseVersion === block?.release_version,
  );
  return (
    <header className="flex items-start justify-between gap-2 pb-3">
      <div className="min-w-0">
        <h2 id={titleId} className="flex min-w-0 items-center gap-2 text-base font-semibold">
          <Icon name={studioReleaseIcon(release?.icon ?? "")} className="size-4 shrink-0" />
          <span className="truncate">{name}</span>
        </h2>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          {release?.name ?? "Block"}
          {release !== undefined && <StudioHelp hint={release.description} />}
        </p>
      </div>
      <StudioInspectorActions actions={actions} />
    </header>
  );
}

/** The selected block's inspector: its header, then its settings and access in Puck's fields. */
export function StudioBlockSettingFields({
  titleId,
  choices,
  disabled,
  query,
  access,
  settingsAfter,
  notice,
  placementAlias,
  name,
  actions,
  releases,
}: Readonly<
  StudioSettingFieldsValue & {
    /** The id of the heading that names the inspector: its section is labelled by it. */
    titleId: string;
    /** The block the inspector names; only that block's settings are drawn. */
    placementAlias: string;
    /** The name of this instance, and its More menu. */
    name: string;
    actions: readonly StudioInspectorAction[];
    /** The catalogue's releases, for the block's kind and description. */
    releases: readonly PlatformBlockRelease[];
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
      query,
      access,
      settingsAfter,
      notice,
      scope,
      touched: touched.scope === scope ? touched.keys : noKeys,
      touch,
    }),
    [choices, disabled, query, access, settingsAfter, notice, scope, touched, touch],
  );
  return (
    <StudioSettingFieldsContext.Provider value={value}>
      <StudioBlockHeader titleId={titleId} name={name} actions={actions} releases={releases} />
      {scope === placementAlias && <Puck.Fields wrapFields={false} />}
    </StudioSettingFieldsContext.Provider>
  );
}
