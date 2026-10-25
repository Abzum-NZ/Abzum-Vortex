"use client";
import { useEffect, useState } from "react";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { flowStandardEventKindSchema, workflowValueTypeSchema } from "@vortex/platform/schema";
import {
  StudioEntryList,
  useStudioEntryKeys,
  StudioOptionControl,
  StudioReferencePicker,
  StudioHelp,
  StudioInspectorGroup,
  studioWords,
  type StudioFlowBindingInputDraft,
  type StudioFlowInputDraft,
  type StudioFlowStartDraft,
  type StudioFlowStartProjection,
  type StudioFlowTriggerDraft,
} from "@vortex/ui/studio";
import { StudioField } from "./studio-field";
import { useStudioDraftText } from "./use-studio-draft-text";

/**
 * The Start node's inspector: how the flow starts. Its name, the inputs it declares, the record it
 * runs for, where each input comes from when a control starts it, and its record triggers. Each
 * change is one flow edit, taken by the draft as it is made; text that is not valid yet stays in its
 * control with the problem.
 */

const typeLabels: Readonly<Record<string, string>> = {
  text: "Text",
  formatted_text: "Formatted text",
  whole_number: "Whole number",
  decimal_number: "Decimal number",
  money: "Money",
  yes_no: "Yes or no",
  date: "Date",
  date_time: "Date and time",
  choice: "Choice",
  several_choices: "Several choices",
  record_reference: "A record",
  record_reference_list: "Several records",
  organization_account_reference: "A person",
  workflow_run_reference: "A flow run",
  relationship_reference: "A link between records",
  relationship_reference_list: "Links between records",
  file_reference: "A file",
  json: "A set of values (such as a form's answers)",
};

const eventLabels: Readonly<Record<string, string>> = {
  created: "is created",
  changed: "is changed",
  deleted: "is deleted",
  linked: "is linked",
  unlinked: "is unlinked",
  reassigned: "is reassigned",
  state_changed: "moves to another state",
};

const sourceToken = (value: StudioFlowBindingInputDraft): string =>
  value.kind === "caller" ? `caller:${value.name}` : value.kind === "fixed" ? "fixed" : "";

/** Puts an edited start in the draft; `setting` names the text being typed, so its keystrokes are one Undo step. */
type StartApply = (draft: StudioFlowStartDraft, setting?: string) => true | string;

/** One text of the start, in the draft as it is typed. */
function StartText({
  label,
  value,
  disabled,
  maxLength,
  numeric = false,
  apply,
}: Readonly<{
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  maxLength?: number;
  numeric?: boolean;
  apply: (next: string) => true | string;
}>) {
  const text = useStudioDraftText(value, apply);
  return (
    <StudioField label={label} error={text.problem || undefined} onUndo={text.reset}>
      {(control) => (
        <Input
          {...control}
          disabled={disabled}
          maxLength={maxLength}
          inputMode={numeric ? "numeric" : undefined}
          value={text.text}
          onChange={(event) => text.change(event.target.value)}
        />
      )}
    </StudioField>
  );
}

function TriggerEditor({
  id,
  trigger,
  recordTypes,
  events,
  actions,
  disabled,
  onChange,
}: Readonly<{
  id: string;
  trigger: StudioFlowTriggerDraft;
  recordTypes: readonly Readonly<{ key: string; label: string }>[];
  events: readonly Readonly<{ key: string; label: string; recordType: string }>[];
  actions: readonly Readonly<{ key: string; label: string; recordType: string }>[];
  disabled: boolean;
  onChange: (trigger: StudioFlowTriggerDraft, setting?: string) => true | string;
}>) {
  // The message name is what senders address, so it stays as it was created.
  if (trigger.kind === "incoming_message")
    return (
      <div className="space-y-1 text-sm">
        <p className="font-medium">When this message arrives</p>
        <p className="text-muted-foreground">{trigger.messageName}</p>
      </div>
    );
  if (trigger.kind === "schedule") {
    const recurrence = trigger.recurrence;
    const number = (
      key: "interval" | "hour" | "minute" | "weekDay" | "monthDay",
      label: string,
    ) => (
      <StartText
        key={key}
        id={`${id}-${key}`}
        label={label}
        numeric
        disabled={disabled}
        value={String(recurrence[key])}
        apply={(text) =>
          /^\d+$/.test(text)
            ? onChange(
                { ...trigger, recurrence: { ...recurrence, [key]: Number(text) } },
                `${id}-${key}`,
              )
            : `${label}: enter a whole number.`
        }
      />
    );
    return (
      <div className="space-y-3">
        <Label htmlFor={`${id}-cadence`}>Repeat</Label>
        <StudioOptionControl
          id={`${id}-cadence`}
          disabled={disabled}
          value={recurrence.cadence}
          options={(["hourly", "daily", "weekly", "monthly"] as const).map((cadence) => ({
            value: cadence,
            label: studioWords(cadence),
          }))}
          onChange={(next) => {
            const cadence = next as typeof recurrence.cadence;
            onChange({
              ...trigger,
              recurrence: {
                cadence,
                interval: recurrence.interval,
                timeZone: recurrence.timeZone,
                minute: recurrence.minute,
                ...(cadence === "hourly" ? {} : { hour: recurrence.hour ?? 9 }),
                ...(cadence === "weekly" ? { weekDay: recurrence.weekDay ?? 1 } : {}),
                ...(cadence === "monthly" ? { monthDay: recurrence.monthDay ?? 1 } : {}),
              },
            });
          }}
        />
        {number("interval", "Repeat every")}
        <StartText
          id={`${id}-zone`}
          label="Time zone"
          disabled={disabled}
          value={recurrence.timeZone}
          apply={(timeZone) => {
            try {
              new Intl.DateTimeFormat("en", { timeZone });
            } catch {
              return "Choose a time zone such as Pacific/Auckland.";
            }
            return onChange({ ...trigger, recurrence: { ...recurrence, timeZone } }, `${id}-zone`);
          }}
        />
        {recurrence.cadence !== "hourly" && number("hour", "Hour (0 to 23)")}
        {number("minute", "Minute (0 to 59)")}
        {recurrence.cadence === "weekly" && (
          <>
            <Label htmlFor={`${id}-weekday`}>Day of the week</Label>
            <StudioOptionControl
              id={`${id}-weekday`}
              disabled={disabled}
              value={String(recurrence.weekDay)}
              options={[
                "Monday",
                "Tuesday",
                "Wednesday",
                "Thursday",
                "Friday",
                "Saturday",
                "Sunday",
              ].map((label, index) => ({ value: String(index + 1), label }))}
              onChange={(weekDay) =>
                onChange({ ...trigger, recurrence: { ...recurrence, weekDay: Number(weekDay) } })
              }
            />
          </>
        )}
        {recurrence.cadence === "monthly" && number("monthDay", "Day of the month (1 to 31)")}
      </div>
    );
  }
  const recordType = (
    <div className="space-y-1.5">
      <Label htmlFor={`${id}-record`}>Record type</Label>
      <StudioReferencePicker
        id={`${id}-record`}
        disabled={disabled}
        value={trigger.recordType}
        options={recordTypes.map((entry) => ({ value: entry.key, label: entry.label }))}
        onChange={(next) =>
          // An event or action belongs to one record type, so a new record type drops the old ones.
          onChange(
            trigger.kind === "declared_event"
              ? {
                  ...trigger,
                  recordType: next,
                  eventKey: events.find((event) => event.recordType === next)?.key ?? "",
                }
              : trigger.kind === "before_save"
                ? {
                    ...trigger,
                    recordType: next,
                    actions: trigger.actions.filter((key) =>
                      actions.some((entry) => entry.key === key && entry.recordType === next),
                    ),
                  }
                : { ...trigger, recordType: next },
          )
        }
      />
    </div>
  );
  if (trigger.kind === "declared_event")
    return (
      <div className="space-y-3">
        {recordType}
        <Label htmlFor={`${id}-event`}>After this event</Label>
        <StudioReferencePicker
          id={`${id}-event`}
          disabled={disabled}
          value={trigger.eventKey}
          options={events
            .filter((event) => event.recordType === trigger.recordType)
            .map((event) => ({ value: event.key, label: event.label }))}
          onChange={(eventKey) => onChange({ ...trigger, eventKey })}
        />
      </div>
    );
  if (trigger.kind === "event")
    return (
      <div className="space-y-2">
        {recordType}
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-event`}>After the record</Label>
          <StudioOptionControl
            id={`${id}-event`}
            disabled={disabled}
            value={trigger.eventKind}
            options={flowStandardEventKindSchema.options.map((kind) => ({
              value: kind,
              label: eventLabels[kind] ?? studioWords(kind),
            }))}
            onChange={(eventKind) => onChange({ ...trigger, eventKind })}
          />
        </div>
      </div>
    );
  return (
    <div className="space-y-2">
      {recordType}
      {trigger.actions.map((action, index) => (
        <div key={index} className="space-y-1.5">
          <Label htmlFor={`${id}-action-${index}`}>Before this action</Label>
          <StudioReferencePicker
            id={`${id}-action-${index}`}
            disabled={disabled}
            value={action}
            options={actions
              .filter((entry) => entry.recordType === trigger.recordType)
              .map((entry) => ({ value: entry.key, label: entry.label }))}
            onChange={(next) =>
              onChange({
                ...trigger,
                actions: trigger.actions.map((entry, at) => (at === index ? next : entry)),
              })
            }
          />
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-create`}
          disabled={disabled}
          checked={trigger.create}
          onCheckedChange={(checked) => onChange({ ...trigger, create: checked === true })}
        />
        <Label htmlFor={`${id}-create`}>Before it is created</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-update`}
          disabled={disabled}
          checked={trigger.update}
          onCheckedChange={(checked) => onChange({ ...trigger, update: checked === true })}
        />
        <Label htmlFor={`${id}-update`}>Before it is changed</Label>
      </div>
      <StartText
        id={`${id}-priority`}
        label="Order among the record's rules (0 to 1000, lower runs first)"
        numeric
        disabled={disabled}
        value={String(trigger.priority)}
        apply={(next) =>
          /^\d+$/.test(next.trim())
            ? onChange({ ...trigger, priority: Number(next.trim()) }, `${id}-priority`)
            : "How it starts, order: use a whole number from 0 to 1000."
        }
      />
    </div>
  );
}

/** The settings of one declared input, shown in its row of the Inputs list. */
function InputSettings({
  id,
  input,
  recordTypes,
  disabled,
  onChange,
}: Readonly<{
  id: string;
  input: StudioFlowInputDraft;
  recordTypes: readonly Readonly<{ key: string; label: string }>[];
  disabled: boolean;
  onChange: (input: StudioFlowInputDraft, setting?: string) => true | string;
}>) {
  // Choosing a record kind needs a second choice before the input is complete enough to apply.
  const [type, setType] = useState(input.type);
  useEffect(() => setType(input.type), [input.type, input.recordType]);
  const recordKind = type === "record_reference" || type === "record_reference_list";
  return (
    <>
      <StartText
        id={`${id}-name`}
        label="Name"
        disabled={disabled}
        value={input.name}
        apply={(name) => onChange({ ...input, name }, `${id}-name`)}
      />
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-type`}>Kind of value</Label>
        <StudioOptionControl
          id={`${id}-type`}
          disabled={disabled}
          value={type}
          options={workflowValueTypeSchema.options.map((type) => ({
            value: type,
            label: typeLabels[type] ?? studioWords(type),
          }))}
          onChange={(next) => {
            if (
              (next === "record_reference" || next === "record_reference_list") &&
              input.recordType === null
            ) {
              setType(next);
              return;
            }
            if (onChange({ ...input, type: next }) === true) setType(next);
          }}
        />
      </div>
      {recordKind && (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-record`}>Record type</Label>
          <StudioReferencePicker
            id={`${id}-record`}
            disabled={disabled}
            value={input.recordType ?? ""}
            unset="Choose…"
            options={recordTypes.map((entry) => ({ value: entry.key, label: entry.label }))}
            onChange={(next) => onChange({ ...input, type, recordType: next === "" ? null : next })}
          />
          {type !== input.type && (
            <StudioHelp hint="Choose a record type to apply this kind of value." />
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-required`}
          disabled={disabled}
          checked={input.required}
          onCheckedChange={(checked) => onChange({ ...input, required: checked === true })}
        />
        <Label htmlFor={`${id}-required`}>Required</Label>
      </div>
    </>
  );
}

export function StudioFlowStartEditor({
  projection,
  recordTypes,
  controlLabel,
  disabled,
  onApply,
}: Readonly<{
  projection: StudioFlowStartProjection;
  recordTypes: readonly Readonly<{ key: string; label: string }>[];
  controlLabel: (alias: string) => string;
  disabled: boolean;
  /** Puts the edited start in the draft; answers true, or the refusal in words. */
  onApply: StartApply;
}>) {
  // Why the last choice (a select, a checkbox, an added or removed input) was not taken; a text keeps its own problem.
  const [problem, setProblem] = useState("");
  const { keys: inputKeys, newKey } = useStudioEntryKeys(
    projection.kind === "unavailable" ? 0 : projection.draft.inputs.length,
  );
  if (projection.kind === "unavailable")
    return (
      <p role="alert" className="text-sm">
        {projection.reason}
      </p>
    );
  // Every edit starts from the start as the draft holds it now, so renaming an input always renames its stored name.
  const shown = projection.draft;
  const change = (next: StudioFlowStartDraft, setting?: string): true | string => {
    const result = onApply(next, setting);
    if (setting === undefined) setProblem(result === true ? "" : result);
    return result;
  };
  const setInputs = (inputs: readonly StudioFlowInputDraft[], setting?: string) => {
    const nextKeys = inputs.map((input) => {
      const previous = shown.inputs.findIndex((entry) => entry.id === input.id);
      return previous === -1 ? newKey() : inputKeys.current[previous]!;
    });
    const result = change(
      {
        ...shown,
        inputs,
        recordInput: inputs.some((input) => input.id === shown.recordInput)
          ? shown.recordInput
          : null,
        bindings: shown.bindings.map((binding) => ({
          ...binding,
          inputs: Object.fromEntries(
            inputs.map((input) => [
              input.id,
              binding.inputs[input.id] ?? { kind: "none" as const },
            ]),
          ),
        })),
      },
      setting,
    );
    if (result === true) inputKeys.current = nextKeys;
    return result;
  };
  return (
    <section className="space-y-4" aria-label="How it starts">
      <StudioInspectorGroup title="General">
        <StartText
          id="flow-start-name"
          label="Name"
          maxLength={100}
          disabled={disabled}
          value={shown.name}
          apply={(name) => change({ ...shown, name }, "name")}
        />
        <StudioHelp
          hint={
            projection.execution === "interactive"
              ? "Runs while a person uses the application, in their browser and on the server."
              : projection.execution === "transaction"
                ? "Runs inside the save of a record, for everyone who saves it."
                : projection.execution === "background"
                  ? "Runs on the server, without the person waiting."
                  : "Runs as a long-running background process."
          }
        />
      </StudioInspectorGroup>
      <StudioInspectorGroup title="How it starts">
        {shown.triggers.map((trigger, index) => (
          <fieldset key={index} className="space-y-2">
            <legend className="text-sm font-medium">
              {trigger.kind === "before_save"
                ? "Before a record is saved"
                : trigger.kind === "event"
                  ? "After a record changes"
                  : trigger.kind === "declared_event"
                    ? "After an event"
                    : trigger.kind === "schedule"
                      ? "On a schedule"
                      : "When a message arrives"}
            </legend>
            <TriggerEditor
              id={`flow-start-trigger-${index}`}
              trigger={trigger}
              recordTypes={recordTypes}
              events={projection.events}
              actions={projection.actions}
              disabled={disabled}
              onChange={(next, setting) =>
                change(
                  {
                    ...shown,
                    triggers: shown.triggers.map((entry, at) => (at === index ? next : entry)),
                  },
                  setting,
                )
              }
            />
          </fieldset>
        ))}
        {shown.bindings.length === 0 && shown.triggers.length === 0 && (
          <StudioHelp hint="Nothing starts this flow yet. Bind it to a button with Create workflow in the button's inspector, or run it from another flow." />
        )}
        {shown.bindings.map((binding) => (
          <fieldset key={binding.id} className="space-y-2">
            <legend className="text-sm font-medium">
              When {controlLabel(binding.control)} is used
            </legend>
            {shown.inputs.length === 0 && (
              <StudioHelp hint="The flow declares no inputs, so the control passes nothing." />
            )}
            {shown.inputs.map((input, inputIndex) => {
              const value = binding.inputs[input.id] ?? { kind: "none" };
              const supplied = projection.callerNames[binding.id] ?? [];
              const id = `flow-start-${binding.id}-${inputIndex}`;
              const setValue = (next: StudioFlowBindingInputDraft, setting?: string) =>
                change(
                  {
                    ...shown,
                    bindings: shown.bindings.map((entry) =>
                      entry.id === binding.id
                        ? { ...entry, inputs: { ...entry.inputs, [input.id]: next } }
                        : entry,
                    ),
                  },
                  setting,
                );
              return (
                <div key={inputKeys.current[inputIndex]} className="space-y-1.5">
                  <Label htmlFor={id}>
                    {studioWords(input.name)}
                    {!input.required && (
                      <span className="text-xs text-muted-foreground"> Optional</span>
                    )}{" "}
                    comes from
                  </Label>
                  <StudioReferencePicker
                    id={id}
                    disabled={disabled}
                    value={sourceToken(value)}
                    unset="Nothing"
                    options={[
                      ...supplied.map((entry) => ({
                        value: `caller:${entry.name}`,
                        label: entry.label,
                        group: "From the control",
                      })),
                      ...(value.kind === "caller" &&
                      !supplied.some((entry) => entry.name === value.name)
                        ? [
                            {
                              value: sourceToken(value),
                              label: studioWords(value.name),
                              description: "Supplied by the control",
                            },
                          ]
                        : []),
                      { value: "fixed", label: "A fixed text" },
                    ]}
                    onChange={(next) => {
                      setValue(
                        next === ""
                          ? { kind: "none" }
                          : next === "fixed"
                            ? { kind: "fixed", literal: { type: "text", value: "" } }
                            : { kind: "caller", name: next.slice("caller:".length) },
                      );
                    }}
                  />
                  {value.kind === "fixed" && (
                    <StartText
                      id={`${id}-fixed`}
                      label={`${studioWords(input.name)} fixed text`}
                      disabled={disabled}
                      value={typeof value.literal.value === "string" ? value.literal.value : ""}
                      apply={(text) =>
                        setValue(
                          { kind: "fixed", literal: { type: "text", value: text } },
                          `${id}-fixed`,
                        )
                      }
                    />
                  )}
                </div>
              );
            })}
          </fieldset>
        ))}
      </StudioInspectorGroup>
      <StudioInspectorGroup title="Inputs">
        <StudioHelp hint="The values the flow is given when it starts. Its steps read them." />
        <StudioEntryList
          label="Inputs"
          itemName="input"
          disabled={disabled}
          items={shown.inputs.map((input, index) => ({
            key: inputKeys.current[index]!,
            title: studioWords(input.name),
            summary: [
              input.type === "record_reference" || input.type === "record_reference_list"
                ? (recordTypes.find((entry) => entry.key === input.recordType)?.label ??
                  typeLabels[input.type])
                : typeLabels[input.type],
              input.required ? "required" : undefined,
            ]
              .filter(Boolean)
              .join(", "),
            content: (
              <InputSettings
                id={`flow-start-input-${inputKeys.current[index]}`}
                input={input}
                recordTypes={recordTypes}
                disabled={disabled}
                onChange={(next, setting) =>
                  setInputs(
                    shown.inputs.map((entry, at) => (at === index ? next : entry)),
                    setting,
                  )
                }
              />
            ),
          }))}
          onRemove={(index) => setInputs(shown.inputs.filter((_, at) => at !== index))}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => {
            const taken = new Set(shown.inputs.flatMap((input) => [input.id, input.name]));
            let n = shown.inputs.length + 1;
            while (taken.has(`input_${n}`) || taken.has(`+${n}`)) n += 1;
            // A new input's identity is never a stored name, so it can never read as a rename.
            setInputs([
              ...shown.inputs,
              { id: `+${n}`, name: `input_${n}`, type: "text", required: false, recordType: null },
            ]);
          }}
        >
          <Icon name="plus" />
          Add an input
        </Button>
      </StudioInspectorGroup>
      {projection.execution === "interactive" && (
        <div className="space-y-1.5">
          <Label htmlFor="flow-start-record">Runs for</Label>
          <StudioReferencePicker
            id="flow-start-record"
            disabled={disabled}
            value={shown.recordInput ?? ""}
            unset="No record"
            options={shown.inputs
              .filter((input) => input.type === "record_reference")
              .map((input) => ({
                value: input.id,
                label: `The record in ${studioWords(input.name)}`,
                description: recordTypes.find((entry) => entry.key === input.recordType)?.label,
              }))}
            onChange={(next) => change({ ...shown, recordInput: next === "" ? null : next })}
          />
          <StudioHelp hint="Its steps read the fields of this record, such as its stage, as the person may see them when the flow runs." />
        </div>
      )}
      {problem === "" ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </section>
  );
}
