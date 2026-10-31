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
import {
  StudioConditionControls,
  projectStudioActionCondition,
  remapStudioActionCondition,
  studioActionConditionContext,
  studioActionConditionSource,
  validateStudioCondition,
  type StudioConditionValidation,
  StudioOptionControl,
} from "@vortex/ui/studio";
import { studioEditProblem, type StudioDataEdit } from "../_lib/studio-data-model";
import { StudioReferencesAlert, StudioUsedIn, useStudioPlaceOpener } from "./studio-used-in";
import { StudioActionInputs } from "./studio-action-inputs";

type Module = ApplicationSourceDocument["body"]["modules"][number];
type RecordType = Module["record_types"][number];
type Action = Module["actions"][number];
type Field = RecordType["fields"][number];
const choiceOptions = (field: Field | undefined): readonly { value: string; label: string }[] =>
  field?.type === "choice"
    ? ((field.settings as { options?: { value: string; label: string }[] }).options ?? [])
    : [];

/** An action edit: its name, inputs, condition and permission. Its steps are its flow. */
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
  onSaved?: (actionKey: string, flowAlias: string | undefined) => void;
}>) {
  const [label, setLabel] = useState(action?.label ?? "");
  const [inputs, setInputs] = useState<Action["inputs"]>(() =>
    structuredClone(action?.inputs ?? []),
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
        inputs,
        permission: permission === "own" ? { kind: "own" } : { kind: "existing", key: permission },
        ownsChoice,
        ...(initialEffect === undefined ? {} : { initialEffect }),
      }),
    );
    if (result.kind === "referenced") setWhere(result.references);
    const problem = studioEditProblem(result);
    setIssues(problem === undefined ? [] : [problem]);
    if (result.kind === "changed") {
      onSaved?.(result.actionKey, result.flowAlias);
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
    if ((projected.kind === "condition" || replacing) && condition !== undefined) {
      const remapped = remapStudioActionCondition(condition, inputs, next, renamed);
      const valid = validateStudioCondition(
        remapped,
        studioActionConditionContext(record, next),
      ).isValid;
      // An edit that leaves the condition's inputs where they were keeps the saved precondition as written.
      if (
        renamed === undefined &&
        conditionProblem === "" &&
        valid &&
        JSON.stringify(remapped) === JSON.stringify(condition)
      )
        return;
      showCondition(remapped, next, valid);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>
              {action === undefined
                ? `New action of ${record.plural_name}`
                : `Change ${action.label}`}
            </DialogTitle>
            <DialogDescription>
              Choose the information this action needs and when it may run. What it does is its
              flow, edited in the flow editor.
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
            <StudioOptionControl
              id="action-permission"
              value={permission}
              disabled={false}
              options={[
                { value: "own", label: "Its own permission" },
                ...named
                  .filter((entry) => entry.key !== action?.key)
                  .map((entry) => ({ value: entry.key, label: entry.label })),
              ]}
              onChange={setPermission}
            />
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
  const opener = useStudioPlaceOpener();
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
          // Its own permission may reach nobody or allow no field: an action with neither cannot be
          // used until the builder gives it to roles and chooses its fields, so say the next step.
          const ownPermission = module.permissions.find(
            (permission) => permission.key === action.permission,
          );
          const permissionHeld = source.body.roles.some(
            (role) =>
              (action.permission !== undefined && role.permissions.includes(action.permission)) ||
              role.permissions.includes("*"),
          );
          const permissionAllowsNoFields =
            ownPermission !== undefined &&
            ownPermission.field_policy !== undefined &&
            ownPermission.field_policy.readable_fields.length === 0 &&
            ownPermission.field_policy.changeable_fields.length === 0;
          const permissionGuidance =
            action.protected_operation !== undefined
              ? undefined
              : !permissionHeld && permissionAllowsNoFields
                ? "Its permission is held by no role and allows no fields yet. Give it to roles in Access, then choose the fields it reads and changes."
                : !permissionHeld
                  ? "No role holds its permission yet, so no one can use this action. Give it to roles in Access."
                  : permissionAllowsNoFields
                    ? "Its permission allows no fields yet. Choose what it reads and changes in Access → Permissions."
                    : undefined;
          return (
            <Item key={action.key} render={<li />} variant="outline" size="sm">
              <ItemHeader className="flex-wrap gap-2">
                <ItemTitle>{action.label}</ItemTitle>
                {option === undefined ? null : <Badge variant="outline">Owns {option.label}</Badge>}
                <ItemActions className="gap-1">
                  {action.flow === undefined ? null : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        opener.open({
                          label: action.label,
                          open: { kind: "flow", flowAlias: action.flow!, moduleKey: module.key },
                        })
                      }
                    >
                      Edit flow
                    </Button>
                  )}
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
                {permissionGuidance === undefined ? null : (
                  <ItemDescription>{permissionGuidance}</ItemDescription>
                )}
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
          onSaved={(_actionKey, flowAlias) => {
            if (editing === "new" && flowAlias !== undefined)
              opener.open({
                label: "New action",
                open: { kind: "flow", flowAlias, moduleKey: module.key },
              });
          }}
        />
      )}
      {confirmDialog}
    </section>
  );
}
