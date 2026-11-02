"use client";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import { useState, type FormEvent } from "react";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Input } from "@vortex/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemHeader,
  ItemTitle,
} from "@vortex/ui/components/item";
import { Label } from "@vortex/ui/components/label";
import { applyStudioFlowCreate, studioRecordSubscribers } from "@vortex/ui/studio";
import { useStudioPlaceOpener } from "./studio-used-in";
import { studioEditProblem, type StudioDataEdit } from "../_lib/studio-data-model";

/**
 * The after-save subscribers of a record type, such as "Create a follow-up activity". Each is a
 * back-end flow of the record type's module that starts once after a record is created or
 * changed. Add a flow makes one with a single Stop step and opens it on the Flows tab, where its
 * steps are edited like any flow's and Run after orders it among the other subscribers.
 */
export function StudioRecordSubscribers({
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
  /** The Data tab's one edit path. */
  edit: StudioDataEdit;
}>) {
  const opener = useStudioPlaceOpener();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [onCreate, setOnCreate] = useState(true);
  const [problem, setProblem] = useState("");
  const record = source.body.modules
    .find((entry) => entry.key === moduleKey)
    ?.record_types.find((entry) => entry.key === recordKey);
  if (record === undefined) return null;
  const subscribers = studioRecordSubscribers(source, moduleKey, recordKey);
  const open = (flowAlias: string) => opener.open({ kind: "flow", flowAlias, moduleKey });
  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = edit((current) => {
      const created = applyStudioFlowCreate(
        current,
        {
          kind: "background",
          moduleKey,
          recordTypeKey: recordKey,
          name,
          event: onCreate ? "created" : "changed",
        },
        null,
      );
      return created.kind === "refused"
        ? { kind: "refused" as const, message: created.reason }
        : {
            kind: "changed" as const,
            source: created.source,
            flowAlias: created.selection.flowAlias,
          };
    });
    if (result.kind !== "changed") {
      setProblem(studioEditProblem(result) ?? "");
      return;
    }
    setAdding(false);
    setName("");
    setProblem("");
    open(result.flowAlias);
  };
  return (
    <section className="space-y-6" aria-label={`After saving ${record.plural_name}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold">After saving</h3>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          aria-expanded={adding}
          onClick={() => {
            setAdding(!adding);
            setProblem("");
          }}
        >
          Add a flow
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Run a flow on the back end once a {record.name.toLowerCase()} is saved. Flows that start on
        the same change can be ordered in the flow's Start settings.
      </p>
      {adding && (
        <form className="space-y-2" onSubmit={add} aria-label="New after-save flow">
          <div className="space-y-1.5">
            <Label htmlFor="record-subscriber-name">Flow name</Label>
            <Input
              id="record-subscriber-name"
              required
              maxLength={100}
              value={name}
              disabled={disabled}
              onChange={(event) => {
                setName(event.target.value);
                setProblem("");
              }}
            />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="record-subscriber-created"
              checked={onCreate}
              disabled={disabled}
              onCheckedChange={(checked) => setOnCreate(checked === true)}
            />
            <Label htmlFor="record-subscriber-created">
              When it is created (otherwise when it is changed)
            </Label>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={disabled}>
              Add and open the flow
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setAdding(false);
                setProblem("");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      <ul className="space-y-2">
        {subscribers.map((subscriber) => (
          <Item key={subscriber.flowAlias} render={<li />} variant="outline" size="sm">
            <ItemHeader className="flex-wrap gap-2">
              <ItemTitle>{subscriber.name}</ItemTitle>
              <ItemActions className="gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => open(subscriber.flowAlias)}
                >
                  Open
                </Button>
              </ItemActions>
            </ItemHeader>
            <ItemContent className="basis-full">
              <ItemDescription>{subscriber.when}.</ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </ul>
      {problem === "" ? null : (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
