"use client";
import { useState, type FormEvent } from "react";
import {
  deleteInlinePipeline,
  inlineActionSetsOption,
  inlineChoiceOptionReferences,
  inlineOptionOwner,
  pipelineStageTones,
  saveInlinePipeline,
  type ApplicationSourceDocument,
  type InlineRecordTypeReference,
  type ModuleFieldPublication,
  type PipelineStageTone,
} from "@vortex/platform/schema";
import { Icon } from "@vortex/ui";
import { Alert, AlertDescription, AlertTitle } from "@vortex/ui/components/alert";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vortex/ui/components/dialog";
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
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vortex/ui/components/table";
import { ActionDialog } from "./studio-module-actions";

/**
 * The pipelines of a record type, on the Data tab: each follows one choice field, whose options are
 * its stages. A pipeline sets the order and colour role of its stages, the moves between them a save
 * accepts, and which named action owns a gated stage, so moving there runs that action with its
 * permission and condition. Boards over its field take their columns and drag rules from it.
 */

type Module = ApplicationSourceDocument["body"]["modules"][number];
type RecordType = Module["record_types"][number];
type Pipeline = RecordType["pipelines"][number];
type Option = Readonly<{ value: string; label: string }>;

const toneLabels: Readonly<Record<PipelineStageTone, string>> = {
  neutral: "Neutral",
  primary: "Primary",
  destructive: "Alert",
  chart_1: "Chart colour 1",
  chart_2: "Chart colour 2",
  chart_3: "Chart colour 3",
  chart_4: "Chart colour 4",
  chart_5: "Chart colour 5",
};
/** Each colour role as its theme token. */
const toneClasses: Readonly<Record<PipelineStageTone, string>> = {
  neutral: "bg-muted-foreground",
  primary: "bg-primary",
  destructive: "bg-destructive",
  chart_1: "bg-chart-1",
  chart_2: "bg-chart-2",
  chart_3: "bg-chart-3",
  chart_4: "bg-chart-4",
  chart_5: "bg-chart-5",
};
const createAction = "__create_action__";

const optionsOf = (record: RecordType, fieldKey: string): readonly Option[] => {
  const field = record.fields.find((candidate) => candidate.key === fieldKey);
  return field?.type === "choice" ? (field.settings as { options: Option[] }).options : [];
};

function Where({
  references,
  onShow,
  label,
}: Readonly<{
  references: readonly InlineRecordTypeReference[];
  onShow: (reference: InlineRecordTypeReference) => void;
  label: string;
}>) {
  const [showing, setShowing] = useState(false);
  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="xs"
        variant="outline"
        aria-expanded={showing}
        onClick={() => setShowing(!showing)}
      >
        {showing ? "Hide where" : "Show me where"}
      </Button>
      {showing && (
        <ul className="list-disc space-y-1 pl-5" aria-label={label}>
          {references.map((reference) => (
            <li key={reference.label} className="break-words">
              {reference.open.kind === "none" ? (
                reference.label
              ) : (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto whitespace-normal p-0 text-left"
                  onClick={() => onShow(reference)}
                >
                  {reference.label}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StageSwatch({ tone }: Readonly<{ tone: PipelineStageTone }>) {
  return (
    <span aria-hidden="true" className={`inline-block h-4 w-1 shrink-0 ${toneClasses[tone]}`} />
  );
}

function PipelineDialog({
  source,
  module,
  record,
  pipeline,
  publication,
  onClose,
  apply,
  applyAction,
  onShow,
}: Readonly<{
  source: ApplicationSourceDocument;
  module: Module;
  record: RecordType;
  pipeline: Pipeline | undefined;
  publication: ModuleFieldPublication;
  onClose: () => void;
  apply: (next: ApplicationSourceDocument, message: string) => boolean;
  /** Applies a new gate action while this dialog stays open with what the person has set. */
  applyAction: (next: ApplicationSourceDocument, message: string) => boolean;
  onShow: (reference: InlineRecordTypeReference) => void;
}>) {
  const free = record.fields.filter(
    (field) =>
      field.type === "choice" &&
      !record.pipelines.some((candidate) => candidate.stage_field === field.key),
  );
  const [name, setName] = useState(pipeline?.name ?? "");
  const [stageField, setStageField] = useState(pipeline?.stage_field ?? free[0]?.key ?? "");
  const stagesFor = (fieldKey: string) =>
    optionsOf(record, fieldKey).map((option) => ({
      option: option.value,
      tone: "neutral" as PipelineStageTone,
    }));
  const [stages, setStages] = useState(
    () => pipeline?.stages.map((stage) => ({ ...stage })) ?? stagesFor(stageField),
  );
  const [moves, setMoves] = useState<readonly { from: string; to: string }[]>(
    () => pipeline?.transitions ?? [],
  );
  const ownerOf = (fieldKey: string, option: string) =>
    inlineOptionOwner(module, record, fieldKey, option)?.key;
  const [gates, setGates] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      stagesFor(stageField).flatMap(({ option }) => {
        const owner = ownerOf(stageField, option);
        return owner === undefined ? [] : [[option, owner]];
      }),
    ),
  );
  const [removed, setRemoved] = useState<readonly string[]>([]);
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [where, setWhere] =
    useState<Readonly<{ issue: string; references: readonly InlineRecordTypeReference[] }>>();
  const [creatingFor, setCreatingFor] = useState<string>();
  const options = optionsOf(record, stageField);
  const label = (value: string) => options.find((option) => option.value === value)?.label ?? value;
  const field = record.fields.find((candidate) => candidate.key === stageField);
  const shown = stages.filter((stage) => !removed.includes(stage.option));
  const allowed = (from: string, to: string) =>
    moves.some((move) => move.from === from && move.to === to);
  const gatesFor = (option: string) =>
    module.actions.filter((action) => inlineActionSetsOption(record, action, stageField, option));
  const reset = () => {
    setIssues([]);
    setWhere(undefined);
  };

  const chooseField = (next: string) => {
    setStageField(next);
    setStages(stagesFor(next));
    setMoves([]);
    setRemoved([]);
    setGates(
      Object.fromEntries(
        stagesFor(next).flatMap(({ option }) => {
          const owner = ownerOf(next, option);
          return owner === undefined ? [] : [[option, owner]];
        }),
      ),
    );
    reset();
  };
  const moveStage = (index: number, by: -1 | 1) => {
    const next = [...stages];
    const [moved] = next.splice(index, 1);
    next.splice(index + by, 0, moved!);
    setStages(next);
    reset();
  };
  const removeStage = (option: string) => {
    reset();
    const references = inlineChoiceOptionReferences(
      source,
      module.key,
      record.key,
      stageField,
      option,
    );
    if (references.length > 0) {
      setWhere({
        issue: `${label(option)} can't be removed: it is used in ${references.length === 1 ? "one place" : `${references.length} places`}. Remove those uses first.`,
        references,
      });
      return;
    }
    if (publication.fields.has(`${module.key}:${record.key}.${stageField}`)) {
      setIssues([
        `${label(option)} can't be removed: ${field?.label ?? "the field"} is in a published version, and records already stored may hold it.`,
      ]);
      return;
    }
    setRemoved([...removed, option]);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    reset();
    const result = saveInlinePipeline(
      source,
      {
        moduleKey: module.key,
        recordKey: record.key,
        ...(pipeline === undefined ? {} : { pipelineKey: pipeline.key }),
        name,
        stageField,
        stages,
        transitions: moves,
        gates,
        removedOptions: removed,
      },
      publication,
    );
    if (result.kind === "invalid") {
      setIssues(result.issues);
      return;
    }
    if (result.kind === "referenced") {
      setWhere({ issue: result.issue, references: result.references });
      return;
    }
    if (
      apply(
        result.source,
        `Pipeline ${name.trim()} ${pipeline === undefined ? "added" : "changed"}. Save to keep it.`,
      )
    )
      onClose();
    else
      setIssues(["The draft changed or is busy, so nothing was changed. Try again in a moment."]);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-screen overflow-y-auto sm:max-w-3xl">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>
              {pipeline === undefined
                ? `New pipeline of ${record.plural_name}`
                : `Change ${pipeline.name}`}
            </DialogTitle>
            <DialogDescription>
              The stages a {record.name.toLowerCase()} moves through, the moves between them, and
              which stages need an action.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="pipeline-name">Name</Label>
            <Input
              id="pipeline-name"
              required
              maxLength={60}
              value={name}
              placeholder="Asset lifecycle"
              onChange={(event) => {
                setName(event.target.value);
                reset();
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pipeline-field">Stages come from</Label>
            {pipeline !== undefined ? (
              <p className="text-sm">
                {field?.label ?? stageField}. A pipeline keeps the field it follows.
              </p>
            ) : (
              <NativeSelect
                id="pipeline-field"
                className="w-full"
                value={stageField}
                onChange={(event) => chooseField(event.target.value)}
              >
                {free.map((candidate) => (
                  <NativeSelectOption key={candidate.key} value={candidate.key}>
                    {candidate.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
            <p className="text-xs text-muted-foreground">
              Each option of the choice field is one stage. Add options in the field&apos;s editor.
            </p>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Stages, in board order</legend>
            <ul className="space-y-2">
              {shown.map((stage) => {
                const index = stages.indexOf(stage);
                const candidates = gatesFor(stage.option);
                return (
                  <Item key={stage.option} render={<li />} variant="outline" size="sm">
                    <ItemHeader className="flex-wrap gap-2">
                      <ItemTitle className="gap-2">
                        <StageSwatch tone={stage.tone} />
                        {label(stage.option)}
                      </ItemTitle>
                      <ItemActions className="gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-sm"
                          aria-label={`Move ${label(stage.option)} earlier`}
                          disabled={index === 0}
                          onClick={() => moveStage(index, -1)}
                        >
                          <Icon name="arrow-up" />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-sm"
                          aria-label={`Move ${label(stage.option)} later`}
                          disabled={index === stages.length - 1}
                          onClick={() => moveStage(index, 1)}
                        >
                          <Icon name="arrow-down" />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => removeStage(stage.option)}
                        >
                          Remove stage
                        </Button>
                      </ItemActions>
                    </ItemHeader>
                    <ItemContent className="basis-full grid gap-2 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor={`stage-tone-${stage.option}`}>Colour</Label>
                        <NativeSelect
                          id={`stage-tone-${stage.option}`}
                          className="w-full"
                          value={stage.tone}
                          onChange={(event) => {
                            setStages(
                              stages.map((entry) =>
                                entry === stage
                                  ? { ...entry, tone: event.target.value as PipelineStageTone }
                                  : entry,
                              ),
                            );
                            reset();
                          }}
                        >
                          {pipelineStageTones.map((tone) => (
                            <NativeSelectOption key={tone} value={tone}>
                              {toneLabels[tone]}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`stage-gate-${stage.option}`}>Moving here</Label>
                        <NativeSelect
                          id={`stage-gate-${stage.option}`}
                          className="w-full"
                          value={gates[stage.option] ?? ""}
                          onChange={(event) => {
                            reset();
                            if (event.target.value === createAction) {
                              setCreatingFor(stage.option);
                              return;
                            }
                            const next = { ...gates };
                            if (event.target.value === "") delete next[stage.option];
                            else next[stage.option] = event.target.value;
                            setGates(next);
                          }}
                        >
                          <NativeSelectOption value="">Is a plain save</NativeSelectOption>
                          {candidates.map((action) => (
                            <NativeSelectOption key={action.key} value={action.key}>
                              Runs {action.label}
                            </NativeSelectOption>
                          ))}
                          <NativeSelectOption value={createAction}>
                            Runs a new action…
                          </NativeSelectOption>
                        </NativeSelect>
                      </div>
                    </ItemContent>
                  </Item>
                );
              })}
            </ul>
            {removed.length === 0 ? null : (
              <p className="text-sm text-muted-foreground">
                Removed when you apply: {removed.map(label).join(", ")}.{" "}
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() => setRemoved([])}
                >
                  Keep them
                </Button>
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              A gated stage runs its action wherever the option is saved: a board, a form or a flow
              step. Only people whose access groups hold the action&apos;s permission can move a
              record there.
            </p>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Allowed moves</legend>
            <p className="text-xs text-muted-foreground">
              Tick each move a record may make. Any other move between two stages is refused.
            </p>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>From</TableHead>
                    {shown.map((stage) => (
                      <TableHead key={stage.option} className="whitespace-nowrap">
                        To {label(stage.option)}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((from) => (
                    <TableRow key={from.option}>
                      <TableHead scope="row" className="whitespace-nowrap">
                        {label(from.option)}
                      </TableHead>
                      {shown.map((to) => (
                        <TableCell key={to.option}>
                          {from.option === to.option ? (
                            <span className="text-muted-foreground">–</span>
                          ) : (
                            <Checkbox
                              aria-label={`Allow ${label(from.option)} to ${label(to.option)}`}
                              checked={allowed(from.option, to.option)}
                              onCheckedChange={(checked) => {
                                setMoves(
                                  checked === true
                                    ? [...moves, { from: from.option, to: to.option }]
                                    : moves.filter(
                                        (move) =>
                                          !(move.from === from.option && move.to === to.option),
                                      ),
                                );
                                reset();
                              }}
                            />
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </fieldset>

          {issues.length === 0 ? null : (
            <ul role="alert" className="space-y-1 text-sm text-destructive">
              {issues.map((issue, index) => (
                <li key={index} className="break-words">
                  {issue}
                </li>
              ))}
            </ul>
          )}
          {where === undefined ? null : (
            <Alert variant="destructive" role="alert">
              <AlertTitle>Refused</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>{where.issue}</p>
                <Where
                  references={where.references}
                  label="Where it is used"
                  onShow={(reference) => {
                    onClose();
                    onShow(reference);
                  }}
                />
              </AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={free.length === 0 && pipeline === undefined}>
              {pipeline === undefined ? "Add pipeline" : "Apply"}
            </Button>
          </DialogFooter>
        </form>
        {creatingFor === undefined ? null : (
          <ActionDialog
            key={creatingFor}
            source={source}
            module={module}
            record={record}
            action={undefined}
            open
            initialEffect={{ field: stageField, option: creatingFor }}
            onOpenChange={(open) => {
              if (!open) setCreatingFor(undefined);
            }}
            onSave={applyAction}
            onShow={onShow}
            onSaved={(actionKey) => setGates({ ...gates, [creatingFor]: actionKey })}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function StudioRecordPipelines({
  source,
  moduleKey,
  recordKey,
  publication,
  disabled,
  apply,
  applyAction,
  onShow,
}: Readonly<{
  source: ApplicationSourceDocument;
  moduleKey: string;
  recordKey: string;
  publication: ModuleFieldPublication;
  disabled: boolean;
  apply: (next: ApplicationSourceDocument, message: string) => boolean;
  applyAction: (next: ApplicationSourceDocument, message: string) => boolean;
  onShow: (reference: InlineRecordTypeReference) => void;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [refusal, setRefusal] =
    useState<Readonly<{ issue: string; references: readonly InlineRecordTypeReference[] }>>();
  const [issues, setIssues] = useState<readonly string[]>([]);
  const module = source.body.modules.find((item) => item.key === moduleKey);
  const record = module?.record_types.find((item) => item.key === recordKey);
  if (module === undefined || record === undefined) return null;
  const free = record.fields.some(
    (field) =>
      field.type === "choice" &&
      !record.pipelines.some((pipeline) => pipeline.stage_field === field.key),
  );
  const remove = async (pipeline: Pipeline) => {
    setIssues([]);
    setRefusal(undefined);
    const result = deleteInlinePipeline(source, module.key, record.key, pipeline.key);
    if (result.kind === "referenced") {
      setRefusal({
        issue: `${pipeline.name} can't be deleted. ${result.issue}`,
        references: result.references,
      });
      return;
    }
    if (result.kind === "invalid") {
      setIssues(result.issues);
      return;
    }
    if (
      !(await confirm({
        title: `Delete ${pipeline.name}?`,
        confirmLabel: "Delete pipeline",
        description:
          "Its stage order, colours and moves leave the draft, and every move becomes allowed. Actions that own its stages keep them.",
      }))
    )
      return;
    if (!apply(result.source, `Pipeline ${pipeline.name} deleted. Save to keep it.`))
      setIssues(["The draft changed or is busy, so nothing was deleted. Try again in a moment."]);
  };
  const chosen =
    editing === null || editing === "new"
      ? undefined
      : record.pipelines.find((pipeline) => pipeline.key === editing);
  return (
    <section
      className="space-y-2 border-t border-border pt-3"
      aria-label={`Pipelines of ${record.plural_name}`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Pipelines</h3>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || !free}
          onClick={() => setEditing("new")}
        >
          Add a pipeline
        </Button>
      </div>
      {record.pipelines.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {free
            ? "No pipeline yet. A pipeline gives a choice field its stages, the moves between them and a board's columns."
            : "Add a choice field first: its options become the stages."}
        </p>
      )}
      <ul className="space-y-2">
        {record.pipelines.map((pipeline) => {
          const options = optionsOf(record, pipeline.stage_field);
          const label = (value: string) =>
            options.find((option) => option.value === value)?.label ?? value;
          const fieldLabel =
            record.fields.find((field) => field.key === pipeline.stage_field)?.label ??
            pipeline.stage_field;
          return (
            <Item key={pipeline.key} render={<li />} variant="outline" size="sm">
              <ItemHeader className="flex-wrap gap-2">
                <ItemTitle>{pipeline.name}</ItemTitle>
                <Badge variant="outline">{fieldLabel}</Badge>
                <ItemActions className="gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => setEditing(pipeline.key)}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => {
                      void remove(pipeline);
                    }}
                  >
                    Delete
                  </Button>
                </ItemActions>
              </ItemHeader>
              <ItemContent className="basis-full">
                <ItemDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {pipeline.stages.map((stage) => {
                    const owner = inlineOptionOwner(
                      module,
                      record,
                      pipeline.stage_field,
                      stage.option,
                    );
                    return (
                      <span key={stage.option} className="inline-flex items-center gap-1">
                        <StageSwatch tone={stage.tone} />
                        {label(stage.option)}
                        {owner === undefined ? null : ` (runs ${owner.label})`}
                      </span>
                    );
                  })}
                </ItemDescription>
                <ItemDescription>
                  {pipeline.transitions.length === 0
                    ? "No moves allowed yet."
                    : `${pipeline.transitions.length} allowed ${pipeline.transitions.length === 1 ? "move" : "moves"}.`}
                </ItemDescription>
              </ItemContent>
            </Item>
          );
        })}
      </ul>
      {refusal === undefined ? null : (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Refused</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{refusal.issue}</p>
            <Where
              references={refusal.references}
              label="Where the pipeline is used"
              onShow={onShow}
            />
          </AlertDescription>
        </Alert>
      )}
      {issues.length === 0 ? null : (
        <ul role="alert" className="space-y-1 text-sm text-destructive">
          {issues.map((issue, index) => (
            <li key={index}>{issue}</li>
          ))}
        </ul>
      )}
      {editing !== null && (
        <PipelineDialog
          key={editing}
          source={source}
          module={module}
          record={record}
          pipeline={chosen}
          publication={publication}
          onClose={() => setEditing(null)}
          apply={apply}
          applyAction={applyAction}
          onShow={onShow}
        />
      )}
      {confirmDialog}
    </section>
  );
}
