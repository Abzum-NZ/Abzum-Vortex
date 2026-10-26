"use client";

import {
  recordsTableInlineEditFeature,
  recordsTableMasterDetailFeature,
  recordsTableRowEditFeature,
  recordsTableSavedViewsFeature,
  recordsTableSpreadsheetFeature,
  recordsTableColumnFiltersFeature,
} from "@vortex/platform/schema";

import { useId, type ReactElement } from "react";
import { Button } from "../components/button";
import { studioGridPrerequisites } from "./grid-features/prerequisites";
import {
  checkRecordsTableFeature,
  plainSourceSettingValue,
  readRecordsTableFeatures,
  recordsTableBoardFeature,
  recordsTableConditionalFormattingFeature,
  recordsTableExportFeature,
  recordsTableFeatureDescription,
  recordsTableFilterKindOf,
  recordsTableFeatureKeys,
  recordsTableFeatureState,
  typedSourceSettingValue,
  type BlockPropertySchemaContract,
  type ModuleField,
  type RecordsTableFeatureKey,
  type RecordsTableFeatures,
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
  studioGridFeatureStart,
  studioRecordsTableQueryFacts,
  type StudioRelatedRecordsChoices,
} from "./grid-features";
import { StudioSpreadsheetEditor } from "./grid-features/spreadsheet";
import { StudioRowEditEditor } from "./grid-features/row-edit";
import { StudioInlineEditEditor } from "./grid-features/inline-edit";
import type { StudioBoardPipeline } from "./board-source";
import { StudioBoardEditor } from "./grid-features/board";
import { StudioConditionalFormattingEditor } from "./grid-features/conditional-formatting";
import { StudioSavedViewsEditor } from "./grid-features/saved-views";
import { StudioExportEditor } from "./grid-features/export";
import { StudioInspectorGroup } from "./studio-inspector-group";
import { StudioQueryBindings } from "./studio-query-bindings";
import {
  StudioSettingFields,
  type StudioSettingChoices,
  type StudioSettingValues,
  studioSettingProblems,
} from "./studio-setting-controls";

type GroupValue = Extract<SourceBlockPropertyValueContract, { kind: "group" }>;

/** The fields a table shows as columns, as its settings name them. */
const tableColumnFields = (tableSettings: StudioSettingValues): readonly string[] => {
  const columns = tableSettings["columns"];
  if (columns?.kind !== "list") return [];
  return columns.items.flatMap((item) => {
    const field = item.kind === "group" ? item.properties["field"] : undefined;
    return field?.kind === "field_reference" ? [field.field] : [];
  });
};

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
  presentation,
  query,
  compiledFields,
  tableSettings,
  canvasArrangement,
  canvasStale,
  signedIn,
  choices,
  boardChoices,
  related,
  pipelines,
  disabled,
  onChange,
}: Readonly<{
  idPrefix: string;
  /** The table release's `features` group declaration. */
  property: Extract<BlockPropertySchemaContract, { kind: "group" }>;
  /** The authored features group; unset uses the catalogue default (every feature off). */
  value: SourceBlockPropertyValueContract | undefined;
  presentation: "grid" | "cards";
  /** The query the table reads, or undefined until one is chosen. */
  query: StudioQueryChoice | undefined;
  /** The saved draft's compiled fields of the record type the query reads; undefined before a save. */
  compiledFields: readonly ModuleField[] | undefined;
  /** The block's choices: the bound query's fields by business name. */
  tableSettings: StudioSettingValues;
  canvasArrangement?: GroupValue | undefined;
  canvasStale: boolean;
  signedIn: boolean;
  choices: StudioSettingChoices;
  /** Real fields of the selected pipeline's record type, including fields not yet queried. */
  boardChoices: StudioSettingChoices;
  /** What the draft offers the rows' related records. */
  related: StudioRelatedRecordsChoices;
  /** The pipelines of the draft's record types, which a board takes its columns from. */
  pipelines: readonly StudioBoardPipeline[];
  disabled: boolean;
  onChange: (next: SourceBlockPropertyValueContract) => void;
}>): ReactElement {
  const ownId = useId();
  const authored = value?.kind === "group" ? value.properties : {};
  const catalogueDefault = (key: RecordsTableFeatureKey): GroupValue => {
    const declared = property.properties.find((feature) => feature.key === key)?.defaultValue;
    if (declared?.kind !== "group") throw new Error(`Grid feature ${key} has no catalogue default`);
    return declared as GroupValue;
  };
  const featureValue = (key: RecordsTableFeatureKey): GroupValue => {
    const held = authored[key];
    return held?.kind === "group" ? held : catalogueDefault(key);
  };
  const whole: GroupValue = {
    kind: "group",
    properties: Object.fromEntries(recordsTableFeatureKeys.map((key) => [key, featureValue(key)])),
  };
  // A feature whose own settings cannot be read yet, such as a list entry the builder is still
  // filling in, is judged as its catalogue default so it flags only itself: its switch and editor
  // stay open on what was authored, and every other feature keeps its state.
  const incomplete = new Set<RecordsTableFeatureKey>();
  let features: RecordsTableFeatures | undefined;
  for (;;) {
    const read = readRecordsTableFeatures({
      kind: "group",
      properties: Object.fromEntries(
        recordsTableFeatureKeys.map((key) => [
          key,
          incomplete.has(key) ? catalogueDefault(key) : featureValue(key),
        ]),
      ),
    });
    if (read.kind === "read") {
      features = read.features;
      break;
    }
    const key = recordsTableFeatureKeys.find(
      (candidate) =>
        read.path === `features.${candidate}` || read.path.startsWith(`features.${candidate}.`),
    );
    if (key === undefined || incomplete.has(key)) {
      console.error(
        `[grid] studio features editor refused: DATA_GRID_SETTING_UNREADABLE path=${read.path}`,
      );
      break;
    }
    incomplete.add(key);
  }
  const authoredEnabled = (key: RecordsTableFeatureKey): boolean => {
    const enabled = featureValue(key).properties["enabled"];
    return enabled?.kind === "boolean" && enabled.value;
  };
  const authoredPageSize = tableSettings["page_size"];
  const tablePageSize = authoredPageSize?.kind === "number" ? authoredPageSize.value : undefined;
  const rowActions = tableSettings["row_actions"];
  const facts = studioRecordsTableQueryFacts(
    query,
    signedIn,
    choices.actions,
    choices.relationships,
    related,
    tableColumnFields(tableSettings),
    {
      rowActions:
        rowActions?.kind === "list"
          ? rowActions.items.flatMap((item) => {
              const placement = item.kind === "group" ? item.properties["placement"] : undefined;
              return placement?.kind === "choice" ? [{ placement: placement.value }] : [];
            })
          : [],
      viewport:
        tableSettings["viewport"]?.kind === "choice" && tableSettings["viewport"].value === "page"
          ? "page"
          : "bounded",
    },
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

  /** The value a feature's switch writes when it is turned on: its defaults and starting settings. */
  const enabledValue = (key: RecordsTableFeatureKey): GroupValue => {
    const declaration = property.properties.find((feature) => feature.key === key);
    return {
      kind: "group",
      properties: {
        ...(declaration?.defaultValue?.kind === "group" ? declaration.defaultValue.properties : {}),
        ...studioGridFeatureStart(key, facts),
        enabled: { kind: "boolean", value: true },
      },
    };
  };

  /**
   * A board takes its columns from a stage field: with none in the bound query there is nothing an
   * author can set on the board to make it possible, so its switch stays off and says why.
   */
  const boardBlocked =
    features === undefined || (facts.board?.stageFields.length ?? 0) > 0
      ? undefined
      : (() => {
          const read = readRecordsTableFeatures({
            kind: "group",
            properties: {
              ...whole.properties,
              [recordsTableBoardFeature.key]: enabledValue(recordsTableBoardFeature.key),
            },
          });
          if (read.kind !== "read") return undefined;
          const check = checkRecordsTableFeature(
            recordsTableBoardFeature.key,
            recordsTableFeatureState(read.features, recordsTableBoardFeature.key),
            facts,
            presentation,
            read.features,
            tablePageSize,
          );
          return check.kind === "not_possible" ? check.reason : undefined;
        })();

  const viewportCheck =
    features === undefined
      ? undefined
      : checkRecordsTableFeature(
          "viewport",
          { enabled: true },
          facts,
          presentation,
          features,
          tablePageSize,
        );
  return (
    <StudioInspectorGroup title="Features">
      {viewportCheck?.kind === "not_possible" ? (
        <p role="alert" className="text-sm text-destructive">
          {viewportCheck.reason}
        </p>
      ) : null}
      <ItemGroup role="list" aria-label="Table features" className="gap-1">
        {recordsTableFeatureKeys.map((key) => {
          const declaration = property.properties.find((feature) => feature.key === key);
          const { label, description } = recordsTableFeatureDescription(key);
          const enabled = incomplete.has(key)
            ? authoredEnabled(key)
            : features !== undefined && recordsTableFeatureState(features, key).enabled;
          // In Board mode a feature that is off is not judged; one that is on is refused unless the
          // board implements it. An incomplete feature is judged once its settings can be read.
          const check =
            features === undefined ||
            incomplete.has(key) ||
            (features.board.enabled && key !== recordsTableBoardFeature.key && !enabled)
              ? undefined
              : checkRecordsTableFeature(
                  key,
                  recordsTableFeatureState(features, key),
                  facts,
                  presentation,
                  features,
                  tablePageSize,
                );
          const blocked =
            key === recordsTableBoardFeature.key && !enabled ? boardBlocked : undefined;
          const switchId = `${idPrefix}-${ownId}-${key}`;
          const settings =
            declaration?.kind === "group"
              ? declaration.properties.filter((setting) => setting.key !== "enabled")
              : [];
          const current = featureValue(key);
          const fix =
            enabled && (check?.kind === "not_possible" || incomplete.has(key))
              ? studioGridPrerequisites(key, whole, facts)
              : undefined;
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
                    {blocked !== undefined ? (
                      <Badge variant="outline">Not possible</Badge>
                    ) : incomplete.has(key) ? (
                      <Badge variant="outline">Not ready</Badge>
                    ) : check === undefined ? null : check.kind === "available" ? (
                      <Badge
                        variant="outline"
                        className="border-transparent bg-success/10 text-success"
                      >
                        Available
                      </Badge>
                    ) : (
                      <Badge variant="outline">{enabled ? "Not ready" : "Not possible"}</Badge>
                    )}
                  </ItemTitle>
                  <ItemDescription>
                    {blocked ?? (check?.kind === "not_possible" ? check.reason : description)}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {fix === undefined ? null : (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={disabled}
                      aria-label={`Fix ${label}`}
                      onClick={() => {
                        const normalized = typedSourceSettingValue(
                          plainSourceSettingValue(fix),
                          property,
                          [property.key],
                          [],
                        );
                        onChange(normalized ?? fix);
                      }}
                    >
                      Fix
                    </Button>
                  )}
                  <Switch
                    id={switchId}
                    checked={enabled}
                    disabled={disabled || features === undefined || blocked !== undefined}
                    onCheckedChange={(on: boolean) => {
                      // A disabled feature holds only its catalogue default. Its workflow stays
                      // in the draft; the settings command restores that binding when enabled.
                      write(
                        key,
                        on
                          ? enabledValue(key)
                          : (() => {
                              const defaultValue = declaration?.defaultValue;
                              if (defaultValue?.kind !== "group")
                                throw new Error(`Grid feature ${key} has no catalogue default`);
                              return defaultValue as GroupValue;
                            })(),
                      );
                    }}
                  />
                </ItemActions>
              </Item>
              {enabled && declaration !== undefined && check?.kind !== "not_possible"
                ? studioSettingProblems({ [key]: current }, [declaration]).map((sentence) => (
                    <p key={sentence} role="alert" className="text-sm text-destructive">
                      {sentence.replace(`${label}, `, `${label}: `)}
                    </p>
                  ))
                : null}
              {enabled && key === recordsTableSpreadsheetFeature.key ? (
                <StudioSpreadsheetEditor
                  value={current}
                  facts={facts}
                  columns={tableColumnFields(tableSettings)}
                  disabled={disabled}
                  onChange={(next) => write(key, next)}
                />
              ) : null}
              {enabled && key === recordsTableRowEditFeature.key ? (
                <StudioRowEditEditor
                  value={current}
                  facts={facts}
                  columns={tableColumnFields(tableSettings)}
                  disabled={disabled}
                  onChange={(next) => write(key, next)}
                />
              ) : null}
              {enabled && key === recordsTableInlineEditFeature.key ? (
                <StudioInlineEditEditor
                  value={current}
                  facts={facts}
                  columns={tableColumnFields(tableSettings)}
                  disabled={disabled}
                  onChange={(next) => write(key, next)}
                />
              ) : null}
              {enabled &&
              key === recordsTableConditionalFormattingFeature.key &&
              features !== undefined &&
              !incomplete.has(key) ? (
                <div className="pb-2">
                  <StudioConditionalFormattingEditor
                    idPrefix={`${switchId}-editor`}
                    value={current}
                    state={features.conditionalFormatting}
                    // A board's rules read any field of its record type, not only the few its
                    // grouped query selects.
                    query={
                      features.board.enabled && query !== undefined
                        ? { ...query, fields: boardChoices.fields }
                        : query
                    }
                    facts={facts}
                    compiledFields={compiledFields}
                    board={features.board.enabled}
                    disabled={disabled}
                    onChange={(next) => write(key, next)}
                  />
                </div>
              ) : null}
              {enabled && key === recordsTableSavedViewsFeature.key ? (
                <div className="pb-2">
                  <StudioSavedViewsEditor
                    value={current}
                    canvasArrangement={canvasArrangement}
                    canvasStale={canvasStale}
                    roles={choices.roles}
                    disabled={disabled}
                    onChange={(next) => write(key, next)}
                  />
                </div>
              ) : null}
              {enabled && key === recordsTableExportFeature.key ? (
                <StudioExportEditor
                  value={current}
                  disabled={disabled}
                  onChange={(next) => write(key, next)}
                />
              ) : null}
              {enabled && key === recordsTableBoardFeature.key ? (
                <StudioBoardEditor
                  idPrefix={`${switchId}-editor`}
                  value={current}
                  declarations={settings}
                  pipelines={pipelines}
                  choices={{ ...boardChoices, totals: query?.totals ?? [] }}
                  boardFacts={query?.board}
                  disabled={disabled}
                  onChange={(next) => write(key, next)}
                />
              ) : null}
              {!enabled || settings.length === 0 || editor.kind !== "settings" ? null : (
                <div className="space-y-3 pb-2">
                  {(() => {
                    const own =
                      key === recordsTableMasterDetailFeature.key
                        ? relatedSettings(current)
                        : undefined;
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
                                : {
                                    // A board filters over every field of its record type, not only
                                    // the few its grouped query selects; linked records need a
                                    // record picker a board does not draw.
                                    fields: (features?.board.enabled === true &&
                                    key === recordsTableColumnFiltersFeature.key
                                      ? boardChoices.fields.filter(
                                          (field) =>
                                            recordsTableFilterKindOf(field.type) !== "link",
                                        )
                                      : choices.fields
                                    ).filter(editor.offers),
                                  }),
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
