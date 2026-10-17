"use client";
import { useState, type FormEvent } from "react";
import {
  deleteInlinePipeline, inlineActionSetsOption, inlineChoiceOptionReferences, inlineOptionOwner, pipelineStageTones,
  saveInlinePipeline, type ApplicationSourceDocument, type InlinePipelineChange, type InlineRecordTypeReference,
  type ModuleFieldPublication, type PipelineStageTone,
} from "@vortex/platform/schema";
import { Icon } from "@vortex/ui";
import { Alert, AlertDescription, AlertTitle } from "@vortex/ui/components/alert";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@vortex/ui/components/dialog";
import { Input } from "@vortex/ui/components/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemHeader, ItemTitle } from "@vortex/ui/components/item";
import { Label } from "@vortex/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@vortex/ui/components/table";
import { ActionDialog } from "./studio-module-actions";
import { useStudioDraftText } from "./use-studio-draft-text";
import { studioEditProblem, type StudioDataEdit } from "../_lib/studio-data-model";

/**
 * The pipelines of a record type, on the Data tab: each follows one choice field, whose options are
 * its stages. A pipeline sets the order and colour role of its stages, the moves between them a save
 * accepts, and which named action owns a gated stage, so moving there runs that action with its
 * permission and condition. Boards over its field take their columns and drag rules from it.
 */

type Source = ApplicationSourceDocument;
type Module = Source["body"]["modules"][number];
type RecordType = Module["record_types"][number];
type Pipeline = RecordType["pipelines"][number];
type Option = Readonly<{ value: string; label: string }>;
type Refusal = Readonly<{ issue: string; references: readonly InlineRecordTypeReference[] }>;

const toneLabels: Readonly<Record<PipelineStageTone, string>> = {
  neutral: "Neutral", primary: "Primary", destructive: "Alert", chart_1: "Chart colour 1", chart_2: "Chart colour 2",
  chart_3: "Chart colour 3", chart_4: "Chart colour 4", chart_5: "Chart colour 5",
};
/** Each colour role as its theme token. */
const toneClasses: Readonly<Record<PipelineStageTone, string>> = {
  neutral: "bg-muted-foreground", primary: "bg-primary", destructive: "bg-destructive", chart_1: "bg-chart-1",
  chart_2: "bg-chart-2", chart_3: "bg-chart-3", chart_4: "bg-chart-4", chart_5: "bg-chart-5",
};
const createAction = "__create_action__";

const optionsOf = (record: RecordType, fieldKey: string): readonly Option[] => {
  const field = record.fields.find((candidate) => candidate.key === fieldKey);
  return field?.type === "choice" ? (field.settings as { options: Option[] }).options : [];
};
const locate = (source: Source, moduleKey: string, recordKey: string) => {
  const module = source.body.modules.find((item) => item.key === moduleKey);
  const record = module?.record_types.find((item) => item.key === recordKey);
  return module === undefined || record === undefined ? undefined : { module, record };
};
/** The action that owns each option of a choice field, as the source holds it. */
const gatesOf = (module: Module, record: RecordType, fieldKey: string): Record<string, string> =>
  Object.fromEntries(optionsOf(record, fieldKey).flatMap(({ value }) => {
    const owner = inlineOptionOwner(module, record, fieldKey, value)?.key;
    return owner === undefined ? [] : [[value, owner]];
  }));

function Where({ references, onShow, label }: Readonly<{
  references: readonly InlineRecordTypeReference[]; onShow: (reference: InlineRecordTypeReference) => void; label: string;
}>) {
  const [showing, setShowing] = useState(false);
  return <div className="space-y-2">
    <Button type="button" size="xs" variant="outline" aria-expanded={showing} onClick={() => setShowing(!showing)}>
      {showing ? "Hide where" : "Show me where"}</Button>
    {showing && <ul className="list-disc space-y-1 pl-5" aria-label={label}>{references.map((reference) =>
      <li key={reference.label} className="break-words">{reference.open.kind === "none" ? reference.label
        : <Button type="button" variant="link" size="sm" className="h-auto whitespace-normal p-0 text-left"
          onClick={() => onShow(reference)}>{reference.label}</Button>}</li>)}</ul>}
  </div>;
}

function Refused({ refusal, label, onShow }: Readonly<{ refusal: Refusal; label: string; onShow: (reference: InlineRecordTypeReference) => void }>) {
  return <Alert variant="destructive" role="alert">
    <AlertTitle>Refused</AlertTitle>
    <AlertDescription className="space-y-2"><p>{refusal.issue}</p>
      <Where references={refusal.references} label={label} onShow={onShow} /></AlertDescription>
  </Alert>;
}

function Problems({ issues }: Readonly<{ issues: readonly string[] }>) {
  return issues.length === 0 ? null : <ul role="alert" className="space-y-1 text-sm text-destructive">
    {issues.map((issue, index) => <li key={index} className="break-words">{issue}</li>)}</ul>;
}

function StageSwatch({ tone }: Readonly<{ tone: PipelineStageTone }>) {
  return <span aria-hidden="true" className={`inline-block h-4 w-1 shrink-0 ${toneClasses[tone]}`} />;
}

/** Names a new pipeline and the choice field it follows; it starts with every option as a stage and no moves. */
function NewPipelineDialog({ module, record, publication, edit, onClose, onCreated }: Readonly<{
  module: Module; record: RecordType; publication: ModuleFieldPublication; edit: StudioDataEdit;
  onClose: () => void; onCreated: (pipelineKey: string) => void;
}>) {
  const free = record.fields.filter((field) => field.type === "choice" && !record.pipelines.some((candidate) => candidate.stage_field === field.key));
  const [name, setName] = useState("");
  const [stageField, setStageField] = useState(free[0]?.key ?? "");
  const [issues, setIssues] = useState<readonly string[]>([]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = edit((current) => {
      const located = locate(current, module.key, record.key);
      if (located === undefined) return { kind: "invalid" as const, issues: ["The record type is not in this application's modules any more."] };
      return saveInlinePipeline(current, {
        moduleKey: module.key, recordKey: record.key, name, stageField, transitions: [], removedOptions: [],
        stages: optionsOf(located.record, stageField).map((option) => ({ option: option.value, tone: "neutral" as PipelineStageTone })),
        gates: gatesOf(located.module, located.record, stageField),
      }, publication);
    });
    if (result.kind === "changed") { onCreated(result.pipelineKey); return; }
    setIssues([studioEditProblem(result) ?? "The pipeline was not added."]);
  };
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-h-screen overflow-y-auto">
      <form onSubmit={submit} className="space-y-4">
        <DialogHeader>
          <DialogTitle>New pipeline of {record.plural_name}</DialogTitle>
          <DialogDescription>The stages a {record.name.toLowerCase()} moves through. Set their order, colours, moves and
            gates once it is added.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5"><Label htmlFor="pipeline-name">Name</Label>
          <Input id="pipeline-name" required maxLength={60} value={name} placeholder="Asset lifecycle"
            onChange={(event) => { setName(event.target.value); setIssues([]); }} /></div>
        <div className="space-y-1.5"><Label htmlFor="pipeline-field">Stages come from</Label>
          <NativeSelect id="pipeline-field" className="w-full" value={stageField}
            onChange={(event) => { setStageField(event.target.value); setIssues([]); }}>
            {free.map((candidate) => <NativeSelectOption key={candidate.key} value={candidate.key}>{candidate.label}</NativeSelectOption>)}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">Each option of the choice field is one stage. Add options in the field&apos;s editor.</p></div>
        <Problems issues={issues} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={free.length === 0 || name.trim() === ""}>Add pipeline</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

/** One pipeline: each change of its name, stages, moves and gates is one edit of the draft at once. */
function PipelineDialog({ source, module, record, pipeline, publication, edit, onClose, onShow }: Readonly<{
  source: Source; module: Module; record: RecordType; pipeline: Pipeline; publication: ModuleFieldPublication;
  edit: StudioDataEdit; onClose: () => void; onShow: (reference: InlineRecordTypeReference) => void;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [where, setWhere] = useState<Refusal>();
  const [creatingFor, setCreatingFor] = useState<string>();
  const stageField = pipeline.stage_field;
  const options = optionsOf(record, stageField);
  const label = (value: string) => options.find((option) => option.value === value)?.label ?? value;
  const field = record.fields.find((candidate) => candidate.key === stageField);
  const stages = pipeline.stages;
  const moves = pipeline.transitions;
  const gates = gatesOf(module, record, stageField);
  const allowed = (from: string, to: string) => moves.some((move) => move.from === from && move.to === to);
  const gatesFor = (option: string) => module.actions.filter((action) => inlineActionSetsOption(record, action, stageField, option));

  // One edit of the pipeline: the patch over the pipeline as the draft holds it now.
  const commit = (patch: Partial<Pick<InlinePipelineChange, "name" | "stages" | "transitions" | "gates" | "removedOptions">>,
    merge?: string) => {
    setWhere(undefined);
    const result = edit((current) => {
      const located = locate(current, module.key, record.key);
      const now = located?.record.pipelines.find((item) => item.key === pipeline.key);
      if (located === undefined || now === undefined) return { kind: "invalid" as const, issues: ["This pipeline is not on the record type any more."] };
      return saveInlinePipeline(current, {
        moduleKey: module.key, recordKey: record.key, pipelineKey: now.key, name: now.name, stageField: now.stage_field,
        stages: now.stages, transitions: now.transitions, gates: gatesOf(located.module, located.record, now.stage_field),
        removedOptions: [], ...patch,
      }, publication);
    }, merge === undefined ? {} : { merge });
    if (result.kind === "referenced") setWhere({ issue: result.issue, references: result.references });
    return result;
  };
  // A refusal with places is shown with them; any other is listed.
  const change = (patch: Parameters<typeof commit>[0]) => {
    const result = commit(patch);
    setIssues(result.kind === "changed" || result.kind === "referenced" ? [] : [studioEditProblem(result) ?? "Nothing was changed."]);
  };
  const name = useStudioDraftText(pipeline.name, (next) =>
    studioEditProblem(commit({ name: next }, `pipeline-name:${module.key}:${record.key}:${pipeline.key}`)) ?? true);

  const moveStage = (index: number, by: -1 | 1) => {
    const next = [...stages];
    const [moved] = next.splice(index, 1);
    next.splice(index + by, 0, moved!);
    change({ stages: next });
  };
  const removeStage = async (option: string) => {
    setIssues([]); setWhere(undefined);
    const references = inlineChoiceOptionReferences(source, module.key, record.key, stageField, option);
    if (references.length > 0) {
      setWhere({ issue: `${label(option)} can't be removed: it is used in ${references.length === 1 ? "one place" : `${references.length} places`}. Remove those uses first.`, references });
      return;
    }
    if (publication.fields.has(`${module.key}:${record.key}.${stageField}`)) {
      setIssues([`${label(option)} can't be removed: ${field?.label ?? "the field"} is in a published version, and records already stored may hold it.`]);
      return;
    }
    if (!await confirm({ title: `Remove the stage ${label(option)}?`, confirmLabel: "Remove stage",
      description: `${label(option)} leaves ${field?.label ?? "the choice field"} as an option, with its moves and gate.` })) return;
    change({ removedOptions: [option] });
  };

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-h-screen overflow-y-auto sm:max-w-3xl">
      <div className="space-y-4">
        <DialogHeader>
          <DialogTitle>Change {pipeline.name}</DialogTitle>
          <DialogDescription>The stages a {record.name.toLowerCase()} moves through, the moves between them, and which stages
            need an action. Each change is kept as you make it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5"><Label htmlFor="pipeline-name">Name</Label>
          <Input id="pipeline-name" required maxLength={60} value={name.text} aria-invalid={name.problem === "" ? undefined : true}
            onChange={(event) => name.change(event.target.value)} />
          {name.problem === "" ? null : <p role="alert" className="text-xs text-destructive">{name.problem}</p>}</div>
        <div className="space-y-1.5"><p className="text-sm font-medium">Stages come from</p>
          <p className="text-sm">{field?.label ?? stageField}. A pipeline keeps the field it follows.</p>
          <p className="text-xs text-muted-foreground">Each option of the choice field is one stage. Add options in the field&apos;s editor.</p></div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Stages, in board order</legend>
          <ul className="space-y-2">{stages.map((stage, index) => <Item key={stage.option} render={<li />} variant="outline" size="sm">
            <ItemHeader className="flex-wrap gap-2">
              <ItemTitle className="gap-2"><StageSwatch tone={stage.tone} />{label(stage.option)}</ItemTitle>
              <ItemActions className="gap-1">
                <Button type="button" variant="outline" size="icon-sm" aria-label={`Move ${label(stage.option)} earlier`}
                  disabled={index === 0} onClick={() => moveStage(index, -1)}><Icon name="arrow-up" /></Button>
                <Button type="button" variant="outline" size="icon-sm" aria-label={`Move ${label(stage.option)} later`}
                  disabled={index === stages.length - 1} onClick={() => moveStage(index, 1)}><Icon name="arrow-down" /></Button>
                <Button type="button" variant="outline" size="sm" onClick={() => { void removeStage(stage.option); }}>Remove stage</Button>
              </ItemActions>
            </ItemHeader>
            <ItemContent className="basis-full grid gap-2 sm:grid-cols-2">
              <div className="space-y-1"><Label htmlFor={`stage-tone-${stage.option}`}>Colour</Label>
                <NativeSelect id={`stage-tone-${stage.option}`} className="w-full" value={stage.tone}
                  onChange={(event) => change({ stages: stages.map((entry) => entry === stage
                    ? { ...entry, tone: event.target.value as PipelineStageTone } : entry) })}>
                  {pipelineStageTones.map((tone) => <NativeSelectOption key={tone} value={tone}>{toneLabels[tone]}</NativeSelectOption>)}
                </NativeSelect></div>
              <div className="space-y-1"><Label htmlFor={`stage-gate-${stage.option}`}>Moving here</Label>
                <NativeSelect id={`stage-gate-${stage.option}`} className="w-full" value={gates[stage.option] ?? ""}
                  onChange={(event) => {
                    if (event.target.value === createAction) { setCreatingFor(stage.option); return; }
                    const next = { ...gates };
                    if (event.target.value === "") delete next[stage.option]; else next[stage.option] = event.target.value;
                    change({ gates: next });
                  }}>
                  <NativeSelectOption value="">Is a plain save</NativeSelectOption>
                  {gatesFor(stage.option).map((action) => <NativeSelectOption key={action.key} value={action.key}>Runs {action.label}</NativeSelectOption>)}
                  <NativeSelectOption value={createAction}>Runs a new action…</NativeSelectOption>
                </NativeSelect></div>
            </ItemContent>
          </Item>)}</ul>
          <p className="text-xs text-muted-foreground">A gated stage runs its action wherever the option is saved: a board, a form or a flow
            step. Only people whose access groups hold the action&apos;s permission can move a record there.</p>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Allowed moves</legend>
          <p className="text-xs text-muted-foreground">Tick each move a record may make. Any other move between two stages is refused.</p>
          <div className="overflow-x-auto"><Table>
            <TableHeader><TableRow><TableHead>From</TableHead>
              {stages.map((stage) => <TableHead key={stage.option} className="whitespace-nowrap">To {label(stage.option)}</TableHead>)}</TableRow></TableHeader>
            <TableBody>{stages.map((from) => <TableRow key={from.option}>
              <TableHead scope="row" className="whitespace-nowrap">{label(from.option)}</TableHead>
              {stages.map((to) => <TableCell key={to.option}>{from.option === to.option ? <span className="text-muted-foreground">–</span>
                : <Checkbox aria-label={`Allow ${label(from.option)} to ${label(to.option)}`} checked={allowed(from.option, to.option)}
                  onCheckedChange={(checked) => change({ transitions: checked === true ? [...moves, { from: from.option, to: to.option }]
                    : moves.filter((move) => !(move.from === from.option && move.to === to.option)) })} />}</TableCell>)}
            </TableRow>)}</TableBody>
          </Table></div>
        </fieldset>

        <Problems issues={issues} />
        {where === undefined ? null : <Refused refusal={where} label="Where it is used" onShow={(reference) => { onClose(); onShow(reference); }} />}
        <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </div>
      {creatingFor === undefined ? null : <ActionDialog key={creatingFor} module={module} record={record} action={undefined} open
        initialEffect={{ field: stageField, option: creatingFor }} edit={edit} onShow={onShow}
        onOpenChange={(open) => { if (!open) setCreatingFor(undefined); }}
        onSaved={(actionKey) => change({ gates: { ...gates, [creatingFor]: actionKey } })} />}
      {confirmDialog}
    </DialogContent>
  </Dialog>;
}

export function StudioRecordPipelines({ source, moduleKey, recordKey, publication, disabled, edit, onShow }: Readonly<{
  source: Source; moduleKey: string; recordKey: string; publication: ModuleFieldPublication; disabled: boolean;
  edit: StudioDataEdit;
  onShow: (reference: InlineRecordTypeReference) => void;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [refusal, setRefusal] = useState<Refusal>();
  const [issues, setIssues] = useState<readonly string[]>([]);
  const located = locate(source, moduleKey, recordKey);
  if (located === undefined) return null;
  const { module, record } = located;
  const free = record.fields.some((field) => field.type === "choice" && !record.pipelines.some((pipeline) => pipeline.stage_field === field.key));
  const remove = async (pipeline: Pipeline) => {
    setIssues([]); setRefusal(undefined);
    const check = deleteInlinePipeline(source, module.key, record.key, pipeline.key);
    if (check.kind === "referenced") { setRefusal({ issue: `${pipeline.name} can't be deleted. ${check.issue}`, references: check.references }); return; }
    if (check.kind === "invalid") { setIssues(check.issues); return; }
    if (!await confirm({ title: `Delete ${pipeline.name}?`, confirmLabel: "Delete pipeline",
      description: "Its stage order, colours and moves leave the draft, and every move becomes allowed. Actions that own its stages keep them." })) return;
    const result = edit((current) => deleteInlinePipeline(current, module.key, record.key, pipeline.key));
    if (result.kind === "referenced") setRefusal({ issue: `${pipeline.name} can't be deleted. ${result.issue}`, references: result.references });
    else { const problem = studioEditProblem(result); if (problem !== undefined) setIssues([problem]); }
  };
  const chosen = editing === null || editing === "new" ? undefined : record.pipelines.find((pipeline) => pipeline.key === editing);
  return <section className="space-y-2 border-t border-border pt-3" aria-label={`Pipelines of ${record.plural_name}`}>
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">Pipelines</h3>
      <Button type="button" size="sm" variant="outline" disabled={disabled || !free} onClick={() => setEditing("new")}>Add a pipeline</Button>
    </div>
    {record.pipelines.length === 0 && <p className="text-sm text-muted-foreground">{free
      ? "No pipeline yet. A pipeline gives a choice field its stages, the moves between them and a board's columns."
      : "Add a choice field first: its options become the stages."}</p>}
    <ul className="space-y-2">{record.pipelines.map((pipeline) => {
      const options = optionsOf(record, pipeline.stage_field);
      const label = (value: string) => options.find((option) => option.value === value)?.label ?? value;
      const fieldLabel = record.fields.find((field) => field.key === pipeline.stage_field)?.label ?? pipeline.stage_field;
      return <Item key={pipeline.key} render={<li />} variant="outline" size="sm">
        <ItemHeader className="flex-wrap gap-2">
          <ItemTitle>{pipeline.name}</ItemTitle>
          <Badge variant="outline">{fieldLabel}</Badge>
          <ItemActions className="gap-1">
            <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setEditing(pipeline.key)}>Edit</Button>
            <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => { void remove(pipeline); }}>Delete</Button>
          </ItemActions>
        </ItemHeader>
        <ItemContent className="basis-full">
          <ItemDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">{pipeline.stages.map((stage) => {
            const owner = inlineOptionOwner(module, record, pipeline.stage_field, stage.option);
            return <span key={stage.option} className="inline-flex items-center gap-1">
              <StageSwatch tone={stage.tone} />{label(stage.option)}{owner === undefined ? null : ` (runs ${owner.label})`}</span>;
          })}</ItemDescription>
          <ItemDescription>{pipeline.transitions.length === 0 ? "No moves allowed yet."
            : `${pipeline.transitions.length} allowed ${pipeline.transitions.length === 1 ? "move" : "moves"}.`}</ItemDescription>
        </ItemContent>
      </Item>;
    })}</ul>
    {refusal === undefined ? null : <Refused refusal={refusal} label="Where the pipeline is used" onShow={onShow} />}
    <Problems issues={issues} />
    {editing === "new" && <NewPipelineDialog module={module} record={record} publication={publication} edit={edit}
      onClose={() => setEditing(null)} onCreated={setEditing} />}
    {chosen !== undefined && <PipelineDialog key={chosen.key} source={source} module={module} record={record} pipeline={chosen}
      publication={publication} edit={edit} onClose={() => setEditing(null)} onShow={onShow} />}
    {confirmDialog}
  </section>;
}
