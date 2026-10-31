"use client";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import { useState, type FormEvent } from "react";
import { Button } from "@vortex/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vortex/ui/components/dialog";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@vortex/ui/components/radio-group";
import { Textarea } from "@vortex/ui/components/textarea";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import {
  studioFlowCreateSavesChange,
  studioFlowEventTitle,
  type StudioFlowCreateChoices,
  type StudioFlowCreateCommand,
  StudioOptionControl,
} from "@vortex/ui/studio";

/**
 * A new flow with the minimum valid shape, for a control's action. A rule that runs before a record
 * is saved is added on its record type in the Data tab, the one place rules are added.
 */
export function StudioNewFlowDialog({
  open,
  onOpenChange,
  choices,
  source,
  onCreate,
  initialControl,
  initialEvent,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  choices: StudioFlowCreateChoices;
  source: ApplicationSourceDocument;
  onCreate: (command: StudioFlowCreateCommand) => string | true;
  /** A control to create the flow for, when opened from its inspector. */
  initialControl?: string | undefined;
  /** The event to create the flow for, when opened from the Behaviour panel. */
  initialEvent?: string | undefined;
}>) {
  const [name, setName] = useState("");
  const [control, setControl] = useState(initialControl ?? "");
  const [flowKey, setFlowKey] = useState("");
  const [mapping, setMapping] = useState<Readonly<Record<string, string>>>({});
  const [eventKind, setEventKind] = useState(initialEvent ?? "");
  const [rowActionLabel, setRowActionLabel] = useState("");
  const [problem, setProblem] = useState("");
  const [what, setWhat] = useState<"" | "operation" | "message">("");
  const [operation, setOperation] = useState("");
  const [messageText, setMessageText] = useState("");
  const events = choices.actions.filter((entry) => entry.controlAlias === control);
  const chosen = events.find((entry) => entry.event === eventKind) ?? events[0];
  const controls = [
    ...new Map(choices.actions.map((entry) => [entry.controlAlias, entry])).values(),
  ];
  const existingFlow = source.body.flows.find((flow) => flow.key === flowKey);
  const suppliedFor = (input: string): string =>
    mapping[input] ??
    chosen?.callerNames.find(
      (entry) =>
        entry.name === input ||
        (input === existingFlow?.recordInput &&
          entry.name === (chosen.event === "form_submit" ? "record" : "record_id")),
    )?.name ??
    "";
  const asksStep =
    existingFlow === undefined &&
    chosen !== undefined &&
    !studioFlowCreateSavesChange(chosen.event, chosen.recordType);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (chosen === undefined) {
      setProblem("Choose the control that starts the flow.");
      return;
    }
    if (asksStep && what === "") {
      setProblem("Choose what the flow does: run an operation or show a message.");
      return;
    }
    if (asksStep && what === "operation" && operation === "") {
      setProblem("Choose the operation the flow runs.");
      return;
    }
    if (asksStep && what === "message" && messageText.trim() === "") {
      setProblem("Write the message the flow shows.");
      return;
    }
    let command: StudioFlowCreateCommand;
    if (existingFlow !== undefined) {
      const inputs = Object.entries(existingFlow.inputs);
      if (
        inputs.some(([input, declaration]) => declaration.required && suppliedFor(input) === "")
      ) {
        setProblem("Choose where each required input comes from.");
        return;
      }
      command = {
        kind: "bind",
        controlAlias: control,
        event: chosen.event,
        flowKey: existingFlow.key,
        ...(chosen.rowActionMenu ? { rowActionLabel } : {}),
        bindingInputs: Object.fromEntries(
          inputs.flatMap(([input]) => {
            const caller = suppliedFor(input);
            return caller === "" ? [] : [[input, { kind: "caller" as const, name: caller }]];
          }),
        ),
      };
    } else
      command = {
        kind: "action",
        controlAlias: control,
        name,
        recordType: chosen.recordType,
        event: chosen.event,
        ...(asksStep
          ? {
              step:
                what === "operation"
                  ? { kind: "operation" as const, operation }
                  : { kind: "message" as const, message: messageText },
            }
          : {}),
        ...(chosen.rowActionMenu ? { rowActionLabel } : {}),
      };
    const result = onCreate(command);
    if (result === true) {
      setName("");
      setProblem("");
      setMapping({});
      setFlowKey("");
      setEventKind("");
      setRowActionLabel("");
      setWhat("");
      setOperation("");
      setMessageText("");
      onOpenChange(false);
    } else setProblem(result);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New flow</DialogTitle>
            <DialogDescription>
              The flow starts when a person uses a button or control, with the one step you choose
              here, which you then change on the canvas. Rules that check a record before it is
              saved are added on the record type in the Data tab.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="new-flow-existing">Workflow</Label>
            <StudioOptionControl
              id="new-flow-existing"
              value={flowKey}
              disabled={false}
              unset="Create a new flow"
              options={source.body.flows
                .filter((flow) => flow.execution === "interactive")
                .map((flow) => ({ value: flow.key, label: flow.labels?.name ?? flow.key }))}
              onChange={(value) => {
                setFlowKey(value);
                setMapping({});
              }}
            />
          </div>
          {existingFlow === undefined && (
            <div className="space-y-1.5">
              <Label htmlFor="new-flow-name">Name</Label>
              <Input
                id="new-flow-name"
                value={name}
                maxLength={100}
                required
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="new-flow-control">Control</Label>
            {choices.actions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Every supported control event already runs a flow. Add a control to a page first.
              </p>
            ) : (
              <StudioOptionControl
                id="new-flow-control"
                value={control}
                disabled={false}
                unset="Choose a control…"
                options={controls.map((entry) => ({
                  value: entry.controlAlias,
                  label: entry.label,
                }))}
                onChange={(value) => {
                  setControl(value);
                  setEventKind("");
                  setMapping({});
                }}
              />
            )}
          </div>
          {chosen !== undefined && (
            <div className="space-y-1.5">
              <Label htmlFor="new-flow-event">Event</Label>
              <StudioOptionControl
                id="new-flow-event"
                value={chosen.event}
                disabled={false}
                options={events.map((entry) => ({
                  value: entry.event,
                  label: studioFlowEventTitle(entry.event),
                }))}
                onChange={(value) => {
                  setEventKind(value);
                  setMapping({});
                }}
              />
            </div>
          )}
          {chosen?.rowActionMenu === true && (
            <div className="space-y-1.5">
              <Label htmlFor="new-flow-row-action-label">Row action label</Label>
              <Input
                id="new-flow-row-action-label"
                value={rowActionLabel}
                maxLength={60}
                required
                onChange={(event) => setRowActionLabel(event.target.value)}
              />
            </div>
          )}
          {asksStep && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">What should it do?</legend>
              <RadioGroup
                value={what}
                onValueChange={(value) => setWhat(value as "operation" | "message")}
              >
                <div className="flex items-start gap-2">
                  <RadioGroupItem
                    id="new-flow-what-operation"
                    value="operation"
                    className="size-4 rounded-full border border-input"
                  />
                  <Label htmlFor="new-flow-what-operation" className="font-normal">
                    Run an operation
                  </Label>
                </div>
                <div className="flex items-start gap-2">
                  <RadioGroupItem
                    id="new-flow-what-message"
                    value="message"
                    className="size-4 rounded-full border border-input"
                  />
                  <Label htmlFor="new-flow-what-message" className="font-normal">
                    Show a message
                  </Label>
                </div>
              </RadioGroup>
              {what === "operation" &&
                (choices.operations.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    This application has no operations to run yet. Add one in the Data tab, or show
                    a message.
                  </p>
                ) : (
                  <StudioOptionControl
                    id="new-flow-operation"
                    aria-label="Operation"
                    value={operation}
                    disabled={false}
                    unset="Choose an operation…"
                    options={choices.operations.map((entry) => ({
                      value: entry.key,
                      label: entry.label,
                    }))}
                    onChange={setOperation}
                  />
                ))}
              {what === "message" && (
                <Textarea
                  id="new-flow-message"
                  aria-label="Message"
                  value={messageText}
                  onChange={(event) => setMessageText(event.target.value)}
                />
              )}
            </fieldset>
          )}
          {existingFlow !== undefined &&
            Object.entries(existingFlow.inputs).map(([input, declaration]) => (
              <div key={input} className="space-y-1.5">
                <Label htmlFor={`new-flow-input-${input}`}>
                  {input.replaceAll("_", " ")}
                  {declaration.required ? " (required)" : ""}
                </Label>
                <StudioOptionControl
                  id={`new-flow-input-${input}`}
                  value={suppliedFor(input)}
                  disabled={false}
                  unset="Not supplied"
                  options={(chosen?.callerNames ?? []).map((entry) => ({
                    value: entry.name,
                    label: entry.label,
                  }))}
                  onChange={(value) => setMapping({ ...mapping, [input]: value })}
                />
              </div>
            ))}
          {problem === "" ? null : (
            <Alert variant="destructive">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                asksStep &&
                (what === "" ||
                  (what === "operation" && operation === "") ||
                  (what === "message" && messageText.trim() === ""))
              }
            >
              {existingFlow === undefined ? "Create flow" : "Bind flow"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
