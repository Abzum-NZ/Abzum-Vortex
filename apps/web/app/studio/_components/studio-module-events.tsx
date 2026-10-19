"use client";
import { useState, type FormEvent } from "react";
import { saveInlineModuleEvent, type ApplicationSourceDocument } from "@vortex/platform/schema";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vortex/ui/components/dialog";
import { studioEditProblem, type StudioDataEdit } from "../_lib/studio-data-model";

type Module = ApplicationSourceDocument["body"]["modules"][number];
function EventDialog({
  module,
  recordKey,
  event,
  edit,
  close,
}: Readonly<{
  module: Module;
  recordKey: string;
  event: Module["events"][number] | undefined;
  edit: StudioDataEdit;
  close: () => void;
}>) {
  const [selectedRecord, setSelectedRecord] = useState(event?.record_type ?? recordKey);
  const record = module.record_types.find((entry) => entry.key === selectedRecord)!;
  const [key, setKey] = useState(event?.key ?? `${module.key}.${record.key}.`);
  const [carries, setCarries] = useState(event?.carries ?? []);
  const [problem, setProblem] = useState<string>();
  const save = (submit: FormEvent<HTMLFormElement>) => {
    submit.preventDefault();
    const result = edit((source) =>
      saveInlineModuleEvent(source, {
        moduleKey: module.key,
        recordKey: selectedRecord,
        ...(event === undefined ? {} : { eventId: event.id }),
        key,
        carries,
      }),
    );
    setProblem(studioEditProblem(result));
    if (result.kind === "changed") close();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <form className="space-y-4" onSubmit={save}>
          <DialogHeader>
            <DialogTitle>{event === undefined ? "Declare event" : "Edit event"}</DialogTitle>
            <DialogDescription>
              An event owned by {module.name}, announced for {record.name.toLowerCase()} records.
            </DialogDescription>
          </DialogHeader>
          <Label htmlFor="module-event-key">Event key</Label>
          <Input
            id="module-event-key"
            required
            value={key}
            disabled={event !== undefined}
            onChange={(change) => setKey(change.target.value)}
          />
          <Label htmlFor="module-event-record">Record type</Label>
          <NativeSelect
            id="module-event-record"
            className="w-full"
            value={selectedRecord}
            onChange={(change) => {
              setSelectedRecord(change.target.value);
              setCarries([]);
            }}
          >
            {module.record_types.map((entry) => (
              <NativeSelectOption key={entry.key} value={entry.key}>
                {entry.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Carried fields</legend>
            {record.fields.map((field) => (
              <div key={field.key} className="flex items-center gap-2">
                <Checkbox
                  id={`event-carries-${field.key}`}
                  disabled={field.personal_data !== "none"}
                  checked={carries.includes(field.key)}
                  onCheckedChange={(checked) =>
                    setCarries(
                      checked === true
                        ? [...carries, field.key]
                        : carries.filter((entry) => entry !== field.key),
                    )
                  }
                />
                <Label htmlFor={`event-carries-${field.key}`}>
                  {field.label}
                  {field.personal_data === "none" ? "" : " (personal or sensitive)"}
                </Label>
              </div>
            ))}
          </fieldset>
          <div className="flex items-center gap-2">
            <Checkbox id="module-event-personal-values" checked={false} disabled />
            <Label htmlFor="module-event-personal-values">Allow personal or sensitive values</Label>
          </div>
          <p className="text-sm text-muted-foreground">
            Privacy policy: personal and sensitive values are refused. Only fields without personal
            data can be carried.
          </p>
          {problem === undefined ? null : (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit">Save event</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function StudioModuleEvents({
  source,
  moduleKey,
  recordKey,
  disabled,
  edit,
}: Readonly<{
  source: ApplicationSourceDocument;
  moduleKey: string;
  recordKey: string;
  disabled: boolean;
  edit: StudioDataEdit;
}>) {
  const [editing, setEditing] = useState<string | null>(null);
  const module = source.body.modules.find((entry) => entry.key === moduleKey);
  if (module === undefined) return null;
  const events = module.events.filter((entry) => entry.record_type === recordKey);
  return (
    <section className="space-y-2 border-t border-border pt-3" aria-label="Named events">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Named events</h3>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => setEditing("new")}
        >
          Declare event
        </Button>
      </div>
      {events.map((event) => (
        <div key={event.id} className="flex items-center gap-2 rounded-md border p-2">
          <p className="mr-auto break-all text-sm">
            {event.key}
            <span className="block text-xs text-muted-foreground">
              Carries {event.carries.join(", ") || "no fields"}
            </span>
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setEditing(event.id)}
          >
            Edit event
          </Button>
        </div>
      ))}
      {editing === null ? null : (
        <EventDialog
          key={editing}
          module={module}
          recordKey={recordKey}
          event={events.find((entry) => entry.id === editing)}
          edit={edit}
          close={() => setEditing(null)}
        />
      )}
    </section>
  );
}
