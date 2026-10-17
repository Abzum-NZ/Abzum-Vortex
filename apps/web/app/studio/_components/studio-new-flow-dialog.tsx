"use client";
import { useState, type FormEvent } from "react";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@vortex/ui/components/dialog";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import type { StudioFlowCreateChoices, StudioFlowCreateCommand } from "@vortex/ui/studio";

/** A new flow with the minimum valid shape: for a control's action, or for a record about to be saved. */
export function StudioNewFlowDialog({ open, onOpenChange, choices, onCreate, initialControl }: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  choices: StudioFlowCreateChoices;
  onCreate: (command: StudioFlowCreateCommand) => string | true;
  /** A control to create the flow for, when opened from its inspector. */
  initialControl?: string | undefined;
}>) {
  const [start, setStart] = useState<"action" | "before_save">("action");
  const [name, setName] = useState("");
  const [control, setControl] = useState(initialControl ?? "");
  const [recordType, setRecordType] = useState("");
  const [onCreateRecord, setOnCreateRecord] = useState(true);
  const [onUpdateRecord, setOnUpdateRecord] = useState(true);
  const [problem, setProblem] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const chosenType = choices.recordTypes.find((entry) => `${entry.moduleKey} ${entry.recordTypeKey}` === recordType);
    const chosenControl = choices.actions.find((entry) => entry.controlAlias === control);
    const command: StudioFlowCreateCommand | undefined = start === "action"
      ? chosenControl === undefined ? undefined : { kind: "action", controlAlias: control, name,
        recordType: chosenControl.recordType, event: chosenControl.event }
      : chosenType === undefined ? undefined : { kind: "before_save", moduleKey: chosenType.moduleKey,
        recordTypeKey: chosenType.recordTypeKey, name,
        operations: [...(onCreateRecord ? ["create" as const] : []), ...(onUpdateRecord ? ["update" as const] : [])] };
    if (command === undefined) { setProblem(start === "action" ? "Choose the control that starts the flow." : "Choose the record type."); return; }
    const result = onCreate(command);
    if (result === true) { setName(""); setProblem(""); onOpenChange(false); }
    else setProblem(result);
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <form onSubmit={submit} className="space-y-4">
        <DialogHeader>
          <DialogTitle>New flow</DialogTitle>
          <DialogDescription>The flow starts with one step you then change on the canvas.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="new-flow-name">Name</Label>
          <Input id="new-flow-name" value={name} maxLength={100} required onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-flow-start">Starts</Label>
          <NativeSelect id="new-flow-start" className="w-full" value={start}
            onChange={(event) => setStart(event.target.value === "before_save" ? "before_save" : "action")}>
            <NativeSelectOption value="action">When a person uses a button or control</NativeSelectOption>
            <NativeSelectOption value="before_save">Before a record is saved</NativeSelectOption>
          </NativeSelect>
        </div>
        {start === "action" ? <div className="space-y-1.5">
          <Label htmlFor="new-flow-control">Control</Label>
          {choices.actions.length === 0
            ? <p className="text-sm text-muted-foreground">Every button already runs a flow. Add a button to a page first.</p>
            : <NativeSelect id="new-flow-control" className="w-full" value={control} onChange={(event) => setControl(event.target.value)}>
              <NativeSelectOption value="">Choose a control…</NativeSelectOption>
              {choices.actions.map((entry) => <NativeSelectOption key={entry.controlAlias} value={entry.controlAlias}>{entry.label}</NativeSelectOption>)}
            </NativeSelect>}
        </div> : <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="new-flow-record">Record type</Label>
            {choices.recordTypes.length === 0
              ? <p className="text-sm text-muted-foreground">This application owns no module with record types.</p>
              : <NativeSelect id="new-flow-record" className="w-full" value={recordType} onChange={(event) => setRecordType(event.target.value)}>
                <NativeSelectOption value="">Choose a record type…</NativeSelectOption>
                {choices.recordTypes.map((entry) => <NativeSelectOption key={`${entry.moduleKey} ${entry.recordTypeKey}`}
                  value={`${entry.moduleKey} ${entry.recordTypeKey}`}>{entry.label} ({entry.moduleName})</NativeSelectOption>)}
              </NativeSelect>}
          </div>
          <div className="flex items-center gap-2"><Checkbox id="new-flow-on-create" checked={onCreateRecord}
            onCheckedChange={(checked) => setOnCreateRecord(checked === true)} /><Label htmlFor="new-flow-on-create">When it is created</Label></div>
          <div className="flex items-center gap-2"><Checkbox id="new-flow-on-update" checked={onUpdateRecord}
            onCheckedChange={(checked) => setOnUpdateRecord(checked === true)} /><Label htmlFor="new-flow-on-update">When it is changed</Label></div>
        </div>}
        {problem === "" ? null : <p role="alert" className="text-sm text-destructive">{problem}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit">Create flow</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
