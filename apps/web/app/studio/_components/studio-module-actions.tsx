"use client";
import { useMemo, useState, type FormEvent } from "react";
import {
  applicationUses,
  deleteInlineModuleAction,
  saveInlineModuleAction,
  type ApplicationSourceDocument,
  type ApplicationUsePlace,
  type ConditionNode,
  type InlineModuleActionPrecondition,
} from "@vortex/platform/schema";
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
  StudioConditionControls,
  projectStudioActionCondition,
  remapStudioActionCondition,
  studioActionConditionContext,
  studioActionConditionSource,
  validateStudioCondition,
  type StudioConditionValidation,
} from "@vortex/ui/studio";
import { studioEditProblem, type StudioDataEdit } from "../_lib/studio-data-model";
import { StudioReferencesAlert, StudioUsedIn } from "./studio-used-in";
import { StudioActionInputs } from "./studio-action-inputs";
import { StudioActionTasks } from "./studio-action-tasks";

type Module = ApplicationSourceDocument["body"]["modules"][number];
type RecordType = Module["record_types"][number];
type Action = Module["actions"][number];
type Field = RecordType["fields"][number];
const choiceOptions = (field: Field | undefined): readonly { value: string; label: string }[] =>
  field?.type === "choice"
    ? ((field.settings as { options?: { value: string; label: string }[] }).options ?? [])
    : [];

/** A complete action edit keeps ordered task values intact until the author saves. */
export function ActionDialog({
  source,
  module,
  record,
  action,
  open,
  onOpenChange,
  edit,
  initialEffect,
  onSaved,
}: Readonly<{
  source: ApplicationSourceDocument;
  module: Module;
  record: RecordType;
  action: Action | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  edit: StudioDataEdit;
  initialEffect?: Readonly<{ field: string; option: string }>;
  onSaved?: (actionKey: string) => void;
}>) {
  const [label, setLabel] = useState(action?.label ?? "");
  const [inputs, setInputs] = useState<Action["inputs"]>(() =>
    structuredClone(action?.inputs ?? []),
  );
  const [tasks, setTasks] = useState<Action["tasks"]>(() =>
    structuredClone(
      action?.tasks ??
        (initialEffect === undefined
          ? []
          : [
              {
                id: "set_fields",
                type: "record.set_fields",
                properties: {
                  values: {
                    [initialEffect.field]: {
                      kind: "literal",
                      literal: { type: "choice", value: initialEffect.option },
                    },
                  },
                },
              },
            ]),
    ),
  );
  const [permission, setPermission] = useState(
    action?.permission === action?.key ? "own" : (action?.permission ?? "own"),
  );
  const [ownsChoice, setOwnsChoice] = useState(
    action?.sets_choice_field !== undefined || initialEffect !== undefined,
  );
  const [precondition, setPrecondition] = useState<InlineModuleActionPrecondition | undefined>(
    action?.precondition,
  );
  // The saved precondition is projected once, against the saved inputs; later input edits remap it.
  const [projected] = useState(() =>
    projectStudioActionCondition(action?.precondition, record, inputs),
  );
  const context = useMemo(() => studioActionConditionContext(record, inputs), [record, inputs]);
  const [condition, setCondition] = useState<ConditionNode | undefined>(
    projected.kind === "condition" ? projected.condition : undefined,
  );
  const [replacing, setReplacing] = useState(false);
  const [conditionProblem, setConditionProblem] = useState("");
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [where, setWhere] = useState<readonly ApplicationUsePlace[]>([]);
  const named = module.permissions.filter(
    (entry) => entry.action_kind === "named" && entry.record_type === record.key,
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (conditionProblem !== "") {
      setIssues([conditionProblem]);
      return;
    }
    const result = edit((current) =>
      saveInlineModuleAction(current, {
        moduleKey: module.key,
        recordKey: record.key,
        ...(action === undefined ? {} : { actionKey: action.key }),
        label,
        precondition,
        tasks,
        inputs,
        permission: permission === "own" ? { kind: "own" } : { kind: "existing", key: permission },
        ownsChoice,
      }),
    );
    if (result.kind === "referenced") setWhere(result.references);
    const problem = studioEditProblem(result);
    setIssues(problem === undefined ? [] : [problem]);
    if (result.kind === "changed") {
      onSaved?.(result.actionKey);
      onOpenChange(false);
    }
  };
  const showCondition = (
    next: ConditionNode | undefined,
    nextInputs: Action["inputs"],
    valid: boolean,
  ) => {
    setCondition(next);
    const built = valid
      ? studioActionConditionSource(next, record, nextInputs)
      : { ok: false as const };
    setConditionProblem(built.ok ? "" : "Finish every comparison, with a value on both sides.");
    if (built.ok) setPrecondition(built.condition);
  };
  const changeCondition = (
    next: ConditionNode | undefined,
    validation: StudioConditionValidation,
  ) => showCondition(next, inputs, validation.isValid);
  const changeInputs = (
    next: Action["inputs"],
    renamed?: Readonly<{ from: string; to: string }>,
  ) => {
    setInputs(next);
    // A condition comparing an input follows that input when inputs move, are renamed or removed.
    if (projected.kind === "condition" || replacing) {
      const remapped = remapStudioActionCondition(condition, inputs, next, renamed);
      const valid = validateStudioCondition(
        remapped,
        studioActionConditionContext(record, next),
      ).isValid;
      showCondition(remapped, next, valid);
    }
    if (renamed === undefined) return;
    // Only unsaved inputs are renamed. Carry their task references along, leaving literal data alone.
    const rename = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(rename);
      if (value === null || typeof value !== "object") return value;
      const entry = value as Record<string, unknown>;
      if (entry.kind === "literal") return value;
      if (entry.source === "input" && entry.name === renamed.from)
        return { ...entry, name: renamed.to };
      return Object.fromEntries(
        Object.entries(entry).map(([key, child]) => [
          key,
          key === "target_input" && child === renamed.from ? renamed.to : rename(child),
        ]),
      );
    };
    setTasks((current) => rename(current) as Action["tasks"]);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-screen overflow-y-auto sm:max-w-3xl">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>
              {action === undefined
                ? `New action of ${record.plural_name}`
                : `Change ${action.label}`}
            </DialogTitle>
            <DialogDescription>
              Choose the information this action needs and the steps it runs in order.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="action-name">Name</Label>
            <Input
              id="action-name"
              required
              maxLength={60}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <StudioActionInputs inputs={inputs} source={source} onChange={changeInputs} />
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Runs only when</legend>
            {projected.kind === "unsupported" && !replacing ? (
              <div className="space-y-2 text-sm">
                <p>
                  This condition uses a calculation these controls cannot offer. Change it with
                  Import from source in the Releases tab, or replace it below.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setReplacing(true)}
                >
                  Replace it
                </Button>
              </div>
            ) : (
              <StudioConditionControls
                {...(condition === undefined ? {} : { value: condition })}
                context={context}
                label="Runs only when"
                onChange={changeCondition}
              />
            )}
            {conditionProblem === "" ? null : (
              <p role="alert" className="text-sm text-destructive">
                {conditionProblem}
              </p>
            )}
          </fieldset>
          <StudioActionTasks
            source={source}
            module={module}
            record={record}
            inputs={inputs}
            tasks={tasks}
            onChange={setTasks}
          />
          <div className="flex items-start gap-2">
            <Checkbox
              id="action-owns"
              checked={ownsChoice}
              onCheckedChange={(checked) => setOwnsChoice(checked === true)}
            />
            <Label htmlFor="action-owns" className="font-normal">
              Saving the fixed choice option set by this action runs the action, with its condition
              and permission.
            </Label>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="action-permission">Permission</Label>
            <NativeSelect
              id="action-permission"
              className="w-full"
              value={permission}
              onChange={(event) => setPermission(event.target.value)}
            >
              <NativeSelectOption value="own">Its own permission</NativeSelectOption>
              {named
                .filter((entry) => entry.key !== action?.key)
                .map((entry) => (
                  <NativeSelectOption key={entry.key} value={entry.key}>
                    {entry.label}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </div>
          {issues.length === 0 ? null : (
            <ul role="alert" className="space-y-1 text-sm text-destructive">
              {issues.map((issue, index) => (
                <li key={index}>{issue}</li>
              ))}
            </ul>
          )}
          <StudioReferencesAlert
            name="the action's own permission"
            title="The action's own permission cannot be left behind"
            references={where}
            onBeforeOpen={() => onOpenChange(false)}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">{action === undefined ? "Add action" : "Save action"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function StudioModuleActions({
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
  const [confirm, confirmDialog] = useConfirm();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [refused, setRefused] =
    useState<Readonly<{ label: string; references: readonly ApplicationUsePlace[] }>>();
  const [refusals, setRefusals] = useState(0);
  const module = source.body.modules.find((item) => item.key === moduleKey);
  const record = module?.record_types.find((item) => item.key === recordKey);
  if (module === undefined || record === undefined) return null;
  const actions = module.actions.filter((action) => action.record_type === record.key);
  const remove = async (action: Action) => {
    setIssues([]);
    setRefused(undefined);
    const check = deleteInlineModuleAction(source, module.key, action.key);
    if (check.kind === "referenced") {
      setRefused({ label: action.label, references: check.references });
      setRefusals((value) => value + 1);
      return;
    }
    if (check.kind === "invalid") {
      setIssues(check.issues);
      return;
    }
    if (
      !(await confirm({
        title: `Delete ${action.label}?`,
        confirmLabel: "Delete action",
        description: "The action and its own permission leave the draft. Undo brings them back.",
      }))
    )
      return;
    const result = edit((current) => deleteInlineModuleAction(current, module.key, action.key));
    if (result.kind === "referenced") {
      setRefused({ label: action.label, references: result.references });
      setRefusals((value) => value + 1);
    } else {
      const problem = studioEditProblem(result);
      if (problem !== undefined) setIssues([problem]);
    }
  };
  const chosen =
    editing === null || editing === "new"
      ? undefined
      : actions.find((action) => action.key === editing);
  return (
    <section
      className="space-y-2 border-t border-border pt-3"
      aria-label={`Actions of ${record.plural_name}`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Actions</h3>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => setEditing("new")}
        >
          Add an action
        </Button>
      </div>
      {actions.length === 0 && (
        <p className="text-sm text-muted-foreground">No named actions yet, such as Mark won.</p>
      )}
      <ul className="space-y-2">
        {actions.map((action) => {
          const target = { kind: "action", moduleKey: module.key, actionKey: action.key } as const;
          const unused = applicationUses(source, target).length === 0;
          const option =
            action.sets_choice_field === undefined
              ? undefined
              : choiceOptions(
                  record.fields.find((field) => field.key === action.sets_choice_field),
                ).find((entry) => entry.value === action.sets_choice_option);
          return (
            <Item key={action.key} render={<li />} variant="outline" size="sm">
              <ItemHeader className="flex-wrap gap-2">
                <ItemTitle>{action.label}</ItemTitle>
                {option === undefined ? null : <Badge variant="outline">Owns {option.label}</Badge>}
                <ItemActions className="gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled || action.protected_operation !== undefined}
                    onClick={() => setEditing(action.key)}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => {
                      void remove(action);
                    }}
                  >
                    Delete
                  </Button>
                </ItemActions>
              </ItemHeader>
              <ItemContent className="basis-full space-y-1">
                {action.protected_operation !== undefined ? (
                  <ItemDescription>
                    Runs a registered operation of the platform; it is not changed here.
                  </ItemDescription>
                ) : unused ? (
                  <ItemDescription>
                    No flow runs it yet. Add a button, then Create workflow in its inspector with a
                    Save record step that saves this option.
                  </ItemDescription>
                ) : null}
                {unused ? null : (
                  <StudioUsedIn source={source} target={target} name={action.label} collapsed />
                )}
              </ItemContent>
            </Item>
          );
        })}
      </ul>
      {refused === undefined ? null : (
        <StudioReferencesAlert
          key={refusals}
          name={refused.label}
          action="deleted"
          references={refused.references}
        />
      )}
      {issues.length === 0 ? null : (
        <ul role="alert" className="space-y-1 text-sm text-destructive">
          {issues.map((issue, index) => (
            <li key={index}>{issue}</li>
          ))}
        </ul>
      )}
      {editing !== null && (editing === "new" || chosen !== undefined) && (
        <ActionDialog
          key={editing}
          source={source}
          module={module}
          record={record}
          action={chosen}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          edit={edit}
        />
      )}
      {confirmDialog}
    </section>
  );
}
