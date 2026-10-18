"use client";
import { useState } from "react";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Input } from "@vortex/ui/components/input";
import { Item, ItemActions, ItemContent, ItemHeader, ItemTitle } from "@vortex/ui/components/item";
import { Label } from "@vortex/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import { flowStandardEventKindSchema, workflowValueTypeSchema } from "@vortex/platform/schema";
import {
  StudioOptionControl, studioWords,
  type StudioFlowBindingInputDraft, type StudioFlowInputDraft, type StudioFlowStartDraft, type StudioFlowStartProjection,
  type StudioFlowTriggerDraft,
} from "@vortex/ui/studio";

/**
 * The Start node's inspector: how the flow starts. Its name, the inputs it declares, the record it
 * runs for, where each input comes from when a control starts it, and its record triggers. Apply
 * writes it as one flow edit.
 */

const typeLabels: Readonly<Record<string, string>> = {
  text: "Text", formatted_text: "Formatted text", whole_number: "Whole number", decimal_number: "Decimal number", money: "Money",
  yes_no: "Yes or no", date: "Date", date_time: "Date and time", choice: "Choice", several_choices: "Several choices",
  record_reference: "A record", record_reference_list: "Several records",
  workflow_run_reference: "A flow run", relationship_reference: "A link between records",
  relationship_reference_list: "Links between records", file_reference: "A file", json: "A set of values (such as a form's answers)",
};

const eventLabels: Readonly<Record<string, string>> = {
  created: "is created", changed: "is changed", deleted: "is deleted", linked: "is linked", unlinked: "is unlinked",
  reassigned: "is reassigned", state_changed: "moves to another state",
};

const sourceToken = (value: StudioFlowBindingInputDraft): string =>
  value.kind === "caller" ? `caller:${value.name}` : value.kind === "fixed" ? "fixed" : "";

function TriggerEditor({ id, trigger, recordTypes, disabled, onChange }: Readonly<{
  id: string; trigger: StudioFlowTriggerDraft; recordTypes: readonly Readonly<{ key: string; label: string }>[];
  disabled: boolean; onChange: (trigger: StudioFlowTriggerDraft) => void;
}>) {
  if (trigger.kind === "kept") return <p className="text-sm">{trigger.description}. This kind of start is kept as it is here.</p>;
  const recordType = <div className="space-y-1.5"><Label htmlFor={`${id}-record`}>Record type</Label>
    <StudioOptionControl id={`${id}-record`} disabled={disabled} value={trigger.recordType}
      options={recordTypes.map((entry) => ({ value: entry.key, label: entry.label }))}
      onChange={(next) => onChange({ ...trigger, recordType: next })} /></div>;
  if (trigger.kind === "event")
    return <div className="space-y-2">{recordType}
      <div className="space-y-1.5"><Label htmlFor={`${id}-event`}>After the record</Label>
        <NativeSelect id={`${id}-event`} className="w-full" disabled={disabled} value={trigger.eventKind}
          onChange={(event) => onChange({ ...trigger, eventKind: event.target.value })}>
          {flowStandardEventKindSchema.options.map((kind) => <NativeSelectOption key={kind} value={kind}>{eventLabels[kind] ?? kind}</NativeSelectOption>)}
        </NativeSelect></div></div>;
  return <div className="space-y-2">{recordType}
    <div className="flex items-center gap-2"><Checkbox id={`${id}-create`} disabled={disabled} checked={trigger.create}
      onCheckedChange={(checked) => onChange({ ...trigger, create: checked === true })} /><Label htmlFor={`${id}-create`}>Before it is created</Label></div>
    <div className="flex items-center gap-2"><Checkbox id={`${id}-update`} disabled={disabled} checked={trigger.update}
      onCheckedChange={(checked) => onChange({ ...trigger, update: checked === true })} /><Label htmlFor={`${id}-update`}>Before it is changed</Label></div>
    <div className="space-y-1.5"><Label htmlFor={`${id}-priority`}>Order among the record&apos;s rules (0 to 1000, lower runs first)</Label>
      <Input id={`${id}-priority`} inputMode="numeric" disabled={disabled} value={String(trigger.priority)}
        onChange={(event) => onChange({ ...trigger, priority: Number(event.target.value) })} /></div>
  </div>;
}

function InputRow({ id, input, recordTypes, disabled, onChange, onRemove }: Readonly<{
  id: string; input: StudioFlowInputDraft; recordTypes: readonly Readonly<{ key: string; label: string }>[]; disabled: boolean;
  onChange: (input: StudioFlowInputDraft) => void; onRemove: () => void;
}>) {
  const recordKind = input.type === "record_reference" || input.type === "record_reference_list";
  return <Item variant="outline" size="sm">
    <ItemHeader className="flex-wrap gap-2"><ItemTitle>{studioWords(input.name)}</ItemTitle>
      <ItemActions><Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onRemove}>Remove</Button></ItemActions>
    </ItemHeader>
    <ItemContent className="basis-full space-y-2">
      <div className="space-y-1.5"><Label htmlFor={`${id}-name`}>Name</Label>
        <Input id={`${id}-name`} disabled={disabled} value={input.name} onChange={(event) => onChange({ ...input, name: event.target.value })} /></div>
      <div className="space-y-1.5"><Label htmlFor={`${id}-type`}>Kind of value</Label>
        <NativeSelect id={`${id}-type`} className="w-full" disabled={disabled} value={input.type}
          onChange={(event) => onChange({ ...input, type: event.target.value })}>
          {workflowValueTypeSchema.options.map((type) => <NativeSelectOption key={type} value={type}>{typeLabels[type] ?? type}</NativeSelectOption>)}
        </NativeSelect></div>
      {recordKind && <div className="space-y-1.5"><Label htmlFor={`${id}-record`}>Record type</Label>
        <StudioOptionControl id={`${id}-record`} disabled={disabled} value={input.recordType ?? ""} unset="Choose…"
          options={recordTypes.map((entry) => ({ value: entry.key, label: entry.label }))}
          onChange={(next) => onChange({ ...input, recordType: next === "" ? null : next })} /></div>}
      <div className="flex items-center gap-2"><Checkbox id={`${id}-required`} disabled={disabled} checked={input.required}
        onCheckedChange={(checked) => onChange({ ...input, required: checked === true })} /><Label htmlFor={`${id}-required`}>Required</Label></div>
    </ItemContent>
  </Item>;
}

export function StudioFlowStartEditor({ projection, recordTypes, controlLabel, disabled, onApply, onPendingChange }: Readonly<{
  projection: StudioFlowStartProjection;
  recordTypes: readonly Readonly<{ key: string; label: string }>[];
  controlLabel: (alias: string) => string;
  disabled: boolean;
  /** Applies the edited start; resolves true, or the refusal in words. */
  onApply: (draft: StudioFlowStartDraft) => true | string;
  onPendingChange: (pending: boolean) => void;
}>) {
  const [draft, setDraft] = useState<StudioFlowStartDraft | null>(null);
  const [problem, setProblem] = useState("");
  const [status, setStatus] = useState("");
  if (projection.kind === "unavailable") return <p role="alert" className="text-sm">{projection.reason}</p>;
  const shown = draft ?? projection.draft;
  const change = (next: StudioFlowStartDraft) => { setDraft(next); onPendingChange(true); setProblem(""); setStatus(""); };
  const setInputs = (inputs: readonly StudioFlowInputDraft[]) => change({ ...shown, inputs,
    recordInput: inputs.some((input) => input.id === shown.recordInput) ? shown.recordInput : null,
    bindings: shown.bindings.map((binding) => ({ ...binding, inputs: Object.fromEntries(inputs.map((input) =>
      [input.id, binding.inputs[input.id] ?? { kind: "none" as const }])) })) });
  return <section className="space-y-4" aria-label="How it starts">
    <h3 className="text-sm font-medium">How it starts</h3>
    <div className="space-y-1.5"><Label htmlFor="flow-start-name">Name</Label>
      <Input id="flow-start-name" maxLength={100} disabled={disabled} value={shown.name} onChange={(event) => change({ ...shown, name: event.target.value })} /></div>
    <p className="text-sm text-muted-foreground">{projection.execution === "interactive" ? "Runs while a person uses the application, in their browser and on the server."
      : projection.execution === "transaction" ? "Runs inside the save of a record, for everyone who saves it."
        : projection.execution === "background" ? "Runs on the server, without the person waiting." : "Runs as a long-running background process."}</p>
    {shown.triggers.map((trigger, index) => <fieldset key={index} className="space-y-2">
      <legend className="text-sm font-medium">{trigger.kind === "before_save" ? "Before a record is saved" : trigger.kind === "event" ? "After a record changes" : "Trigger"}</legend>
      <TriggerEditor id={`flow-start-trigger-${index}`} trigger={trigger} recordTypes={recordTypes} disabled={disabled}
        onChange={(next) => change({ ...shown, triggers: shown.triggers.map((entry, at) => at === index ? next : entry) })} />
    </fieldset>)}
    {shown.bindings.length === 0 && shown.triggers.length === 0 &&
      <p className="text-sm text-muted-foreground">Nothing starts this flow yet. Bind it to a button with Create workflow in the button&apos;s inspector, or run it from another flow.</p>}
    {shown.bindings.map((binding) => <fieldset key={binding.id} className="space-y-2">
      <legend className="text-sm font-medium">When {controlLabel(binding.control)} is used</legend>
      {shown.inputs.length === 0 && <p className="text-sm text-muted-foreground">The flow declares no inputs, so the control passes nothing.</p>}
      {shown.inputs.map((input) => {
        const value = binding.inputs[input.id] ?? { kind: "none" };
        const supplied = projection.callerNames[binding.id] ?? [];
        const id = `flow-start-${binding.id}-${input.name}`;
        return <div key={input.id} className="space-y-1.5">
          <Label htmlFor={id}>{studioWords(input.name)}{input.required ? " (required)" : ""} comes from</Label>
          <NativeSelect id={id} className="w-full" disabled={disabled} value={sourceToken(value)}
            onChange={(event) => {
              const next: StudioFlowBindingInputDraft = event.target.value === "" ? { kind: "none" }
                : event.target.value === "fixed" ? { kind: "fixed", literal: { type: "text", value: "" } }
                  : { kind: "caller", name: event.target.value.slice("caller:".length) };
              change({ ...shown, bindings: shown.bindings.map((entry) => entry === binding
                ? { ...entry, inputs: { ...entry.inputs, [input.id]: next } } : entry) });
            }}>
            <NativeSelectOption value="">Nothing</NativeSelectOption>
            {supplied.map((entry) => <NativeSelectOption key={entry.name} value={`caller:${entry.name}`}>{entry.label}</NativeSelectOption>)}
            {value.kind === "caller" && !supplied.some((entry) => entry.name === value.name) &&
              <NativeSelectOption value={sourceToken(value)}>{`${studioWords(value.name)} (supplied by the control)`}</NativeSelectOption>}
            <NativeSelectOption value="fixed">A fixed text</NativeSelectOption>
          </NativeSelect>
          {value.kind === "fixed" && <Input aria-label={`${studioWords(input.name)} fixed text`} disabled={disabled}
            value={typeof value.literal.value === "string" ? value.literal.value : ""} onChange={(event) =>
              change({ ...shown, bindings: shown.bindings.map((entry) => entry === binding
                ? { ...entry, inputs: { ...entry.inputs, [input.id]: { kind: "fixed", literal: { type: "text", value: event.target.value } } } } : entry) })} />}
        </div>;
      })}
    </fieldset>)}
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Inputs</legend>
      <p className="text-xs text-muted-foreground">The values the flow is given when it starts. Its steps read them.</p>
      {shown.inputs.map((input, index) => <InputRow key={input.id} id={`flow-start-input-${index}`} input={input} recordTypes={recordTypes}
        disabled={disabled} onRemove={() => setInputs(shown.inputs.filter((_, at) => at !== index))}
        onChange={(next) => setInputs(shown.inputs.map((entry, at) => at === index ? next : entry))} />)}
      <Button type="button" variant="outline" size="sm" disabled={disabled}
        onClick={() => {
          const taken = new Set(shown.inputs.flatMap((input) => [input.id, input.name]));
          let n = shown.inputs.length + 1;
          while (taken.has(`input_${n}`) || taken.has(`+${n}`)) n += 1;
          // A new input's identity is never a stored name, so it can never read as a rename.
          setInputs([...shown.inputs, { id: `+${n}`, name: `input_${n}`, type: "text", required: false, recordType: null }]);
        }}>
        Add an input</Button>
    </fieldset>
    {projection.execution === "interactive" && <div className="space-y-1.5">
      <Label htmlFor="flow-start-record">Runs for</Label>
      <NativeSelect id="flow-start-record" className="w-full" disabled={disabled} value={shown.recordInput ?? ""}
        onChange={(event) => change({ ...shown, recordInput: event.target.value === "" ? null : event.target.value })}>
        <NativeSelectOption value="">No record</NativeSelectOption>
        {shown.inputs.filter((input) => input.type === "record_reference").map((input) =>
          <NativeSelectOption key={input.id} value={input.id}>{`The record in ${studioWords(input.name)}${input.recordType === null ? ""
            : ` (${recordTypes.find((entry) => entry.key === input.recordType)?.label ?? input.recordType})`}`}</NativeSelectOption>)}
      </NativeSelect>
      <p className="text-xs text-muted-foreground">Its steps read the fields of this record, such as its stage, as the person may see them
        when the flow runs.</p>
    </div>}
    <div className="flex gap-2">
      <Button type="button" size="sm" disabled={disabled || draft === null} onClick={() => {
        if (draft === null) return;
        const result = onApply(draft);
        if (result === true) { setDraft(null); onPendingChange(false); setStatus("How it starts changed. Save to keep it."); }
        else setProblem(result);
      }}>Apply</Button>
      <Button type="button" variant="outline" size="sm" disabled={disabled || draft === null}
        onClick={() => { setDraft(null); onPendingChange(false); setProblem(""); }}>Discard</Button>
    </div>
    {problem === "" ? null : <p role="alert" className="text-sm text-destructive">{problem}</p>}
    <p role="status" className="text-sm">{status}</p>
  </section>;
}
