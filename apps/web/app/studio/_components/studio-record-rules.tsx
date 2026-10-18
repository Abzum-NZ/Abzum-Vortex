"use client";
import { Icon } from "@vortex/ui";
import { useState, type FormEvent } from "react";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@vortex/ui/components/empty";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
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
import {
  applyStudioFlowCreate,
  deleteStudioRecordRule,
  studioRecordRules,
} from "@vortex/ui/studio";
import { useStudioPlaceOpener } from "./studio-used-in";
import { studioEditProblem, type StudioDataEdit } from "../_lib/studio-data-model";

/**
 * The before-save rules of a record type, such as "Enter the company name" or "A closed
 * opportunity keeps its stage". Each rule is a BeforeSave flow of the record type's module: Add a
 * rule makes one with a single Warn step and opens it on the Flows tab, where its steps (If,
 * Refuse save, Warn, Require field) are edited like any flow's. The rule then runs inside every
 * save of the record, whichever way it is saved: a form, a board move, a named action or a Save
 * record step.
 */
export function StudioRecordRules({
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
  const [confirm, confirmDialog] = useConfirm();
  const opener = useStudioPlaceOpener();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [onCreate, setOnCreate] = useState(true);
  const [onUpdate, setOnUpdate] = useState(true);
  const [problem, setProblem] = useState("");
  const record = source.body.modules
    .find((entry) => entry.key === moduleKey)
    ?.record_types.find((entry) => entry.key === recordKey);
  if (record === undefined) return null;
  const rules = studioRecordRules(source, moduleKey, recordKey);
  const open = (flowAlias: string, label: string) =>
    opener.open({ label, open: { kind: "flow", flowAlias, moduleKey } });
  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const label = name.trim();
    const result = edit((current) => {
      const created = applyStudioFlowCreate(
        current,
        {
          kind: "before_save",
          moduleKey,
          recordTypeKey: recordKey,
          name,
          operations: [
            ...(onCreate ? ["create" as const] : []),
            ...(onUpdate ? ["update" as const] : []),
          ],
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
    open(result.flowAlias, label);
  };
  const remove = async (flowAlias: string, label: string) => {
    setProblem("");
    const check = deleteStudioRecordRule(source, moduleKey, flowAlias);
    if (check.kind === "refused") {
      setProblem(check.reason);
      return;
    }
    if (
      !(await confirm({
        title: `Delete ${label}?`,
        confirmLabel: "Delete rule",
        description: `${record.plural_name} are no longer checked by this rule once you publish. Undo brings it back.`,
      }))
    )
      return;
    const result = edit((current) => {
      const deleted = deleteStudioRecordRule(current, moduleKey, flowAlias);
      return deleted.kind === "refused"
        ? { kind: "refused" as const, message: deleted.reason }
        : { kind: "changed" as const, source: deleted.source };
    });
    if (result.kind !== "changed") setProblem(studioEditProblem(result) ?? "");
  };
  return (
    <section className="space-y-6" aria-label={`Rules of ${record.plural_name}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold">Rules before saving</h3>
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
          Add a rule
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Check every save of {record.plural_name.toLowerCase()}, wherever it starts.
      </p>
      {adding && (
        <form className="space-y-2" onSubmit={add} aria-label="New rule">
          <div className="space-y-1.5">
            <Label htmlFor="record-rule-name">Name</Label>
            <Input
              id="record-rule-name"
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
              id="record-rule-create"
              checked={onCreate}
              disabled={disabled}
              onCheckedChange={(checked) => setOnCreate(checked === true)}
            />
            <Label htmlFor="record-rule-create">When it is created</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="record-rule-update"
              checked={onUpdate}
              disabled={disabled}
              onCheckedChange={(checked) => setOnUpdate(checked === true)}
            />
            <Label htmlFor="record-rule-update">When it is changed</Label>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={disabled}>
              Add and open the rule
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
      {rules.length === 0 && !adding && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Icon name="shield" />
            </EmptyMedia>
            <EmptyTitle>No rules yet</EmptyTitle>
            <EmptyDescription>Add a rule to check records before they are saved.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <ul className="space-y-2">
        {rules.map((rule) => (
          <Item key={rule.flowAlias} render={<li />} variant="outline" size="sm">
            <ItemHeader className="flex-wrap gap-2">
              <ItemTitle>{rule.name}</ItemTitle>
              <ItemActions className="gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => open(rule.flowAlias, rule.name)}
                >
                  Open
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => {
                    void remove(rule.flowAlias, rule.name);
                  }}
                >
                  Delete
                </Button>
              </ItemActions>
            </ItemHeader>
            <ItemContent className="basis-full">
              <ItemDescription>{rule.when}.</ItemDescription>
              {rule.effects.length === 0 ? null : (
                <ul className="list-disc space-y-0.5 pl-5 text-sm">
                  {rule.effects.map((effect, index) => (
                    <li key={index} className="break-words">
                      {effect}
                    </li>
                  ))}
                </ul>
              )}
            </ItemContent>
          </Item>
        ))}
      </ul>
      {problem === "" ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      {confirmDialog}
    </section>
  );
}
