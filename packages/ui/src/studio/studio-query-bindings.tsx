"use client";
import { useId } from "react";
import {
  checkQueryBindings,
  currentPersonParts,
  queryInputValueType,
  queryBindingTypeName,
  queryBindingTypesFit,
  readQueryBindings,
  relativeDateAnchors,
  type CurrentPersonPart,
  type QueryBindingSourceKind,
  type RelativeDateAnchor,
  type SourceBlockPropertyValueContract,
  type QueryBindingPageFacts,
} from "@vortex/platform/schema";
import { Badge } from "../components/badge";
import { Input } from "../components/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../components/select";
import { StudioReferencePicker } from "./studio-reference-picker";
import { StudioRecordReferenceControl } from "./studio-record-reference-control";
import type { StudioSettingChoices } from "./studio-setting-controls";
import type { StudioQueryChoice } from "./contextual-palette";

type Value = SourceBlockPropertyValueContract;
const text = (value: string): Value => ({ kind: "text", value });
const partLabels: Record<CurrentPersonPart, string> = {
  person: "Person",
  organisation: "Organisation",
  team: "Team",
};
/**
 * A date and time is written in UTC, as `2026-10-20T09:30`, and kept as an exact instant. An instant
 * stored with another offset is shown as its UTC time, so the next edit keeps the same instant.
 */
const instantToInput = (instant: string): string => {
  const parsed = new Date(instant);
  return Number.isNaN(parsed.getTime()) ? instant.slice(0, 16) : parsed.toISOString().slice(0, 16);
};
/** A fixed source keeps one value: a chosen `record`, or a written `value`, never both. */
const fixedWith = (
  props: Readonly<Record<string, Value>>,
  key: "record" | "value",
  value: Value | undefined,
): Record<string, Value> => ({
  ...Object.fromEntries(
    Object.entries(props).filter(([existing]) => existing !== "record" && existing !== "value"),
  ),
  ...(value === undefined ? {} : { [key]: value }),
});
const inputToInstant = (written: string): string => (written === "" ? "" : `${written}:00Z`);
const choice = (value: string): Value => ({ kind: "choice", value });
const labels: Record<QueryBindingSourceKind, string> = {
  fixed: "Fixed value",
  page_parameter: "Page parameter",
  record_field: "Record field",
  current_person: "Current person",
  control: "Control on this page",
  relative_date: "Relative date",
  this_row: "This row",
};
/** The picker value that binds the row itself rather than one of its fields. */
const ROW_ITSELF = "this-row";
const anchorLabels: Record<RelativeDateAnchor, string> = {
  today: "Today",
  start_of_week: "Start of this week",
  start_of_month: "Start of this month",
  start_of_quarter: "Start of this quarter",
  start_of_year: "Start of this year",
  end_of_month: "End of this month",
};

/** Each edit replaces one input binding through the inspector's ordinary undoable settings command. */
export function StudioQueryBindings({
  query,
  value,
  facts,
  choices,
  disabled,
  onChange,
}: Readonly<{
  query: StudioQueryChoice | undefined;
  value: Value | undefined;
  facts: QueryBindingPageFacts;
  choices: StudioSettingChoices;
  disabled: boolean;
  onChange: (value: Value) => void;
}>) {
  const id = useId();
  if (query === undefined) return null;
  const items = value?.kind === "list" ? value.items : [];
  if (query.inputs.length === 0 && items.length === 0) return null;
  const read = readQueryBindings(value === undefined ? {} : { query_parameters: value });
  const inputs = query.inputs.map((input) => ({ ...input, type: queryInputValueType(input) }));
  const problems = checkQueryBindings(read, inputs, facts);
  return (
    <div className="space-y-4" aria-label="Query inputs">
      {[...problems.filter((problem) => problem.input === undefined), ...facts.pageProblems].map(
        (problem) => (
          <p key={problem.sentence} role="alert" className="text-sm text-destructive">
            {problem.sentence}
          </p>
        ),
      )}
      {inputs.map((input) => {
        const item = items.find(
          (item) =>
            item.kind === "group" &&
            item.properties.input?.kind === "text" &&
            item.properties.input.value === input.key,
        );
        const props = item?.kind === "group" ? item.properties : {};
        const source = props.source?.kind === "choice" ? props.source.value : "";
        const fit = (type: NonNullable<typeof input.type>) =>
          input.type !== undefined && queryBindingTypesFit(input.type, type);
        const fitting = facts.parameters.filter((parameter) => fit(parameter.type));
        // A control's parameter is chosen through the control; the page offers its subject.
        const parameters = fitting.filter((parameter) => parameter.control === undefined);
        const fields = (facts.recordFields ?? []).filter(
          (field) => field.type !== undefined && fit(field.type),
        );
        const controls = facts.controls.filter((control) =>
          fitting.some((parameter) => parameter.name === control.parameter),
        );
        // Inside a row's related records an input may take the row itself or one of its fields.
        const rowItself =
          facts.rowRecordType !== undefined &&
          fit({ kind: "record", recordTypes: [facts.rowRecordType] });
        const rowFields = (facts.rowFields ?? []).filter(
          (field) => field.type !== undefined && fit(field.type),
        );
        // The person's directory record fills a record input; their organisation fills a text one;
        // their team fills a record input of the group directory.
        const personFits =
          facts.currentPersonRecordType !== undefined &&
          fit({ kind: "record", recordTypes: [facts.currentPersonRecordType] });
        const organisationFits = fit({ kind: "text" });
        const teamFits =
          facts.currentTeamRecordType !== undefined &&
          fit({ kind: "record", recordTypes: [facts.currentTeamRecordType] });
        const partsFitting = currentPersonParts.filter((part) =>
          part === "person" ? personFits : part === "organisation" ? organisationFits : teamFits,
        );
        const sources: QueryBindingSourceKind[] = [
          "fixed",
          ...(parameters.length ? ["page_parameter" as const] : []),
          ...(fields.length ? ["record_field" as const] : []),
          ...(controls.length ? ["control" as const] : []),
          ...(partsFitting.length > 0 ? ["current_person" as const] : []),
          ...(input.type?.kind === "date" || input.type?.kind === "date_time"
            ? ["relative_date" as const]
            : []),
          ...(rowItself || rowFields.length ? ["this_row" as const] : []),
        ];
        const change = (properties: Record<string, Value>) =>
          onChange({
            kind: "list",
            items: [
              ...items.filter(
                (entry) =>
                  !(
                    entry.kind === "group" &&
                    entry.properties.input?.kind === "text" &&
                    entry.properties.input.value === input.key
                  ),
              ),
              ...(Object.keys(properties).length
                ? [
                    {
                      kind: "group" as const,
                      properties: { input: text(input.key), ...properties },
                    },
                  ]
                : []),
            ],
          });
        const selectSource = (kind: string | null) => {
          if (kind === null) return;
          if (kind === "unset") {
            change({});
            return;
          }
          const details: Record<string, Value> =
            kind === "fixed"
              ? input.type?.kind === "record"
                ? {}
                : { value: text(input.type?.kind === "yes_no" ? "false" : "") }
              : kind === "page_parameter"
                ? { name: text(parameters[0]!.name) }
                : kind === "record_field"
                  ? { field: { kind: "field_reference", field: fields[0]!.field } }
                  : kind === "control"
                    ? { control_placement: text(controls[0]!.placement) }
                    : kind === "current_person"
                      ? { part: choice(partsFitting[0]!) }
                      : kind === "this_row"
                        ? rowItself
                          ? {}
                          : { field: { kind: "field_reference", field: rowFields[0]!.field } }
                        : { anchor: choice("today"), offset_days: { kind: "number", value: 0 } };
          change({ source: choice(kind), ...details });
        };
        const valueKey =
          source === "page_parameter"
            ? "name"
            : source === "control"
              ? "control_placement"
              : "field";
        const selected = props[valueKey];
        const selection =
          selected?.kind === "text"
            ? selected.value
            : selected?.kind === "field_reference"
              ? selected.field
              : "";
        const options =
          source === "page_parameter"
            ? parameters.map((parameter) => ({ value: parameter.name, label: parameter.label }))
            : source === "control"
              ? controls.map((control) => ({ value: control.placement, label: control.label }))
              : fields.map((field) => ({ value: field.field, label: field.label }));
        const problem = problems.find((problem) => problem.input === input.key)?.sentence;
        return (
          <div key={input.key} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{input.label}</span>
              {input.type !== undefined && (
                <Badge variant="secondary">
                  {queryBindingTypeName(input.type, facts.recordTypeLabel)}
                </Badge>
              )}
              {input.required && <Badge variant="outline">Required</Badge>}
            </div>
            <Select value={source || "unset"} disabled={disabled} onValueChange={selectSource}>
              <SelectTrigger aria-label={`${input.label} source`}>
                <SelectValue>
                  {labels[source as QueryBindingSourceKind] ?? "Choose a source"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unset">Choose a source</SelectItem>
                {sources.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {labels[kind]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {["page_parameter", "control", "record_field"].includes(source) && (
              <StudioReferencePicker
                id={`${id}-${input.key}`}
                aria-label={`${input.label} value`}
                value={selection}
                options={options}
                disabled={disabled}
                onChange={(value) =>
                  change({
                    ...props,
                    [valueKey]:
                      source === "record_field"
                        ? { kind: "field_reference", field: value }
                        : text(value),
                  })
                }
              />
            )}
            {source === "this_row" && rowFields.length > 0 && (
              <StudioReferencePicker
                id={`${id}-${input.key}-row`}
                aria-label={`${input.label} value`}
                value={props.field?.kind === "field_reference" ? props.field.field : ROW_ITSELF}
                options={[
                  ...(rowItself ? [{ value: ROW_ITSELF, label: "The row itself" }] : []),
                  ...rowFields.map((field) => ({ value: field.field, label: field.label })),
                ]}
                disabled={disabled}
                onChange={(value) =>
                  change(
                    Object.fromEntries([
                      ...Object.entries(props).filter(([key]) => key !== "field"),
                      ...(value === ROW_ITSELF || value === ""
                        ? []
                        : [["field", { kind: "field_reference", field: value } as Value]]),
                    ]),
                  )
                }
              />
            )}
            {source === "current_person" && partsFitting.length > 1 && (
              <Select
                disabled={disabled}
                value={props.part?.kind === "choice" ? props.part.value : partsFitting[0]!}
                onValueChange={(value) =>
                  change({ ...props, part: choice(value ?? partsFitting[0]!) })
                }
              >
                <SelectTrigger aria-label={`${input.label} part`}>
                  <SelectValue>
                    {partLabels[
                      (props.part?.kind === "choice"
                        ? props.part.value
                        : partsFitting[0]!) as CurrentPersonPart
                    ] ?? partLabels[partsFitting[0]!]}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {partsFitting.map((part) => (
                    <SelectItem key={part} value={part}>
                      {partLabels[part]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {source === "fixed" &&
              (input.type?.kind === "record" ? (
                <StudioRecordReferenceControl
                  id={`${id}-${input.key}-record`}
                  recordTypes={choices.recordTypes.filter(
                    (record) =>
                      input.type?.kind === "record" && input.type.recordTypes.includes(record.key),
                  )}
                  read={choices.records}
                  disabled={disabled}
                  value={
                    props.record?.kind === "record_reference"
                      ? { recordType: props.record.record_type, recordId: props.record.record_id }
                      : undefined
                  }
                  onChange={(value) =>
                    change(
                      fixedWith(
                        props,
                        "record",
                        value === undefined
                          ? undefined
                          : {
                              kind: "record_reference",
                              record_type: value.recordType,
                              record_id: value.recordId,
                            },
                      ),
                    )
                  }
                />
              ) : input.type?.kind === "yes_no" ? (
                <Select
                  value={props.value?.kind === "text" ? props.value.value : "false"}
                  disabled={disabled}
                  onValueChange={(value) => change(fixedWith(props, "value", text(value ?? "")))}
                >
                  <SelectTrigger aria-label={`${input.label} value`}>
                    <SelectValue>
                      {props.value?.kind === "text" && props.value.value === "true" ? "Yes" : "No"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">Yes</SelectItem>
                    <SelectItem value="false">No</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  aria-label={`${input.label} value`}
                  disabled={disabled}
                  type={
                    input.type?.kind === "date"
                      ? "date"
                      : input.type?.kind === "date_time"
                        ? "datetime-local"
                        : "text"
                  }
                  inputMode={
                    input.type?.kind === "whole_number" || input.type?.kind === "decimal_number"
                      ? "decimal"
                      : "text"
                  }
                  value={
                    props.value?.kind === "text"
                      ? input.type?.kind === "date_time"
                        ? instantToInput(props.value.value)
                        : props.value.value
                      : ""
                  }
                  onChange={(event) =>
                    change(
                      fixedWith(
                        props,
                        "value",
                        text(
                          input.type?.kind === "date_time"
                            ? inputToInstant(event.target.value)
                            : event.target.value,
                        ),
                      ),
                    )
                  }
                />
              ))}
            {source === "fixed" && input.type?.kind === "date_time" && (
              <p className="text-xs text-muted-foreground">Date and time in UTC.</p>
            )}
            {source === "relative_date" && (
              <>
                <Select
                  disabled={disabled}
                  value={props.anchor?.kind === "choice" ? props.anchor.value : "today"}
                  onValueChange={(value) => change({ ...props, anchor: choice(value ?? "today") })}
                >
                  <SelectTrigger aria-label={`${input.label} date`}>
                    <SelectValue>
                      {anchorLabels[
                        (props.anchor?.kind === "choice"
                          ? props.anchor.value
                          : "today") as RelativeDateAnchor
                      ] ?? anchorLabels.today}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {relativeDateAnchors.map((anchor) => (
                      <SelectItem key={anchor} value={anchor}>
                        {anchorLabels[anchor]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  aria-label={`${input.label} offset days`}
                  type="number"
                  step={1}
                  disabled={disabled}
                  value={props.offset_days?.kind === "number" ? props.offset_days.value : 0}
                  onChange={(event) =>
                    change({
                      ...props,
                      offset_days: { kind: "number", value: Number(event.target.value) },
                    })
                  }
                />
              </>
            )}
            {problem !== undefined && (
              <p role="alert" className="text-sm text-destructive">
                {problem}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
