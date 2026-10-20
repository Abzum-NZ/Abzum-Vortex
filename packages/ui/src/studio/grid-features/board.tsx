"use client";

import { useId, type ReactElement } from "react";
import type {
  BlockPropertySchemaContract,
  SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import { Label } from "../../components/label";
import type { StudioBoardPipeline } from "../board-source";
import {
  StudioOptionControl,
  StudioSettingFields,
  type StudioSettingChoices,
  type StudioSettingValues,
} from "../studio-setting-controls";

type GroupValue = Extract<SourceBlockPropertyValueContract, { kind: "group" }>;

/** The settings the pipeline choice leaves to the usual typed controls. */
const cardSettings = ["card_title_field", "card_fields", "totals", "wip_limit"] as const;

/**
 * The Board editor of a Data grid: the pipeline whose stages are the columns, then the card title,
 * up to three card fields, the column totals and the card limit, each picked from the fields of the
 * bound query. Choosing the pipeline also binds the grid to the query that groups by its stage;
 * the capability check beside the switch says what else is missing.
 */
export function StudioBoardEditor({
  idPrefix,
  value,
  declarations,
  pipelines,
  choices,
  disabled,
  onChange,
}: Readonly<{
  idPrefix: string;
  /** The Board feature group as authored, with its switch on. */
  value: GroupValue;
  /** The Board group's declared settings. */
  declarations: readonly BlockPropertySchemaContract[];
  pipelines: readonly StudioBoardPipeline[];
  /** The bound query's fields, by business name. */
  choices: StudioSettingChoices;
  disabled: boolean;
  onChange: (next: GroupValue) => void;
}>): ReactElement {
  const ownId = useId();
  const column = value.properties["column_field"];
  const pipeline =
    column?.kind === "field_reference"
      ? pipelines.find((candidate) => candidate.reference === column.field)
      : undefined;
  const commit = (properties: Readonly<Record<string, SourceBlockPropertyValueContract>>): void =>
    onChange({
      kind: "group",
      properties: { ...properties, enabled: { kind: "boolean", value: true } },
    });
  const settingValues: StudioSettingValues = Object.fromEntries(
    Object.entries(value.properties).filter(([key]) =>
      (cardSettings as readonly string[]).includes(key),
    ),
  );
  const unset =
    pipelines.length === 0
      ? "No pipelines are available. Create one in Data."
      : pipelines.every((candidate) => !candidate.selectable)
        ? (pipelines[0]?.unavailableReason ?? "Choose a pipeline")
        : "Choose a pipeline";
  return (
    <div className="space-y-3 pb-2" data-vortex-board-editor="">
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-${ownId}-pipeline`}>Pipeline</Label>
        <StudioOptionControl
          id={`${idPrefix}-${ownId}-pipeline`}
          disabled={disabled}
          value={pipeline?.reference ?? ""}
          unset={unset}
          options={pipelines.map((entry) => ({
            value: entry.reference,
            label: entry.selectable ? entry.label : `${entry.label} (${entry.unavailableReason})`,
            disabled: !entry.selectable,
          }))}
          onChange={(next) => {
            const chosen = pipelines.find((entry) => entry.reference === next);
            if (chosen?.selectable !== true || chosen.titleField === undefined) return;
            // A pipeline belongs to one record type, so the card fields of another one are dropped.
            commit({
              column_field: { kind: "field_reference", field: chosen.reference },
              card_title_field: { kind: "field_reference", field: chosen.titleField },
            });
          }}
        />
        <p className="text-sm text-muted-foreground">
          Each stage of the pipeline is a column. Moving a card follows the pipeline&apos;s rules
          and permissions.
        </p>
      </div>
      {pipeline === undefined ? null : (
        <StudioSettingFields
          idPrefix={`${idPrefix}-${ownId}-settings`}
          properties={declarations.filter((setting) =>
            (cardSettings as readonly string[]).includes(setting.key),
          )}
          values={settingValues}
          choices={choices}
          disabled={disabled}
          onChange={(next) =>
            commit({ ...next, ...(column === undefined ? {} : { column_field: column }) })
          }
        />
      )}
    </div>
  );
}
