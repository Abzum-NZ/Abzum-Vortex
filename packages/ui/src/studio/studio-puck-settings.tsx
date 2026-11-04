"use client";

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Puck, type ComponentConfig, type Field } from "@puckeditor/core";
import {
  canonicalJson,
  componentSettingApplies,
  plainSettingValue,
  type BlockPropertySchemaContract,
  type PlatformBlockRelease,
} from "@vortex/platform/schema";
import { FieldGroup } from "../components/field";
import {
  StudioSettingFieldsContext,
  studioQueryField,
  studioQueryFieldName,
  studioSettingField,
  studioTypedSettings,
  usePuckSelector,
  type StudioSettingFieldsValue,
} from "./studio-puck-field-types";
import {
  StudioFieldPickerControl,
  StudioRecordControl,
  StudioReferenceControl,
} from "./studio-reference-controls";
import { studioGridFeaturesProperty } from "./studio-grid-features";
import { splitMoreSettings } from "./studio-more-settings";
import { StudioSettingControl } from "./studio-setting-controls";
import { studioOwnsSetting, studioReleaseReadsQuery } from "./contextual-palette";

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

/** The control that edits a setting of this kind. */
const controlOf = (property: BlockPropertySchemaContract) => {
  switch (property.kind) {
    case "field_reference":
      return StudioFieldPickerControl;
    case "record_reference":
      return StudioRecordControl;
    case "total_reference":
    case "query_reference":
    case "page_reference":
    case "record_type_reference":
    case "action_reference":
    case "relationship_reference":
      return StudioReferenceControl;
    default:
      return StudioSettingControl;
  }
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
  const readsQuery =
    studioReleaseReadsQuery(release) ||
    (props?.vortex as { query?: unknown } | undefined)?.query !== undefined;
  const fields: Record<string, Field> = readsQuery
    ? { [studioQueryFieldName]: studioQueryField }
    : {};
  for (const property of listed) {
    if (values !== undefined && !componentSettingApplies(property, values)) continue;
    fields[property.key] = studioSettingField(
      release,
      property,
      release.properties as never,
      controlOf(property),
    );
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
    .filter(
      ([key, node]) =>
        node !== undefined &&
        (key === studioQueryFieldName || release.properties.some((p) => p.key === key)),
    )
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
  query,
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
      query,
      scope,
      touched: touched.scope === scope ? touched.keys : noKeys,
      touch,
    }),
    [choices, disabled, query, scope, touched, touch],
  );
  return (
    <StudioSettingFieldsContext.Provider value={value}>
      {scope === placementAlias && <Puck.Fields wrapFields={false} />}
    </StudioSettingFieldsContext.Provider>
  );
}
