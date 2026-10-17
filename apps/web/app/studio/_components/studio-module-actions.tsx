"use client";
import { useMemo, useState, type FormEvent } from "react";
import {
  deleteInlineModuleAction, saveInlineModuleAction,
  type ApplicationSourceDocument, type ConditionNode, type FlowValue, type InlineModuleActionPrecondition,
  type InlineRecordTypeReference, type JsonValue,
} from "@vortex/platform/schema";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@vortex/ui/components/dialog";
import { Input } from "@vortex/ui/components/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemHeader, ItemTitle } from "@vortex/ui/components/item";
import { Label } from "@vortex/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import {
  StudioConditionControls, StudioOptionControl, projectStudioActionCondition, studioActionConditionContext,
  studioActionConditionSource, studioFlowLabel, type StudioConditionValidation,
} from "@vortex/ui/studio";
import { useStudioDraftText } from "./use-studio-draft-text";
import { useStudioDraftHeld } from "./use-studio-draft-held";
import { studioEditProblem, type StudioDataEdit } from "../_lib/studio-data-model";

/**
 * The named actions of a record type, such as Mark won, Mark lost or Convert lead: what each is
 * called, when it may run, which fields it sets, the permission that gates it and the flows that run
 * it. A button runs an action through its workflow (Create workflow in the button's inspector), with
 * a Save record step that saves the option the action owns, or a Call protected operation step.
 */

type Module = ApplicationSourceDocument["body"]["modules"][number];
type RecordType = Module["record_types"][number];
type Action = Module["actions"][number];
type Field = RecordType["fields"][number];

/** How an action sets one field: a fixed value, the person running it, or the time it runs. */
type Effect = Readonly<{ field: string; from: "fixed" | "person" | "now"; value: string | boolean }>;

/** What the action dialog sets; an existing action takes each change as one edit of the draft. */
type ActionForm = Readonly<{
  label: string; precondition: InlineModuleActionPrecondition | undefined; effects: readonly Effect[];
  /** "own" for the action's own permission, else the key of another named permission. */
  permission: string; ownsChoice: boolean;
}>;

const unfinishedCondition = "Runs only when: finish every comparison, with a value on both sides.";

const choiceOptions = (field: Field | undefined): readonly { value: string; label: string }[] =>
  field?.type === "choice" ? ((field.settings as { options?: { value: string; label: string }[] }).options ?? []) : [];

const effectsOf = (action: Action | undefined): Effect[] => {
  const task = action?.tasks.find((entry) => entry.type === "record.set_fields");
  const values = (task?.properties as { values?: Record<string, FlowValue> } | undefined)?.values ?? {};
  return Object.entries(values).map(([field, value]): Effect =>
    value.kind === "reference" && value.reference.source === "execution_actor" ? { field, from: "person", value: "" }
      : value.kind === "reference" && value.reference.source === "execution_now" ? { field, from: "now", value: "" }
        : { field, from: "fixed", value: value.kind === "literal" && (typeof value.literal.value === "string" ||
          typeof value.literal.value === "boolean") ? value.literal.value
          : value.kind === "literal" ? JSON.stringify(value.literal.value) : "" });
};

const effectValue = (effect: Effect, field: Field | undefined): FlowValue => {
  if (effect.from === "person") return { kind: "reference", reference: { source: "execution_actor" } };
  if (effect.from === "now") return { kind: "reference", reference: { source: "execution_now" } };
  const raw: JsonValue = typeof effect.value === "boolean" ? effect.value
    : field?.type === "whole_number" && /^-?\d+$/.test(effect.value.trim()) ? Number(effect.value.trim()) : effect.value;
  return { kind: "literal", literal: { type: "json", value: raw } };
};

/** The flows that run an action: by calling it, or by saving the choice option it owns. */
const runningFlows = (source: ApplicationSourceDocument, module: Module, action: Action) => {
  const owned = action.sets_choice_field === undefined ? undefined : { field: action.sets_choice_field, option: action.sets_choice_option };
  const qualified = `${module.key}:${action.record_type}`;
  const literal = (value: FlowValue | undefined) => value?.kind === "literal" ? value.literal.value : undefined;
  const runs = (task: unknown): boolean => {
    if (task === null || typeof task !== "object") return false;
    const entry = task as { type?: string; properties?: Record<string, FlowValue>; then?: unknown[]; else?: unknown[];
      default?: unknown[]; tasks?: unknown[]; cases?: { tasks: unknown[] }[]; branches?: unknown[][] };
    if (entry.type === "operation.call" && literal(entry.properties?.operation) === action.key) return true;
    if (entry.type === "record.save" && owned !== undefined && literal(entry.properties?.record_type) === qualified) {
      const values = entry.properties?.values;
      if (values?.kind === "map" && literal(values.entries[owned.field]) === owned.option) return true;
    }
    return [entry.then, entry.else, entry.default, entry.tasks, ...(entry.cases ?? []).map((item) => item.tasks), ...(entry.branches ?? [])]
      .some((list) => list?.some(runs) === true);
  };
  return [
    ...source.body.flows.filter((flow) => [...flow.tasks, ...flow.errors, ...flow.finally].some(runs))
      .map((flow) => ({ flow, moduleKey: null as string | null })),
    ...source.body.modules.flatMap((owner) => owner.flows.filter((flow) => [...flow.tasks, ...flow.errors, ...flow.finally].some(runs))
      .map((flow) => ({ flow, moduleKey: owner.key as string | null }))),
  ];
};

/** A fixed value an action sets, applied as it is typed. */
function EffectText({ label, value, apply }: Readonly<{ label: string; value: string; apply: (next: string) => string | true }>) {
  const text = useStudioDraftText(value, apply);
  return <div className="space-y-1">
    <Input aria-label={`${label} value`} value={text.text} aria-invalid={text.problem === "" ? undefined : true}
      onChange={(event) => text.change(event.target.value)} />
    {text.problem === "" ? null : <p role="alert" className="text-xs text-destructive">{text.problem}</p>}
  </div>;
}

/**
 * Adds or changes one named action. A new action is a form, added with Add action; a pipeline's gate
 * opens it with the stage's option already set, so the new action owns that stage, and `onSaved`
 * then names the action it made. An existing action takes each valid change as one edit of the
 * draft at once; a name or condition that is not valid yet stays in its control with why.
 */
export function ActionDialog({ module, record, action, open, onOpenChange, edit, onShow, initialEffect, onSaved }: Readonly<{
  module: Module; record: RecordType; action: Action | undefined; open: boolean;
  onOpenChange: (open: boolean) => void;
  edit: StudioDataEdit;
  onShow: (reference: InlineRecordTypeReference) => void;
  /** For a new action: the choice option it sets from the start. */
  initialEffect?: Readonly<{ field: string; option: string }>;
  onSaved?: (actionKey: string) => void;
}>) {
  const adding = action === undefined;
  const [where, setWhere] = useState<readonly InlineRecordTypeReference[]>([]);
  const projected = useMemo(() => projectStudioActionCondition(action?.precondition), [action]);
  const context = useMemo(() => studioActionConditionContext(record), [record]);
  const [replacing, setReplacing] = useState(false);
  const keptCondition = projected.kind === "unsupported" && !replacing;
  const [created, setCreated] = useState<ActionForm>(() => ({
    label: "", precondition: undefined, permission: "own", ownsChoice: true,
    effects: initialEffect === undefined ? [] : [{ field: initialEffect.field, from: "fixed", value: initialEffect.option }],
  }));
  const stored: ActionForm = action === undefined ? created : {
    label: action.label, precondition: action.precondition, effects: effectsOf(action),
    permission: action.permission === action.key ? "own" : action.permission ?? "own", ownsChoice: action.sets_choice_field !== undefined,
  };
  const [issues, setIssues] = useState<readonly string[]>([]);
  const named = module.permissions.filter((permission) => permission.action_kind === "named" && permission.record_type === record.key);
  const settable = record.fields.filter((field) => field.type !== "reference_number" && field.type !== "calculation" && field.type !== "total");
  const setsChoiceIn = (effects: readonly Effect[]) =>
    effects.some((effect) => record.fields.find((field) => field.key === effect.field)?.type === "choice");

  const save = (form: ActionForm, merge?: string): string | undefined => {
    setWhere([]);
    const result = edit((current) => saveInlineModuleAction(current, {
      moduleKey: module.key, recordKey: record.key, ...(action === undefined ? {} : { actionKey: action.key }),
      label: form.label, precondition: form.precondition,
      effects: form.effects.map((effect) => ({ field: effect.field, value: effectValue(effect, record.fields.find((field) => field.key === effect.field)) })),
      permission: form.permission === "own" ? { kind: "own" } : { kind: "existing", key: form.permission },
      ownsChoice: form.ownsChoice && setsChoiceIn(form.effects),
    }), merge === undefined ? {} : { merge });
    if (result.kind === "referenced") setWhere(result.references);
    if (result.kind === "changed" && action === undefined) { onSaved?.(result.actionKey); onOpenChange(false); }
    return studioEditProblem(result);
  };
  /** A change of the form: kept in the new action's form, or one edit of an existing action. */
  const change = (patch: Partial<ActionForm>, merge?: string): string | undefined => {
    if (action === undefined) { setCreated({ ...created, ...patch }); setIssues([]); return undefined; }
    const problem = save({ ...stored, ...patch }, merge);
    setIssues(problem === undefined ? [] : [problem]);
    return problem;
  };
  const label = useStudioDraftText(action?.label ?? "", (next) => adding ? true
    : next.trim() === "" ? "Enter the action's name, for example Mark won." : change({ label: next }, `action-label:${module.key}:${action.key}`) ?? true);
  const condition = useStudioDraftHeld<ConditionNode | undefined>(projected.kind === "condition" ? projected.condition : undefined);
  const effects = stored.effects;
  const unused = settable.filter((field) => !effects.some((effect) => effect.field === field.key));
  const setsChoice = setsChoiceIn(effects);

  const changeCondition = (next: ConditionNode | undefined, validation: StudioConditionValidation) => {
    const built = validation.isValid ? studioActionConditionSource(next) : { ok: false as const };
    if (!built.ok) { condition.hold(next, unfinishedCondition); return; }
    if (action === undefined) { condition.hold(next, ""); setCreated({ ...created, precondition: built.condition }); return; }
    const problem = save({ ...stored, precondition: built.condition }, `action-condition:${module.key}:${action.key}`);
    if (problem !== undefined) { condition.hold(next, problem); return; }
    const after = projectStudioActionCondition(built.condition);
    condition.applied(after.kind === "condition" ? after.condition : undefined);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (action !== undefined) return;
    if (condition.problem !== "") { setIssues([condition.problem]); return; }
    const problem = save({ ...created, label: label.text });
    setIssues(problem === undefined ? [] : [problem]);
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-screen overflow-y-auto">
      <form onSubmit={submit} className="space-y-4">
        <DialogHeader>
          <DialogTitle>{action === undefined ? `New action of ${record.plural_name}` : `Change ${action.label}`}</DialogTitle>
          <DialogDescription>A named action people run on one {record.name.toLowerCase()}, such as Mark won.
            {action === undefined ? "" : " Each change is kept as you make it."}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5"><Label htmlFor="action-name">Name</Label>
          <Input id="action-name" required maxLength={60} value={label.text} aria-invalid={label.problem === "" ? undefined : true}
            onChange={(event) => { label.change(event.target.value); if (adding) setIssues([]); }} />
          {label.problem === "" ? null : <p role="alert" className="text-xs text-destructive">{label.problem}</p>}</div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Runs only when</legend>
          {keptCondition
            ? <div className="space-y-2 text-sm"><p>This condition compares values the condition controls do not show. It is kept as it is.</p>
              <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}>Replace it</Button></div>
            : <StudioConditionControls key={condition.epoch} {...(condition.value === undefined ? {} : { value: condition.value })}
              context={context} label="Runs only when" onChange={changeCondition} />}
          {condition.problem === "" ? null : <p role="alert" className="text-xs text-destructive">{condition.problem}</p>}
          <p className="text-xs text-muted-foreground">Leave it without a condition to let the action run on any {record.name.toLowerCase()}.</p>
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Sets</legend>
          {effects.length === 0 && <p className="text-sm text-muted-foreground">No field is set yet.</p>}
          {effects.map((effect, index) => {
            const field = record.fields.find((candidate) => candidate.key === effect.field);
            const options = choiceOptions(field);
            const replaced = (next: Effect) => effects.map((entry, at) => at === index ? next : entry);
            const set = (next: Effect) => change({ effects: replaced(next) });
            return <Item key={effect.field} variant="outline" size="sm">
              <ItemHeader className="flex-wrap gap-2"><ItemTitle>{field?.label ?? effect.field}</ItemTitle>
                <ItemActions><Button type="button" variant="outline" size="sm"
                  onClick={() => change({ effects: effects.filter((_, at) => at !== index) })}>Remove</Button></ItemActions></ItemHeader>
              <ItemContent className="basis-full space-y-2">
                <NativeSelect aria-label={`${field?.label ?? effect.field}: set to`} className="w-full" value={effect.from}
                  onChange={(event) => set({ ...effect, from: event.target.value as Effect["from"] })}>
                  <NativeSelectOption value="fixed">A fixed value</NativeSelectOption>
                  {field?.type === "link_to_person" || field?.type === "link" ? <NativeSelectOption value="person">The person running it</NativeSelectOption> : null}
                  {field?.type === "date_time" || field?.type === "date" ? <NativeSelectOption value="now">The time it runs</NativeSelectOption> : null}
                </NativeSelect>
                {effect.from === "fixed" && (options.length > 0
                  ? <StudioOptionControl id={`action-effect-${effect.field}`} disabled={false} value={String(effect.value)}
                    options={options} onChange={(value) => set({ ...effect, value })} />
                  : field?.type === "yes_no"
                    ? <div className="flex items-center gap-2"><Checkbox id={`action-effect-${effect.field}`} checked={effect.value === true}
                      onCheckedChange={(checked) => set({ ...effect, value: checked === true })} /><Label htmlFor={`action-effect-${effect.field}`}>Yes</Label></div>
                    : <EffectText label={field?.label ?? effect.field} value={String(effect.value)}
                      apply={(value) => change({ effects: replaced({ ...effect, value }) },
                        action === undefined ? undefined : `action-effect:${module.key}:${action.key}:${effect.field}`) ?? true} />)}
              </ItemContent>
            </Item>;
          })}
          {unused.length > 0 && <div className="space-y-1.5"><Label htmlFor="action-add-field">Set another field</Label>
            <StudioOptionControl id="action-add-field" disabled={false} value="" unset="Choose a field…"
              options={unused.map((field) => ({ value: field.key, label: field.label }))}
              onChange={(key) => {
                const field = record.fields.find((candidate) => candidate.key === key);
                if (field !== undefined) change({ effects: [...effects, { field: key, from: "fixed",
                  value: field.type === "yes_no" ? false : choiceOptions(field)[0]?.value ?? "" }] });
              }} /></div>}
          {setsChoice && <div className="flex items-start gap-2"><Checkbox id="action-owns" checked={stored.ownsChoice}
            onCheckedChange={(checked) => change({ ownsChoice: checked === true })} />
            <Label htmlFor="action-owns" className="font-normal">Saving this option anywhere (a form, a board, a Save record step) runs this action, with its condition and permission.</Label></div>}
        </fieldset>
        <div className="space-y-1.5"><Label htmlFor="action-permission">Permission</Label>
          <NativeSelect id="action-permission" className="w-full" value={stored.permission} onChange={(event) => change({ permission: event.target.value })}>
            <NativeSelectOption value="own">{action === undefined ? "Its own permission, given to every access group" : "Its own permission"}</NativeSelectOption>
            {named.filter((entry) => entry.key !== action?.key).map((entry) =>
              <NativeSelectOption key={entry.key} value={entry.key}>{entry.label}</NativeSelectOption>)}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">Only people whose access groups hold this permission can run the action.</p></div>
        {issues.length === 0 ? null : <ul role="alert" className="space-y-1 text-sm text-destructive">
          {issues.map((issue, index) => <li key={index} className="break-words">{issue}</li>)}</ul>}
        {where.length === 0 ? null : <div className="space-y-1 text-sm">
          <p className="font-medium">Show me where</p>
          <ul className="list-disc space-y-1 pl-5" aria-label="Where the permission is used">{where.map((reference) => <li key={reference.label}>
            {reference.open.kind === "none" ? reference.label : <Button type="button" variant="link" size="sm" className="h-auto whitespace-normal p-0 text-left"
              onClick={() => { onOpenChange(false); onShow(reference); }}>{reference.label}</Button>}</li>)}</ul>
        </div>}
        <DialogFooter>
          {action === undefined
            ? <><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit">Add action</Button></>
            : <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Close</Button>}
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function StudioModuleActions({ source, moduleKey, recordKey, disabled, edit, onShow }: Readonly<{
  source: ApplicationSourceDocument; moduleKey: string; recordKey: string; disabled: boolean;
  edit: StudioDataEdit;
  onShow: (reference: InlineRecordTypeReference) => void;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [references, setReferences] = useState<readonly InlineRecordTypeReference[]>([]);
  const module = source.body.modules.find((item) => item.key === moduleKey);
  const record = module?.record_types.find((item) => item.key === recordKey);
  if (module === undefined || record === undefined) return null;
  const actions = module.actions.filter((action) => action.record_type === record.key);
  const remove = async (action: Action) => {
    setIssues([]); setReferences([]);
    const check = deleteInlineModuleAction(source, module.key, action.key);
    if (check.kind === "referenced") { setReferences(check.references); return; }
    if (check.kind === "invalid") { setIssues(check.issues); return; }
    if (!await confirm({ title: `Delete ${action.label}?`, confirmLabel: "Delete action",
      description: "The action and its own permission leave the draft. Undo brings them back." })) return;
    const result = edit((current) => deleteInlineModuleAction(current, module.key, action.key));
    if (result.kind === "referenced") setReferences(result.references);
    else { const problem = studioEditProblem(result); if (problem !== undefined) setIssues([problem]); }
  };
  const chosen = editing === null || editing === "new" ? undefined : actions.find((action) => action.key === editing);
  return <section className="space-y-2 border-t border-border pt-3" aria-label={`Actions of ${record.plural_name}`}>
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">Actions</h3>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setEditing("new")}>Add an action</Button>
    </div>
    {actions.length === 0 && <p className="text-sm text-muted-foreground">No named actions yet, such as Mark won.</p>}
    <ul className="space-y-2">{actions.map((action) => {
      const flows = runningFlows(source, module, action);
      const option = action.sets_choice_field === undefined ? undefined
        : choiceOptions(record.fields.find((field) => field.key === action.sets_choice_field)).find((entry) => entry.value === action.sets_choice_option);
      return <Item key={action.key} render={<li />} variant="outline" size="sm">
        <ItemHeader className="flex-wrap gap-2">
          <ItemTitle>{action.label}</ItemTitle>
          {option === undefined ? null : <Badge variant="outline">Owns {option.label}</Badge>}
          <ItemActions className="gap-1">
            <Button type="button" size="sm" variant="outline" disabled={disabled || action.protected_operation !== undefined}
              onClick={() => setEditing(action.key)}>Edit</Button>
            <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => { void remove(action); }}>Delete</Button>
          </ItemActions>
        </ItemHeader>
        <ItemContent className="basis-full">
          <ItemDescription>{action.protected_operation !== undefined ? "Runs a registered operation of the platform; it is not changed here."
            : flows.length === 0 ? "No flow runs it yet. Add a button, then Create workflow in its inspector with a Save record step that saves this option."
              : "Run by:"}</ItemDescription>
          {flows.length === 0 ? null : <ul className="space-y-1">{flows.map(({ flow, moduleKey: owner }) => <li key={`${owner ?? ""}:${flow.id}`}>
            <Button type="button" variant="link" size="sm" className="h-auto p-0"
              onClick={() => onShow({ label: studioFlowLabel(flow), open: { kind: "flow", flowAlias: flow.id, moduleKey: owner } })}>
              {studioFlowLabel(flow)}</Button></li>)}</ul>}
        </ItemContent>
      </Item>;
    })}</ul>
    {references.length === 0 ? null : <div role="alert" className="space-y-1 text-sm text-destructive">
      <p>This action cannot be deleted: it is still used in {references.length === 1 ? "one place" : `${references.length} places`}.</p>
      <ul className="list-disc space-y-1 pl-5">{references.map((reference) => <li key={reference.label}>
        {reference.open.kind === "none" ? reference.label
          : <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => onShow(reference)}>{reference.label}</Button>}</li>)}</ul>
    </div>}
    {issues.length === 0 ? null : <ul role="alert" className="space-y-1 text-sm text-destructive">
      {issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
    {editing !== null && (editing === "new" || chosen !== undefined) && <ActionDialog key={editing} module={module}
      record={record} action={chosen} open onOpenChange={(open) => { if (!open) setEditing(null); }} edit={edit} onShow={onShow} />}
    {confirmDialog}
  </section>;
}
