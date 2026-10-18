"use client";
import { useState, type FormEvent } from "react";
import { Button } from "@vortex/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@vortex/ui/components/dialog";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import type { StudioFlowCreateChoices, StudioFlowCreateCommand } from "@vortex/ui/studio";

/**
 * A new flow with the minimum valid shape, for a control's action. A rule that runs before a record
 * is saved is added on its record type in the Data tab, the one place rules are added.
 */
export function StudioNewFlowDialog({ open, onOpenChange, choices, onCreate, initialControl }: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  choices: StudioFlowCreateChoices;
  onCreate: (command: StudioFlowCreateCommand) => string | true;
  /** A control to create the flow for, when opened from its inspector. */
  initialControl?: string | undefined;
}>) {
  const [name, setName] = useState("");
  const [control, setControl] = useState(initialControl ?? "");
  const [problem, setProblem] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const chosen = choices.actions.find((entry) => entry.controlAlias === control);
    if (chosen === undefined) { setProblem("Choose the control that starts the flow."); return; }
    const result = onCreate({ kind: "action", controlAlias: control, name, recordType: chosen.recordType, event: chosen.event });
    if (result === true) { setName(""); setProblem(""); onOpenChange(false); }
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
          <Label htmlFor="new-flow-name">Name</Label>
          <Input id="new-flow-name" value={name} maxLength={100} required onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-flow-control">Control</Label>
          {choices.actions.length === 0
            ? <p className="text-sm text-muted-foreground">Every button already runs a flow. Add a button to a page first.</p>
            : <NativeSelect id="new-flow-control" className="w-full" value={control} onChange={(event) => setControl(event.target.value)}>
              <NativeSelectOption value="">Choose a control…</NativeSelectOption>
              {choices.actions.map((entry) => <NativeSelectOption key={entry.controlAlias} value={entry.controlAlias}>{entry.label}</NativeSelectOption>)}
            </NativeSelect>}
        </div>
        {problem === "" ? null : <p role="alert" className="text-sm text-destructive">{problem}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit">Create flow</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
