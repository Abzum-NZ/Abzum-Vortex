"use client";

import { useId, type ReactElement } from "react";
import {
  checkRecordsTableFeature,
  plainSourceSettingValue,
  readRecordsTableFeatures,
  recordsTableFeatureDescription,
  recordsTableFeatureKeys,
  recordsTableFeatureState,
  typedSourceSettingValue,
  type BlockPropertySchemaContract,
  type ModuleField,
  type RecordsTableFeatureKey,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import { Badge } from "../components/badge";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../components/item";
import { Label } from "../components/label";
import { Switch } from "../components/switch";
import type { StudioQueryChoice } from "./contextual-palette";
import {
  studioGridFeatureEditors,
  studioGridFeatureStartSettings,
  studioRecordsTableQueryFacts,
  type StudioRelatedRecordsChoices,
} from "./grid-features";
import { StudioConditionalFormattingEditor } from "./grid-features/conditional-formatting";
import { StudioSavedViewsEditor } from "./grid-features/saved-views";
import { StudioInspectorGroup } from "./studio-inspector-group";
import { StudioQueryBindings } from "./studio-query-bindings";
import {
  StudioSettingFields,
  type StudioSettingChoices,
  type StudioSettingValues,
} from "./studio-setting-controls";

type GroupValue = Extract<SourceBlockPropertyValueContract, { kind: "group" }>;

/**
 * The Records table's `features` setting group: the group whose entries are exactly the grid
 * features of the registry. Undefined for every other block, which shows no Features panel.
 */
export const studioGridFeaturesProperty = (
  properties: readonly BlockPropertySchemaContract[],
): Extract<BlockPropertySchemaContract, { kind: "group" }> | undefined => {
  const property = properties.find((candidate) => candidate.key === "features");
  return property?.kind === "group" &&
    property.properties.length === recordsTableFeatureKeys.length &&
    recordsTableFeatureKeys.every((key) =>
      property.properties.some((feature) => feature.key === key && feature.kind === "group"),
    )
    ? property
    : undefined;
};

/**
 * The Features panel of a Records table: one compact row per grid feature with its switch and its
 * capability check beside it, "Available" or "Not possible" with the business sentence. The check is
 * the registry's own, run on the draft's facts of the bound query, so it says exactly what
 * publication will say. Switching a feature on reveals its settings; switching it off keeps only the
 * switch, so a feature that is off compiles to nothing.
 */
export function StudioGridFeatures({
  idPrefix,
  property,
  value,
  query,
  compiledFields,
  tableSettings,
  signedIn,
  choices,
  related,
  disabled,
  onChange,
}: Readonly<{
  idPrefix: string;
  /** The table release's `features` group declaration. */
  property: Extract<BlockPropertySchemaContract, { kind: "group" }>;
  /** The authored features group; unset uses the catalogue default (every feature off). */
  value: SourceBlockPropertyValueContract | undefined;
  /** The query the table reads, or undefined until one is chosen. */
  query: StudioQueryChoice | undefined;
  /** The saved draft's compiled fields of the record type the query reads; undefined before a save. */
  compiledFields: readonly ModuleField[] | undefined;
  /** The block's choices: the bound query's fields by business name. */
  tableSettings: StudioSettingValues;
  signedIn: boolean;
  choices: StudioSettingChoices;
  /** What the draft offers the rows' related records. */
  related: StudioRelatedRecordsChoices;
  disabled: boolean;
  onChange: (next: SourceBlockPropertyValueContract) => void;
}>): ReactElement {
  const ownId = useId();
  const authored = value?.kind === "group" ? value.properties : {};
  const featureValue = (key: RecordsTableFeatureKey): GroupValue => {
    const held = authored[key];
    const declared = property.properties.find((feature) => feature.key === key)?.defaultValue;
    if (held?.kind === "group") return held;
    if (declared?.kind !== "group") throw new Error(`Grid feature ${key} has no catalogue default`);
    return declared as GroupValue;
  };
  const whole: GroupValue = {
    kind: "group",
    properties: Object.fromEntries(recordsTableFeatureKeys.map((key) => [key, featureValue(key)])),
  };
  const features = readRecordsTableFeatures(whole);
  const facts = studioRecordsTableQueryFacts(
    query,
    signedIn,
    choices.actions,
    choices.relationships,
    related,
  );
  // Related records pick a link to this table's record type, a query of the linked record type and
  // that query's fields, never the table's own fields; This row binds the query's input.
  const relatedSettings = (current: GroupValue) => {
    const settingReference = (key: string): string | undefined => {
      const value = current.properties[key];
      return value?.kind === "relationship_reference"
        ? value.relationship
        : value?.kind === "query_reference"
          ? value.query
          : undefined;
    };
    const links = facts.relatedRecords.links;
    const link = links.find(
      (candidate) => candidate.relationship === settingReference("relationship"),
    );
    const childTypes =
      link === undefined
        ? links.map((candidate) => candidate.childRecordType)
        : [link.childRecordType];
    const childQuery = related.queries.find(
      (candidate) => candidate.reference === settingReference("child_query"),
    );
    return {
      choices: {
        ...choices,
        relationships: related.relationships.filter((relationship) =>
          links.some((candidate) => candidate.relationship === relationship.reference),
        ),
        queries: related.queries.filter(
          (candidate) => !candidate.grouped && childTypes.includes(candidate.recordType),
        ),
        fields: childQuery?.fields ?? [],
      } satisfies StudioSettingChoices,
      childQuery,
    };
  };
  const write = (key: RecordsTableFeatureKey, next: GroupValue): void => {
    const candidate = { ...whole, properties: { ...whole.properties, [key]: next } };
    // New list entries need their catalogue defaults before the composition command checks the
    // typed value's round trip. Keep invalid user input in the inspector's ordinary validation path.
    const normalized = typedSourceSettingValue(
      plainSourceSettingValue(candidate),
      property,
      [property.key],
      [],
    );
    onChange(normalized ?? candidate);
  };

  return (
    <StudioInspectorGroup title="Features">
      <ItemGroup role="list" aria-label="Table features" className="gap-1">
        {recordsTableFeatureKeys.map((key) => {
          const declaration = property.properties.find((feature) => feature.key === key);
          const { label, description } = recordsTableFeatureDescription(key);
          const enabled = features !== undefined && recordsTableFeatureState(features, key).enabled;
          const check =
            features === undefined
              ? undefined
              : checkRecordsTableFeature(key, recordsTableFeatureState(features, key), facts);
          const switchId = `${idPrefix}-${ownId}-${key}`;
          const settings =
            declaration?.kind === "group"
              ? declaration.properties.filter((setting) => setting.key !== "enabled")
              : [];
          const current = featureValue(key);
          const editor = studioGridFeatureEditors[key];
          const settingValues: StudioSettingValues = Object.fromEntries(
            Object.entries(current.properties).filter(([setting]) => setting !== "enabled"),
          );
          return (
            <div role="listitem" key={key} data-vortex-grid-feature={key}>
              <Item size="sm" className="px-0">
                <ItemContent>
                  <ItemTitle>
                    <Label htmlFor={switchId}>{label}</Label>
                    {check === undefined ? null : check.kind === "available" ? (
                      <Badge
                        variant="outline"
                        className="border-transparent bg-success/10 text-success"
                      >
                        Available
                      </Badge>
                    ) : (
                      <Badge variant="outline">Not possible</Badge>
                    )}
                  </ItemTitle>
                  <ItemDescription>
                    {check?.kind === "not_possible" ? check.reason : description}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    id={switchId}
                    checked={enabled}
                    disabled={disabled || features === undefined}
                    onCheckedChange={(on: boolean) =>
                      write(
                        key,
                        on
                          ? {
                              kind: "group",
                              properties: {
                                ...studioGridFeatureStartSettings[key],
                                enabled: { kind: "boolean", value: true },
                              },
                            }
                          : (() => {
                              const defaultValue = declaration?.defaultValue;
                              if (defaultValue?.kind !== "group")
                                throw new Error(`Grid feature ${key} has no catalogue default`);
                              return defaultValue as GroupValue;
                            })(),
                      )
                    }
                  />
                </ItemActions>
              </Item>
              {enabled && key === "conditional_formatting" && features !== undefined ? (
                <div className="pb-2">
                  <StudioConditionalFormattingEditor
                    idPrefix={`${switchId}-editor`}
                    value={current}
                    state={features.conditionalFormatting}
                    query={query}
                    facts={facts}
                    compiledFields={compiledFields}
                    disabled={disabled}
                    onChange={(next) => write(key, next)}
                  />
                </div>
              ) : null}
              {enabled && key === "saved_views" ? (
                <div className="pb-2">
                  <StudioSavedViewsEditor
                    value={current}
                    tableSettings={tableSettings}
                    roles={choices.roles}
                    disabled={disabled}
                    onChange={(next) => write(key, next)}
                  />
                </div>
              ) : null}
              {!enabled || settings.length === 0 || editor.kind !== "settings" ? null : (
                <div className="space-y-3 pb-2">
                  {(() => {
                    const own = key === "master_detail" ? relatedSettings(current) : undefined;
                    const commit = (next: StudioSettingValues) =>
                      write(key, {
                        kind: "group",
                        properties: { ...next, enabled: { kind: "boolean", value: true } },
                      });
                    return (
                      <>
                        <StudioSettingFields
                          idPrefix={`${switchId}-settings`}
                          properties={settings.filter(
                            (setting) => setting.key !== "query_parameters",
                          )}
                          values={settingValues}
                          choices={
                            own?.choices ?? {
                              ...choices,
                              ...(editor.offers === undefined
                                ? {}
                                : { fields: choices.fields.filter(editor.offers) }),
                              ...(editor.boundRecordTypeActions === undefined
                                ? {}
                                : {
                                    actions: choices.actions.filter(
                                      (action) => action.recordType === query?.recordType,
                                    ),
                                  }),
                            }
                          }
                          disabled={disabled}
                          onChange={(next) =>
                            commit({
                              ...next,
                              ...(settingValues["query_parameters"] === undefined
                                ? {}
                                : { query_parameters: settingValues["query_parameters"] }),
                            })
                          }
                        />
                        {own === undefined ||
                        !settings.some((setting) => setting.key === "query_parameters") ? null : (
                          <StudioQueryBindings
                            query={own.childQuery}
                            value={settingValues["query_parameters"]}
                            facts={{
                              ...related.page,
                              blockLabel: own.childQuery?.label ?? label,
                              rowFields: related.rowFields,
                              ...(query === undefined ? {} : { rowRecordType: query.recordType }),
                            }}
                            choices={own.choices}
                            disabled={disabled}
                            onChange={(bindings) =>
                              commit({ ...settingValues, query_parameters: bindings })
                            }
                          />
                        )}
                      </>
                    );
                  })()}
                </div>
              )}
            </div>
          );
        })}
      </ItemGroup>
    </StudioInspectorGroup>
  );
}
