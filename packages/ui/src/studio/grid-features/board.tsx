"use client";

import { useId, type ReactElement } from "react";
import { Trash2 } from "lucide-react";
import type {
  BlockPropertySchemaContract,
  RecordsTableBoardFacts,
  SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import { Button } from "../../components/button";
import { Input } from "../../components/input";
import { Label } from "../../components/label";
import { boardSumAlias, type StudioBoardPipeline } from "../board-source";
import {
  StudioReferencePicker,
  type StudioReferencePickerOption,
} from "../studio-reference-picker";
import {
  StudioOptionControl,
  StudioSettingFields,
  type StudioSettingChoices,
  type StudioSettingValues,
} from "../studio-setting-controls";

type GroupValue = Extract<SourceBlockPropertyValueContract, { kind: "group" }>;

/** The settings the pipeline choice and the totals picker leave to the usual typed controls. */
const cardSettings = ["card_title_field", "card_fields", "wip_limit"] as const;

/** The number field types a column total can add up. */
const summableTypes: readonly string[] = ["whole_number", "decimal_number", "money"];

type TotalRow = Readonly<{ alias: string; label: string }>;

const totalRows = (value: GroupValue): readonly TotalRow[] => {
  const held = value.properties["totals"];
  if (held?.kind !== "list") return [];
  return held.items.flatMap((item) => {
    if (item.kind !== "group") return [];
    const alias = item.properties["alias"];
    const label = item.properties["label"];
    return alias?.kind === "text" && label?.kind === "text"
      ? [{ alias: alias.value, label: label.value }]
      : [];
  });
};

const totalsValue = (rows: readonly TotalRow[]): SourceBlockPropertyValueContract => ({
  kind: "list",
  items: rows.map((row) => ({
    kind: "group",
    properties: {
      alias: { kind: "text", value: row.alias },
      label: { kind: "text", value: row.label },
    },
  })),
});

/**
 * The column totals of a board, each chosen from what the bound query really totals or from a
 * number field of the record type (its sum, added to the query when the board is saved), never
 * typed as an alias. The sums stay server-computed.
 */
function StudioBoardTotals({
  idPrefix,
  rows,
  facts,
  numberFields,
  disabled,
  onChange,
}: Readonly<{
  idPrefix: string;
  rows: readonly TotalRow[];
  facts: RecordsTableBoardFacts | undefined;
  numberFields: StudioSettingChoices["fields"];
  disabled: boolean;
  onChange: (rows: readonly TotalRow[]) => void;
}>): ReactElement {
  const options: StudioReferencePickerOption[] = [
    ...(facts?.aggregates ?? []).map((aggregate) => ({
      value: aggregate.alias,
      label: aggregate.label,
      group: "Totals of the query",
    })),
    ...numberFields
      .filter((field) => summableTypes.includes(field.type))
      .map((field) => ({
        value: boardSumAlias(field.reference.slice(field.reference.lastIndexOf(".") + 1)),
        label: `Sum of ${field.label.slice(field.label.lastIndexOf(": ") + 2)}`,
        group: "Number fields",
      })),
  ].filter(
    (option, index, all) => all.findIndex((other) => other.value === option.value) === index,
  );
  const labelOf = (alias: string): string =>
    options.find((option) => option.value === alias)?.label ?? alias;
  const unchosen = options.filter((option) => !rows.some((row) => row.alias === option.value));
  return (
    <div className="space-y-2" data-vortex-board-totals="">
      <Label htmlFor={`${idPrefix}-add`}>Column totals</Label>
      {rows.map((row, index) => (
        <div key={row.alias} className="flex items-start gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <StudioReferencePicker
              aria-label={`Total ${index + 1}`}
              value={row.alias}
              disabled={disabled}
              options={[...unchosen, ...options.filter((option) => option.value === row.alias)]}
              onChange={(alias) =>
                onChange(
                  rows.map((other, at) =>
                    at === index && alias !== "" ? { alias, label: labelOf(alias) } : other,
                  ),
                )
              }
            />
            <Input
              aria-label={`Label of ${labelOf(row.alias)}`}
              value={row.label}
              disabled={disabled}
              maxLength={60}
              onChange={(event) =>
                onChange(
                  rows.map((other, at) =>
                    at === index ? { ...other, label: event.target.value } : other,
                  ),
                )
              }
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={`Remove ${row.label || labelOf(row.alias)}`}
            onClick={() => onChange(rows.filter((_, at) => at !== index))}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      ))}
      {rows.length >= 6 ? null : (
        <StudioReferencePicker
          id={`${idPrefix}-add`}
          value=""
          disabled={disabled || unchosen.length === 0}
          unset={unchosen.length === 0 ? "Nothing more to total" : "Add a total"}
          options={unchosen}
          onChange={(alias) => {
            if (alias !== "") onChange([...rows, { alias, label: labelOf(alias) }]);
          }}
        />
      )}
      <p className="text-sm text-muted-foreground">
        Each column header shows these totals of its cards, computed on the server.
      </p>
    </div>
  );
}

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
  boardFacts,
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
  /** What the bound query offers a board, so totals are picked from its real totals. */
  boardFacts: RecordsTableBoardFacts | undefined;
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
  const held = (key: string): Readonly<Record<string, SourceBlockPropertyValueContract>> => {
    const setting = value.properties[key];
    return setting === undefined ? {} : { [key]: setting };
  };
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
        <StudioBoardTotals
          idPrefix={`${idPrefix}-${ownId}-totals`}
          rows={totalRows(value)}
          facts={boardFacts}
          numberFields={choices.fields}
          disabled={disabled}
          onChange={(rows) => commit({ ...value.properties, totals: totalsValue(rows) })}
        />
      )}
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
            commit({
              ...next,
              ...(column === undefined ? {} : { column_field: column }),
              ...held("totals"),
            })
          }
        />
      )}
    </div>
  );
}
