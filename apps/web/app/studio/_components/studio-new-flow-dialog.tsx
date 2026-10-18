"use client";
import { useState, type FormEvent } from "react";
import { Button } from "@vortex/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@vortex/ui/components/dialog";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import { studioFlowEventLabels, type StudioFlowCreateChoices, type StudioFlowCreateCommand } from "@vortex/ui/studio";

/**
 * A new flow with the minimum valid shape, for a control's action. A rule that runs before a record
 * is saved is added on its record type in the Data tab, the one place rules are added.
 */
export function StudioNewFlowDialog({ open, onOpenChange, choices, source, onCreate, initialControl }: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  choices: StudioFlowCreateChoices;
  source: ApplicationSourceDocument;
  onCreate: (command: StudioFlowCreateCommand) => string | true;
  /** A control to create the flow for, when opened from its inspector. */
  initialControl?: string | undefined;
}>) {
  const [name, setName] = useState("");
  const [control, setControl] = useState(initialControl ?? "");
  const [flowKey, setFlowKey] = useState("");
  const [mapping, setMapping] = useState<Readonly<Record<string, string>>>({});
  const [eventKind, setEventKind] = useState("");
  const [rowActionLabel, setRowActionLabel] = useState("");
  const [problem, setProblem] = useState("");
  const events = choices.actions.filter((entry) => entry.controlAlias === control);
  const chosen = events.find((entry) => entry.event === eventKind) ?? events[0];
  const controls = [...new Map(choices.actions.map((entry) => [entry.controlAlias, entry])).values()];
  const existingFlow = source.body.flows.find((flow) => flow.key === flowKey);
  const suppliedFor = (input: string): string => mapping[input] ?? chosen?.callerNames.find((entry) =>
    entry.name === input || (input === existingFlow?.recordInput && entry.name === (chosen.event === "form_submit" ? "record" : "record_id")))?.name ?? "";
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (chosen === undefined) { setProblem("Choose the control that starts the flow."); return; }
    let command: StudioFlowCreateCommand;
    if (existingFlow !== undefined) {
      const inputs = Object.entries(existingFlow.inputs);
      if (inputs.some(([input, declaration]) => declaration.required && suppliedFor(input) === "")) {
        setProblem("Choose where each required input comes from."); return;
      }
      command = { kind: "bind", controlAlias: control, event: chosen.event, flowKey: existingFlow.key,
        ...(chosen.rowActionMenu ? { rowActionLabel } : {}),
        bindingInputs: Object.fromEntries(inputs.flatMap(([input]) => {
          const caller = suppliedFor(input);
          return caller === "" ? [] : [[input, { kind: "caller" as const, name: caller }]];
        })) };
    } else command = { kind: "action", controlAlias: control, name, recordType: chosen.recordType, event: chosen.event,
      ...(chosen.rowActionMenu ? { rowActionLabel } : {}) };
    const result = onCreate(command);
    if (result === true) { setName(""); setProblem(""); setMapping({}); setFlowKey(""); setEventKind(""); setRowActionLabel(""); onOpenChange(false); }
    else setProblem(result);
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <form onSubmit={submit} className="space-y-4">
        <DialogHeader>
          <DialogTitle>New flow</DialogTitle>
          <DialogDescription>The flow starts when a person uses a button or control, with one step you then change on the
            canvas. Rules that check a record before it is saved are added on the record type in the Data tab.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="new-flow-existing">Workflow</Label>
          <NativeSelect id="new-flow-existing" className="w-full" value={flowKey}
            onChange={(event) => { setFlowKey(event.target.value); setMapping({}); }}>
            <NativeSelectOption value="">Create a new flow</NativeSelectOption>
            {source.body.flows.filter((flow) => flow.execution === "interactive").map((flow) =>
              <NativeSelectOption key={flow.key} value={flow.key}>{flow.labels?.name ?? flow.key}</NativeSelectOption>)}
          </NativeSelect>
        </div>
        {existingFlow === undefined && <div className="space-y-1.5">
          <Label htmlFor="new-flow-name">Name</Label>
          <Input id="new-flow-name" value={name} maxLength={100} required onChange={(event) => setName(event.target.value)} />
        </div>}
        <div className="space-y-1.5">
          <Label htmlFor="new-flow-control">Control</Label>
          {choices.actions.length === 0
            ? <p className="text-sm text-muted-foreground">Every supported control event already runs a flow. Add a control to a page first.</p>
            : <NativeSelect id="new-flow-control" className="w-full" value={control} onChange={(event) => { setControl(event.target.value); setEventKind(""); setMapping({}); }}>
              <NativeSelectOption value="">Choose a control…</NativeSelectOption>
              {controls.map((entry) => <NativeSelectOption key={entry.controlAlias} value={entry.controlAlias}>{entry.label}</NativeSelectOption>)}
            </NativeSelect>}
        </div>
        {chosen !== undefined && <div className="space-y-1.5">
          <Label htmlFor="new-flow-event">Event</Label>
          <NativeSelect id="new-flow-event" className="w-full" value={chosen.event} onChange={(event) => { setEventKind(event.target.value); setMapping({}); }}>
            {events.map((entry) => <NativeSelectOption key={entry.event} value={entry.event}>{studioFlowEventLabels[entry.event]}</NativeSelectOption>)}
          </NativeSelect>
        </div>}
        {chosen?.rowActionMenu === true && <div className="space-y-1.5">
          <Label htmlFor="new-flow-row-action-label">Row action label</Label>
          <Input id="new-flow-row-action-label" value={rowActionLabel} maxLength={60} required
            onChange={(event) => setRowActionLabel(event.target.value)} />
        </div>}
        {existingFlow !== undefined && Object.entries(existingFlow.inputs).map(([input, declaration]) => <div key={input} className="space-y-1.5">
          <Label htmlFor={`new-flow-input-${input}`}>{input.replaceAll("_", " ")}{declaration.required ? " (required)" : ""}</Label>
          <NativeSelect id={`new-flow-input-${input}`} className="w-full" value={suppliedFor(input)}
            onChange={(event) => setMapping({ ...mapping, [input]: event.target.value })}>
            <NativeSelectOption value="">Not supplied</NativeSelectOption>
            {chosen?.callerNames.map((entry) => <NativeSelectOption key={entry.name} value={entry.name}>{entry.label}</NativeSelectOption>)}
          </NativeSelect>
        </div>)}
        {problem === "" ? null : <p role="alert" className="text-sm text-destructive">{problem}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit">{existingFlow === undefined ? "Create flow" : "Bind flow"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
