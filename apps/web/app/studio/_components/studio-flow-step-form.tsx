"use client";
import { useState } from "react";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { Icon } from "@vortex/ui";
import { Textarea } from "@vortex/ui/components/textarea";
import type { ConditionNode, FlowFormula, SourceFlow } from "@vortex/platform/schema";
import {
  StudioConditionControls,
  StudioEntryList,
  useStudioEntryKeys,
  StudioOptionControl,
  StudioReferencePicker,
  StudioHelp,
  StudioInspectorGroup,
  describeStudioFlowValue,
  projectStudioFlowCondition,
  studioFlowConditionFormula,
  studioFlowLabel,
  studioWords,
  type StudioConditionValidation,
  type StudioFlowConditionContext,
  type StudioFlowControlDraft,
  type StudioFlowDraftChoices,
  type StudioFlowNamedEntry,
  type StudioFlowPropertyDraft,
  type StudioFlowPropertyField,
  type StudioFlowReferenceChoice,
  type StudioFlowStepDraft,
  type StudioFlowValueSource,
} from "@vortex/ui/studio";
import {
  StudioFlowCalculationControl,
  defaultStudioFlowCalculation,
} from "./studio-flow-calculation";
import { StudioFlowValueControl } from "./studio-flow-value-control";

/**
 * The settings form of one flow step: one typed control per setting the step catalogue declares,
 * and, for a decision, an early end or another control step, the controls of its shape. It edits a
 * step draft only; the inspector puts each change in the draft as one flow command.
 */

type Entry = Readonly<{ name: string; source: StudioFlowValueSource }>;

export type StudioFlowStepFormProps = Readonly<{
  id: string;
  fields: readonly StudioFlowPropertyField[];
  draft: StudioFlowStepDraft;
  controlEntries: readonly StudioFlowNamedEntry[] | undefined;
  calculationReferences: Parameters<typeof StudioFlowCalculationControl>[0]["references"];
  references: readonly StudioFlowReferenceChoice[];
  condition: StudioFlowConditionContext;
  choices: StudioFlowDraftChoices;
  /** The other flows of the same owner, for a Run flow step. */
  flows: readonly SourceFlow[];
  disabled: boolean;
  /**
   * The edited draft, why it cannot go in the draft yet (null when it can), and the setting changed
   * ("control", "description" or a setting key), so typing into one setting is one Undo step.
   */
  onChange: (draft: StudioFlowStepDraft, problem: string | null, setting: string) => void;
}>;

/** Name-value rows: the names this setting expects first, then any others. */
function EntryRows({
  id,
  label,
  entries,
  expected,
  references,
  disabled,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  entries: readonly Entry[];
  expected: readonly StudioFlowNamedEntry[] | undefined;
  references: readonly StudioFlowReferenceChoice[];
  disabled: boolean;
  onChange: (entries: readonly Entry[]) => void;
}>) {
  const { keys, newKey } = useStudioEntryKeys(entries.length);
  const named = expected ?? [];
  const extra = entries.filter(
    (entry) => !named.some((expectedEntry) => expectedEntry.name === entry.name),
  );
  const set = (name: string, source: StudioFlowValueSource | null) => {
    const others = entries.filter((entry) => entry.name !== name);
    const existingKey = keys.current[entries.findIndex((entry) => entry.name === name)];
    keys.current = keys.current.filter((_, index) => entries[index]!.name !== name);
    if (source !== null) keys.current.push(existingKey ?? newKey());
    onChange(source === null ? others : [...others, { name, source }]);
  };
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{label}</legend>
      {named.map((entry) => (
        <StudioFlowValueControl
          key={entry.name}
          id={`${id}-${entry.name}`}
          disabled={disabled}
          label={entry.label}
          optional={!entry.required}
          valueType={entry.type}
          references={references}
          value={entries.find((candidate) => candidate.name === entry.name)?.source ?? null}
          unset="Not given"
          onChange={(source) => set(entry.name, source)}
        />
      ))}
      <StudioEntryList
        label={`${label}: other entries`}
        itemName="entry"
        disabled={disabled}
        items={extra.map((entry, index) => ({
          key: keys.current[entries.indexOf(entry)]!,
          title: studioWords(entry.name),
          summary: describeStudioFlowValue(entry.source, references),
          content: (
            <>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-extra-${index}-name`}>Name</Label>
                <Input
                  id={`${id}-extra-${index}-name`}
                  disabled={disabled}
                  value={entry.name}
                  onChange={(event) =>
                    onChange(
                      entries.map((candidate) =>
                        candidate === entry ? { ...entry, name: event.target.value } : candidate,
                      ),
                    )
                  }
                />
              </div>
              <StudioFlowValueControl
                id={`${id}-extra-${index}`}
                label="Value"
                valueType={undefined}
                references={references}
                value={entry.source}
                disabled={disabled}
                onChange={(source) => {
                  if (source === null) set(entry.name, null);
                  else
                    onChange(
                      entries.map((candidate) =>
                        candidate === entry ? { ...entry, source } : candidate,
                      ),
                    );
                }}
              />
            </>
          ),
        }))}
        onRemove={(index) => {
          const entry = extra[index];
          if (entry !== undefined) set(entry.name, null);
        }}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => {
            keys.current.push(newKey());
            onChange([
              ...entries,
              {
                name: `entry_${entries.length + 1}`,
                source: { kind: "fixed", literal: { type: "text", value: "" } },
              },
            ]);
          }}
        >
          <Icon name="plus" />
          Add an entry
        </Button>
      </StudioEntryList>
    </fieldset>
  );
}

/** Field values: one value that holds them all (a form's answers), or the fields one by one. */
function FieldValues({
  id,
  field,
  value,
  references,
  disabled,
  onChange,
}: Readonly<{
  id: string;
  field: StudioFlowPropertyField;
  value: StudioFlowPropertyDraft | null;
  references: readonly StudioFlowReferenceChoice[];
  disabled: boolean;
  onChange: (value: StudioFlowPropertyDraft) => void;
}>) {
  const fields = field.fields ?? [];
  const mode = value?.kind === "fields" ? "fields" : "whole";
  const entries = value?.kind === "fields" ? value.entries : [];
  const unused = fields.filter(
    (candidate) => !entries.some((entry) => entry.field === candidate.key),
  );
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">
        {field.label}
        {!field.required && <span className="text-xs text-muted-foreground"> Optional</span>}
      </legend>
      <StudioOptionControl
        id={`${id}-mode`}
        aria-label={`${field.label}: how they are given`}
        disabled={disabled}
        value={mode}
        options={[
          { value: "whole", label: "All of them from one value, such as a form's answers" },
          { value: "fields", label: "Field by field" },
        ]}
        onChange={(next) =>
          onChange(
            next === "fields"
              ? { kind: "fields", entries: [] }
              : {
                  kind: "whole",
                  source: references.find((choice) => choice.type === "json")
                    ? {
                        kind: "reference",
                        reference: references.find((choice) => choice.type === "json")!.reference,
                      }
                    : { kind: "fixed", literal: { type: "text", value: "" } },
                },
          )
        }
      />
      {value?.kind === "whole" && (
        <StudioFlowValueControl
          id={`${id}-whole`}
          label="The values come from"
          valueType="json"
          references={references}
          value={value.source}
          disabled={disabled}
          onChange={(source) => {
            if (source !== null) onChange({ kind: "whole", source });
          }}
        />
      )}
      {value?.kind === "kept" && (
        <p className="text-sm text-muted-foreground">
          {describeStudioFlowValue({ kind: "kept", value: value.value }, references)}. It is kept
          until you choose how the values are given.
        </p>
      )}
      {mode === "fields" && (
        <>
          {fields.length === 0 && (
            <p role="alert" className="text-sm text-destructive">
              Choose the record type first; its fields are listed here.
            </p>
          )}
          {entries.length === 0 && fields.length > 0 && <StudioHelp hint="No field is set yet." />}
          <StudioEntryList
            label={field.label}
            itemName="field"
            disabled={disabled}
            items={entries.map((entry) => {
              const target = fields.find((candidate) => candidate.key === entry.field);
              return {
                key: entry.field,
                title:
                  target?.label ?? `${studioWords(entry.field)} (not a field of this record type)`,
                summary: describeStudioFlowValue(entry.source, references),
                invalid: target === undefined,
                content: (
                  <StudioFlowValueControl
                    id={`${id}-${entry.field}`}
                    label="Set to"
                    valueType={target?.valueType}
                    options={target?.options ?? []}
                    references={references}
                    value={entry.source}
                    disabled={disabled}
                    onChange={(source) => {
                      if (source !== null)
                        onChange({
                          kind: "fields",
                          entries: entries.map((candidate) =>
                            candidate === entry ? { ...entry, source } : candidate,
                          ),
                        });
                    }}
                  />
                ),
              };
            })}
            onRemove={(index) =>
              onChange({
                kind: "fields",
                entries: entries.filter((_, position) => position !== index),
              })
            }
          />
          {unused.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-add`}>Set another field</Label>
              <StudioReferencePicker
                id={`${id}-add`}
                value=""
                unset="Choose a field…"
                disabled={disabled}
                options={unused.map((candidate) => ({
                  value: candidate.key,
                  label: candidate.label,
                }))}
                onChange={(key) => {
                  const chosen = fields.find((candidate) => candidate.key === key);
                  if (chosen === undefined) return;
                  const source: StudioFlowValueSource =
                    chosen.options[0] !== undefined
                      ? {
                          kind: "fixed",
                          literal: { type: "choice", value: chosen.options[0].value },
                        }
                      : chosen.valueType === "yes_no"
                        ? { kind: "fixed", literal: { type: "yes_no", value: false } }
                        : { kind: "fixed", literal: { type: "text", value: "" } };
                  onChange({ kind: "fields", entries: [...entries, { field: key, source }] });
                }}
              />
            </div>
          )}
        </>
      )}
    </fieldset>
  );
}

const pickerOptions = (
  field: StudioFlowPropertyField,
  choices: StudioFlowDraftChoices,
  flows: readonly SourceFlow[],
) => {
  switch (field.control) {
    case "record_type":
      return choices.recordTypes.map((entry) => ({ value: entry.key, label: entry.label }));
    case "page":
      return choices.pages.map((entry) => ({ value: entry.key, label: entry.label }));
    case "form":
      return choices.forms.map((entry) => ({ value: entry.alias, label: entry.label }));
    case "query":
      return choices.queries.map((entry) => ({ value: entry.key, label: entry.label }));
    case "operation":
      return choices.actions.map((entry) => ({ value: entry.key, label: entry.label }));
    case "connection":
      return choices.connections.map((entry) => ({ value: entry.key, label: entry.label }));
    case "flow":
      return flows.map((flow) => ({ value: flow.id, label: studioFlowLabel(flow) }));
    case "field":
      return field.options;
    default:
      return undefined;
  }
};

function PropertyControl({
  id,
  field,
  value,
  references,
  choices,
  flows,
  calculationReferences,
  disabled,
  onChange,
}: Readonly<{
  id: string;
  field: StudioFlowPropertyField;
  value: StudioFlowPropertyDraft | null;
  references: readonly StudioFlowReferenceChoice[];
  choices: StudioFlowDraftChoices;
  flows: readonly SourceFlow[];
  calculationReferences: StudioFlowStepFormProps["calculationReferences"];
  disabled: boolean;
  onChange: (value: StudioFlowPropertyDraft | null) => void;
}>) {
  const label = field.label;
  const unset = field.required
    ? undefined
    : field.key === "record"
      ? "Nothing: create a new record"
      : "Not set";
  if (value?.kind === "kept" && field.control !== "field_values")
    return (
      <div className="space-y-1 text-sm">
        <p className="font-medium">{field.label}</p>
        <p className="text-muted-foreground">
          {describeStudioFlowValue({ kind: "kept", value: value.value }, references)}. It is kept
          until it is changed with Import from source in the Releases tab.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          Replace it
        </Button>
      </div>
    );
  switch (field.control) {
    case "value":
    case "message":
      return (
        <StudioFlowValueControl
          id={id}
          label={label}
          optional={!field.required}
          valueType={field.valueType}
          references={references}
          long={field.control === "message"}
          value={value?.kind === "value" ? value.source : null}
          {...(unset === undefined ? {} : { unset })}
          disabled={disabled}
          onChange={(source) => onChange(source === null ? null : { kind: "value", source })}
        />
      );
    case "calculation":
      return (
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{label}</p>
          <StudioFlowCalculationControl
            id={id}
            disabled={disabled}
            references={calculationReferences}
            value={value?.kind === "calculation" ? value.calculation : defaultStudioFlowCalculation}
            onChange={(calculation) => onChange({ kind: "calculation", calculation })}
          />
        </div>
      );
    case "field_values":
      return (
        <FieldValues
          id={id}
          field={field}
          value={value}
          references={references}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case "input_map":
      if (value?.kind === "whole")
        return (
          <div className="space-y-2">
            <StudioFlowValueControl
              id={id}
              label={label}
              optional={!field.required}
              value={value.source}
              valueType="json"
              references={references}
              {...(unset === undefined ? {} : { unset })}
              disabled={disabled}
              onChange={(source) => onChange(source === null ? null : { kind: "whole", source })}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => onChange({ kind: "map", entries: [] })}
            >
              Set each value by name
            </Button>
          </div>
        );
      return (
        <EntryRows
          id={id}
          label={label}
          entries={value?.kind === "map" ? value.entries : []}
          expected={field.entries}
          references={references}
          disabled={disabled}
          onChange={(entries) =>
            onChange(entries.length === 0 && !field.required ? null : { kind: "map", entries })
          }
        />
      );
    default: {
      const text = value?.kind === "text" ? value.value : "";
      const options = pickerOptions(field, choices, flows);
      return (
        <div className="space-y-1.5">
          <Label htmlFor={id}>
            {label}
            {!field.required && <span className="text-xs text-muted-foreground">Optional</span>}
          </Label>
          {options === undefined ? (
            <Input
              id={id}
              disabled={disabled}
              value={text}
              onChange={(event) =>
                onChange(
                  event.target.value === "" && !field.required
                    ? null
                    : { kind: "text", value: event.target.value },
                )
              }
            />
          ) : (
            <StudioReferencePicker
              id={id}
              disabled={disabled}
              value={text}
              options={options}
              unset={unset ?? (options.length === 0 ? "Nothing to choose from yet" : "Choose…")}
              onChange={(next) => onChange(next === "" ? null : { kind: "text", value: next })}
            />
          )}
        </div>
      );
    }
  }
}

function ConditionControl({
  id,
  condition,
  context,
  disabled,
  onChange,
}: Readonly<{
  id: string;
  condition: FlowFormula;
  context: StudioFlowConditionContext;
  disabled: boolean;
  onChange: (condition: FlowFormula, problem: string | null) => void;
}>) {
  const projected = projectStudioFlowCondition(condition, context);
  // The tree being edited stays here while a comparison is unfinished; the step keeps its last whole condition.
  const [tree, setTree] = useState<ConditionNode | undefined>(
    projected.kind === "condition" ? projected.condition : undefined,
  );
  const [replaced, setReplaced] = useState(false);
  // The condition this tree stands for; another one (Undo, Redo) shows that one instead.
  const [shown, setShown] = useState(condition);
  if (JSON.stringify(shown) !== JSON.stringify(condition)) {
    setShown(condition);
    setTree(projected.kind === "condition" ? projected.condition : undefined);
    setReplaced(false);
  }
  if (projected.kind === "unsupported" && !replaced)
    return (
      <div className="space-y-2 text-sm" id={id}>
        <p role="alert">
          This condition reads values this step can no longer read, or uses a calculation the
          condition controls do not show. Change it with Import from source in the Releases tab, or
          replace it below.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => {
            setReplaced(true);
            setTree(undefined);
            setShown(condition);
            onChange(condition, "Set a condition before replacing this one.");
          }}
        >
          Replace it with a new condition
        </Button>
      </div>
    );
  const change = (next: ConditionNode | undefined, validation: StudioConditionValidation) => {
    setTree(next);
    const formula = studioFlowConditionFormula(next, context);
    if (next === undefined || !validation.isValid || formula === undefined)
      onChange(
        condition,
        "Condition: finish every comparison, with a value on both sides, and the step takes it.",
      );
    else {
      setShown(formula);
      onChange(formula, null);
    }
  };
  return (
    <fieldset className="space-y-2" id={id} disabled={disabled}>
      <legend className="text-sm font-medium">Condition</legend>
      {tree === undefined && (
        <StudioHelp hint="Set a condition. The step keeps its saved condition until this is complete." />
      )}
      <StudioConditionControls
        {...(tree === undefined ? {} : { value: tree })}
        context={context.controls}
        label="Condition"
        onChange={change}
      />
    </fieldset>
  );
}

function ControlForm({
  id,
  control,
  entries,
  references,
  condition,
  choices,
  flows,
  disabled,
  onChange,
}: Readonly<{
  id: string;
  control: StudioFlowControlDraft;
  entries: readonly StudioFlowNamedEntry[] | undefined;
  references: readonly StudioFlowReferenceChoice[];
  condition: StudioFlowConditionContext;
  choices: StudioFlowDraftChoices;
  flows: readonly SourceFlow[];
  disabled: boolean;
  onChange: (control: StudioFlowControlDraft, problem: string | null) => void;
}>) {
  const { keys: caseKeys } = useStudioEntryKeys(
    control.kind === "switch" ? control.cases.length : 0,
  );
  const keep = (
    source: StudioFlowValueSource | null,
    apply: (source: StudioFlowValueSource) => StudioFlowControlDraft,
  ) => {
    if (source !== null) onChange(apply(source), null);
  };
  switch (control.kind) {
    case "if":
      return (
        <ConditionControl
          id={id}
          condition={control.condition}
          context={condition}
          disabled={disabled}
          onChange={(formula, problem) => onChange({ kind: "if", condition: formula }, problem)}
        />
      );
    case "stop":
      return (
        <div className="space-y-1.5">
          <Label htmlFor={id}>Outcome</Label>
          <Input
            id={id}
            disabled={disabled}
            value={control.outcome}
            onChange={(event) => onChange({ kind: "stop", outcome: event.target.value }, null)}
          />
          <StudioHelp hint="A short name for how the flow ended, such as cancelled." />
        </div>
      );
    case "run_flow":
      return (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={id}>Flow</Label>
            <StudioReferencePicker
              id={id}
              disabled={disabled}
              value={control.flow}
              options={flows.map((flow) => ({ value: flow.id, label: studioFlowLabel(flow) }))}
              onChange={(flow) => onChange({ ...control, flow }, null)}
            />
          </div>
          <EntryRows
            id={`${id}-inputs`}
            label="Inputs"
            entries={control.inputs}
            expected={entries}
            references={references}
            disabled={disabled}
            onChange={(inputs) => onChange({ ...control, inputs }, null)}
          />
        </div>
      );
    case "for_each":
      return (
        <div className="space-y-4">
          <StudioFlowValueControl
            id={`${id}-items`}
            label="Items"
            valueType={undefined}
            references={references}
            value={control.items}
            disabled={disabled}
            onChange={(source) => keep(source, (items) => ({ ...control, items }))}
          />
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-most`}>Most items</Label>
            <Input
              id={`${id}-most`}
              inputMode="numeric"
              disabled={disabled}
              value={String(control.maximumItems)}
              onChange={(event) =>
                onChange({ ...control, maximumItems: Number(event.target.value) }, null)
              }
            />
          </div>
        </div>
      );
    case "switch":
      return (
        <div className="space-y-4">
          <StudioFlowValueControl
            id={`${id}-value`}
            label="Chooses by"
            valueType={undefined}
            references={references}
            value={control.value}
            disabled={disabled}
            onChange={(source) => keep(source, (value) => ({ ...control, value }))}
          />
          <StudioEntryList
            label="Cases"
            itemName="case"
            disabled={disabled}
            items={control.cases.map((entry, index) => {
              const when =
                typeof entry.when.value === "string"
                  ? entry.when.value
                  : JSON.stringify(entry.when.value);
              return {
                key: caseKeys.current[index]!,
                title: entry.key === "" ? `Case ${index + 1}` : studioWords(entry.key),
                summary: when === "" ? undefined : `When the value is ${when}`,
                content: (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor={`${id}-case-${index}`}>Name</Label>
                      <Input
                        id={`${id}-case-${index}`}
                        disabled={disabled}
                        value={entry.key}
                        onChange={(event) =>
                          onChange(
                            {
                              ...control,
                              cases: control.cases.map((candidate, at) =>
                                at === index
                                  ? { ...candidate, key: event.target.value }
                                  : candidate,
                              ),
                            },
                            null,
                          )
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`${id}-when-${index}`}>When the value is</Label>
                      <Input
                        id={`${id}-when-${index}`}
                        disabled={disabled}
                        value={when}
                        onChange={(event) =>
                          onChange(
                            {
                              ...control,
                              cases: control.cases.map((candidate, at) =>
                                at === index
                                  ? {
                                      ...candidate,
                                      when: { type: "text", value: event.target.value },
                                    }
                                  : candidate,
                              ),
                            },
                            null,
                          )
                        }
                      />
                    </div>
                  </>
                ),
              };
            })}
          />
        </div>
      );
    case "wait_until":
      return (
        <StudioFlowValueControl
          id={id}
          label="Until"
          valueType="date_time"
          references={references}
          value={control.until}
          disabled={disabled}
          onChange={(source) => keep(source, (until) => ({ ...control, until }))}
        />
      );
    case "wait_for_person":
      return (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={id}>Form</Label>
            <StudioReferencePicker
              id={id}
              disabled={disabled}
              value={control.form}
              options={choices.forms.map((form) => ({ value: form.alias, label: form.label }))}
              onChange={(form) => onChange({ ...control, form }, null)}
            />
          </div>
          <StudioFlowValueControl
            id={`${id}-assignee`}
            label="Who answers"
            valueType="organization_account_reference"
            references={references}
            value={control.assignee}
            disabled={disabled}
            onChange={(source) => keep(source, (assignee) => ({ ...control, assignee }))}
          />
          <EntryRows
            id={`${id}-inputs`}
            label="Starting answers"
            entries={control.inputs}
            expected={entries}
            references={references}
            disabled={disabled}
            onChange={(inputs) => onChange({ ...control, inputs }, null)}
          />
        </div>
      );
    case "none":
      return (
        <StudioHelp hint="This step only groups the steps of its branches; add steps to them on the canvas." />
      );
  }
}

export function StudioFlowStepForm({
  id,
  fields,
  draft,
  controlEntries,
  calculationReferences,
  references,
  condition,
  choices,
  flows,
  disabled,
  onChange,
}: StudioFlowStepFormProps) {
  return (
    <div className="space-y-4">
      {draft.control !== null && (
        <ControlForm
          id={`${id}-control`}
          control={draft.control}
          entries={controlEntries}
          references={references}
          condition={condition}
          choices={choices}
          flows={flows}
          disabled={disabled}
          onChange={(control, problem) => onChange({ ...draft, control }, problem, "control")}
        />
      )}
      {fields.map((field) => (
        <div key={field.key} className="space-y-1" data-vortex-setting={field.key}>
          <PropertyControl
            id={`${id}-${field.key}`}
            field={field}
            disabled={disabled}
            value={Object.hasOwn(draft.properties, field.key) ? draft.properties[field.key]! : null}
            references={references}
            choices={choices}
            flows={flows}
            calculationReferences={calculationReferences}
            onChange={(value) =>
              onChange(
                { ...draft, properties: { ...draft.properties, [field.key]: value } },
                null,
                field.key,
              )
            }
          />
          {field.help === undefined ? null : <StudioHelp hint={field.help} />}
        </div>
      ))}
      <StudioInspectorGroup title="Description">
        <Label htmlFor={`${id}-description`}>
          Description <span className="text-xs text-muted-foreground">Optional</span>
        </Label>
        <Textarea
          id={`${id}-description`}
          disabled={disabled}
          maxLength={1_000}
          value={draft.description}
          onChange={(event) =>
            onChange({ ...draft, description: event.target.value }, null, "description")
          }
        />
        <StudioHelp hint="Shown on the canvas in place of the step's summary." />
      </StudioInspectorGroup>
    </div>
  );
}
