"use client";
import { useId } from "react";
import {
  checkQueryBindings,
  checkPageParameters,
  queryInputValueType,
  queryBindingTypeName,
  queryBindingTypesFit,
  readQueryBindings,
  relativeDateAnchors,
  type QueryBindingSourceKind,
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
const choice = (value: string): Value => ({ kind: "choice", value });
const labels: Record<QueryBindingSourceKind, string> = {
  fixed: "Fixed value",
  page_parameter: "Page parameter",
  record_field: "Record field",
  current_person: "Current person",
  control: "Page control",
  relative_date: "Relative date",
  this_row: "This row",
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
  if (query === undefined || query.inputs.length === 0) return null;
  const items = value?.kind === "list" ? value.items : [];
  const read = readQueryBindings(value === undefined ? {} : { query_parameters: value });
  const inputs = query.inputs.map((input) => ({ ...input, type: queryInputValueType(input) }));
  const problems = read.kind === "read" ? checkQueryBindings(read.bindings, inputs, facts) : [];
  return (
    <div className="space-y-4" aria-label="Query inputs">
      {read.kind === "malformed" && (
        <p role="alert" className="text-sm text-destructive">
          {facts.blockLabel} has an input binding without its source.
        </p>
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
        const parameters = facts.parameters.filter((parameter) => fit(parameter.type));
        const fields = (facts.recordFields ?? []).filter(
          (field) => field.type !== undefined && fit(field.type),
        );
        const controls = facts.controls.filter((control) =>
          parameters.some((parameter) => parameter.name === control.parameter),
        );
        const sources: QueryBindingSourceKind[] = [
          "fixed",
          ...(parameters.length ? ["page_parameter" as const] : []),
          ...(fields.length ? ["record_field" as const] : []),
          ...(controls.length ? ["control" as const] : []),
          ...(input.type?.kind === "person" ? ["current_person" as const] : []),
          ...(input.type?.kind === "date" || input.type?.kind === "date_time"
            ? ["relative_date" as const]
            : []),
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
              ? { value: text(input.type?.kind === "yes_no" ? "false" : "") }
              : kind === "page_parameter"
                ? { name: text(parameters[0]!.name) }
                : kind === "record_field"
                  ? { field: { kind: "field_reference", field: fields[0]!.field } }
                  : kind === "control"
                    ? { control_placement: text(controls[0]!.placement) }
                    : kind === "current_person"
                      ? { part: choice("person") }
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
            ? parameters.map((parameter) => ({ value: parameter.name, label: parameter.name }))
            : source === "control"
              ? controls.map((control) => ({ value: control.placement, label: control.label }))
              : fields.map((field) => ({ value: field.field, label: field.label }));
        const problem = problems.find((problem) => problem.input === input.key)?.sentence;
        return (
          <div key={input.key} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{input.label}</span>
              <Badge variant="secondary">
                {input.type === undefined
                  ? input.type
                  : queryBindingTypeName(input.type, facts.recordTypeLabel)}
              </Badge>
              {input.required && <Badge variant="outline">Required</Badge>}
            </div>
            <Select value={source || "unset"} disabled={disabled} onValueChange={selectSource}>
              <SelectTrigger aria-label={`${input.label} source`}>
                <SelectValue />
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
            {source === "fixed" &&
              (input.type?.kind === "record" && input.type.recordTypes.length === 1 ? (
                <StudioRecordReferenceControl
                  id={`${id}-${input.key}-record`}
                  recordTypes={choices.recordTypes.filter(
                    (record) =>
                      input.type?.kind === "record" && input.type.recordTypes.includes(record.key),
                  )}
                  read={choices.records}
                  disabled={disabled}
                  value={
                    props.value?.kind === "text" && props.value.value !== ""
                      ? { recordType: input.type.recordTypes[0]!, recordId: props.value.value }
                      : undefined
                  }
                  onChange={(value) => change({ ...props, value: text(value?.recordId ?? "") })}
                />
              ) : input.type?.kind === "yes_no" ? (
                <Select
                  value={props.value?.kind === "text" ? props.value.value : "false"}
                  disabled={disabled}
                  onValueChange={(value) => change({ ...props, value: text(value ?? "") })}
                >
                  <SelectTrigger aria-label={`${input.label} value`}>
                    <SelectValue />
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
                  type={input.type?.kind === "date" ? "date" : "text"}
                  inputMode={
                    input.type?.kind === "whole_number" || input.type?.kind === "decimal_number"
                      ? "decimal"
                      : "text"
                  }
                  value={props.value?.kind === "text" ? props.value.value : ""}
                  onChange={(event) => change({ ...props, value: text(event.target.value) })}
                />
              ))}
            {source === "relative_date" && (
              <>
                <Select
                  disabled={disabled}
                  value={props.anchor?.kind === "choice" ? props.anchor.value : "today"}
                  onValueChange={(value) => change({ ...props, anchor: choice(value ?? "today") })}
                >
                  <SelectTrigger aria-label={`${input.label} date`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {relativeDateAnchors.map((anchor) => (
                      <SelectItem key={anchor} value={anchor}>
                        {anchor.replaceAll("_", " ")}
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
      {checkPageParameters(facts.controls).map((problem) => (
        <p key={problem.sentence} role="alert" className="text-sm text-destructive">
          {problem.sentence}
        </p>
      ))}
    </div>
  );
}
