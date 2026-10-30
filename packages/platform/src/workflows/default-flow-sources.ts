import type { SourceFlow } from "./flow-source-contracts";

/**
 * The generated default flows (architecture decision 2): the default Save of a form is one
 * `record.save` task and the default Query of a component is one `record.query` task. A builder
 * with the builder permission may add tasks before or after the one generated task; nothing else
 * about a default is special, so each is an ordinary application-owned flow with a permanent
 * identity once compiled.
 *
 * These builders are pure. They are called when a default is authored, never while a page renders
 * or a flow runs, and they only assemble source: every alias they carry is resolved, and every
 * placement, type and reference is checked, by the one flow compiler and validator.
 *
 * A refused, conflict, validation or uncertain result needs no task of its own. The flow's default
 * error handler shows each of them safely, so the one task is the whole flow.
 */

type DefaultFlowIdentity = Readonly<{
  /** The flow's owner alias and its readable key; both resolve to one permanent flow identity. */
  id: string;
  key: string;
  description?: string;
}>;

const taskVersion = "1.0.0";

const textLiteral = (value: string) =>
  ({ kind: "literal", literal: { type: "text", value } }) as const;

type Task = SourceFlow["tasks"][number];

const inputReference = (name: string) =>
  ({ kind: "reference", reference: { source: "input", name } }) as const;
const outputReference = (task: string, key: string) =>
  ({ kind: "reference", reference: { source: "task_output", task, key } }) as const;

const showMessage = (
  id: string,
  text: string | ReturnType<typeof outputReference>,
  options: Readonly<{
    target?: "toast" | "dialog" | "inline";
    severity?: "info" | "success" | "warning" | "error";
    component?: string;
    title?: string;
    action?: Readonly<{ label: string; flow: string; inputs: Readonly<Record<string, string>> }>;
  }> = {},
): Task =>
  ({
    id,
    type: "interface.show_message",
    version: taskVersion,
    properties: {
      message: typeof text === "string" ? textLiteral(text) : text,
      target: textLiteral(options.target ?? "toast"),
      severity: textLiteral(options.severity ?? "success"),
      ...(options.component === undefined ? {} : { component: textLiteral(options.component) }),
      ...(options.title === undefined ? {} : { title: textLiteral(options.title) }),
      ...(options.action === undefined
        ? {}
        : {
            action_label: textLiteral(options.action.label),
            action_flow: textLiteral(options.action.flow),
            action_inputs: { kind: "map", entries: options.action.inputs },
          }),
    },
  }) as unknown as Task;

const refreshTask = (id: string): Task =>
  ({ id, type: "interface.refresh", version: taskVersion, properties: {} }) as unknown as Task;

const navigateTask = (id: string, page: string, recordId?: string): Task =>
  ({
    id,
    type: "interface.navigate",
    version: taskVersion,
    properties: {
      page: textLiteral(page),
      ...(recordId === undefined
        ? {}
        : { parameters: { kind: "map", entries: { record_id: recordId } } }),
    },
  }) as unknown as Task;

/** What a default flow does last: open a page (with the record, when it has one) or refresh the page's data. */
export type DefaultFlowAfter =
  | Readonly<{ kind: "navigate"; page: string; withRecord: boolean }>
  | Readonly<{ kind: "refresh" }>
  | Readonly<{ kind: "none" }>;

const afterTasks = (after: DefaultFlowAfter, record: string): readonly Task[] =>
  after.kind === "navigate"
    ? [navigateTask("open_page", after.page, after.withRecord ? record : undefined)]
    : after.kind === "refresh"
      ? [refreshTask("refresh")]
      : [];

const recordReferenceInput = (recordType: string) => ({
  type: "record_reference" as const,
  recordTypeIds: [recordType],
  required: true,
});

const interactiveSource = (
  identity: DefaultFlowIdentity,
  parts: Pick<SourceFlow, "inputs" | "tasks" | "outputs"> &
    Readonly<{ errors?: SourceFlow["errors"] }>,
): SourceFlow => ({
  id: identity.id,
  key: identity.key,
  ...(identity.description === undefined ? {} : { description: identity.description }),
  labels: {},
  execution: "interactive",
  runAs: { kind: "initiator" },
  inputs: parts.inputs,
  variables: {},
  triggers: [],
  tasks: parts.tasks,
  outputs: parts.outputs,
  errors: parts.errors ?? [],
  finally: [],
});

export type DefaultSaveFlowInput = DefaultFlowIdentity &
  Readonly<{
    /** The record type the form saves: `key` in the owning definition or `definition.key:key`. */
    recordType: string;
    /** `create` saves the form's values as a new record; `update` saves them onto `record`. */
    mode: "create" | "update";
    /** The published record type's ownership mode determines whether create needs a Group. */
    ownershipMode: "none" | "organization_account" | "group" | "inherited";
    /** The placement alias of the form the flow validates and reports under. */
    form: string;
    /** What follows a save: the saved record's page, the list, or a refresh of the page's data. */
    after: DefaultFlowAfter;
  }>;

/**
 * The default Save of one form, every step visible: validate the form, (an update with nothing
 * changed says so and stops,) save the record, then a "Saved" toast, or a dialog with the rules'
 * warnings when the save carried any, then the page the person goes on to. The invoking form
 * supplies its answers as the `values` input and, when it edits a record, that record as the
 * `record` input, so a form binding maps both by name and no save is hidden in the page.
 */
export const defaultSaveFlowSource = (input: DefaultSaveFlowInput): SourceFlow =>
  interactiveSource(input, {
    inputs: {
      ...(input.mode === "update"
        ? {
            record: { type: "record_reference", recordTypeIds: [input.recordType], required: true },
          }
        : {}),
      values: { type: "json", required: true },
      ...(input.mode === "create" && input.ownershipMode === "group"
        ? { selected_owner_group_id: { type: "text", required: true } }
        : {}),
    },
    tasks: [
      {
        id: "validate",
        type: "interface.validate_form",
        version: taskVersion,
        properties: { form: textLiteral(input.form) },
      } as unknown as Task,
      ...(input.mode === "update"
        ? [
            {
              id: "unchanged",
              type: "if",
              condition: {
                op: "is_empty",
                arg: { op: "reference", reference: { source: "input", name: "values" } },
              },
              then: [
                showMessage("none_changed", "No changes to save.", {
                  target: "inline",
                  severity: "info",
                  component: input.form,
                }),
                { id: "stop_unchanged", type: "stop", outcome: "no_changes" },
              ],
            } as unknown as Task,
          ]
        : []),
      {
        id: "save",
        type: "record.save",
        version: taskVersion,
        properties: {
          record_type: textLiteral(input.recordType),
          ...(input.mode === "update" ? { record: inputReference("record") } : {}),
          values: inputReference("values"),
          ...(input.mode === "create" && input.ownershipMode === "group"
            ? { selected_owner_group_id: inputReference("selected_owner_group_id") }
            : {}),
        },
      },
      {
        id: "report",
        type: "if",
        condition: {
          op: "is_not_empty",
          arg: {
            op: "reference",
            reference: { source: "task_output", task: "save", key: "warning" },
          },
        },
        then: [
          showMessage("saved_with_warning", outputReference("save", "warning"), {
            target: "dialog",
            severity: "warning",
            title: "Saved, with a warning",
          }),
        ],
        else: [showMessage("saved", "Saved")],
      } as unknown as Task,
      ...afterTasks(
        input.after,
        input.mode === "create" ? "{{ outputs.save.record }}" : "{{ inputs.record }}",
      ),
    ],
    outputs: {
      record: {
        type: "record_reference",
        recordTypeIds: [input.recordType],
        value: outputReference("save", "record"),
      },
    },
  });

export type DefaultDeleteFlowInput = DefaultFlowIdentity &
  Readonly<{
    recordType: string;
    /** The key of the restore flow the "Deleted" message's Undo runs. */
    restoreFlow: string;
    after: DefaultFlowAfter;
    /** What the record is called in the confirmation, in lower case ("incident"). */
    recordName: string;
  }>;

/** The default Delete: confirm, delete, a "Deleted" toast whose Undo restores the record, then the page the person goes on to. */
export const defaultDeleteFlowSource = (input: DefaultDeleteFlowInput): SourceFlow =>
  interactiveSource(input, {
    inputs: { record_id: recordReferenceInput(input.recordType) },
    tasks: [
      {
        id: "confirm",
        type: "interface.confirm",
        version: taskVersion,
        properties: {
          title: textLiteral(`Delete this ${input.recordName}?`),
          message: textLiteral(
            `The ${input.recordName} is removed from lists. You can undo this right after.`,
          ),
          confirm_label: textLiteral("Delete"),
          destructive: { kind: "literal", literal: { type: "yes_no", value: true } },
        },
      } as unknown as Task,
      {
        id: "if_confirmed",
        type: "if",
        condition: {
          op: "reference",
          reference: { source: "task_output", task: "confirm", key: "confirmed" },
        },
        then: [
          {
            id: "delete",
            type: "record.delete",
            version: taskVersion,
            properties: {
              record_type: textLiteral(input.recordType),
              record: inputReference("record_id"),
            },
          },
          showMessage("deleted", "Deleted.", {
            action: {
              label: "Undo",
              flow: input.restoreFlow,
              inputs: { record_id: "{{ inputs.record_id }}" },
            },
          }),
          ...afterTasks(input.after, "{{ inputs.record_id }}"),
        ],
      } as unknown as Task,
    ],
    outputs: {},
  });

export type DefaultRestoreFlowInput = DefaultFlowIdentity &
  Readonly<{ recordType: string; after: DefaultFlowAfter; recordName: string }>;

/** The default Restore: bring a deleted record back, say so, and refresh. */
export const defaultRestoreFlowSource = (input: DefaultRestoreFlowInput): SourceFlow =>
  interactiveSource(input, {
    inputs: { record_id: recordReferenceInput(input.recordType) },
    tasks: [
      {
        id: "restore",
        type: "record.restore",
        version: taskVersion,
        properties: {
          record_type: textLiteral(input.recordType),
          record: inputReference("record_id"),
        },
      },
      showMessage("restored", `Restored the ${input.recordName}.`),
      ...afterTasks(input.after, "{{ inputs.record_id }}"),
    ],
    outputs: {},
  });

export type DefaultOpenFlowInput = DefaultFlowIdentity &
  Readonly<{
    /** The page the flow opens, by key. */
    page: string;
    /** The record type of the record the page shows; absent when the page shows none. */
    recordType?: string;
  }>;

/** The default Open, and the default New that opens the create page (no record): navigate. A page step only; no server request is made. */
export const defaultOpenFlowSource = (input: DefaultOpenFlowInput): SourceFlow =>
  interactiveSource(input, {
    inputs:
      input.recordType === undefined ? {} : { record_id: recordReferenceInput(input.recordType) },
    tasks: [
      navigateTask(
        "open_page",
        input.page,
        input.recordType === undefined ? undefined : "{{ inputs.record_id }}",
      ),
    ],
    outputs: {},
  });

export type DefaultNewDialogFlowInput = DefaultFlowIdentity &
  Readonly<{
    recordType: string;
    ownershipMode: DefaultSaveFlowInput["ownershipMode"];
    /** The dialog form to show, by form placement alias. */
    form: string;
    /** The field of the dialog form a caller input pre-fills (a board column's stage). */
    prefill?: Readonly<{ input: string; field: string }>;
  }>;

/**
 * The default New (and a board's Quick add) in a dialog: show the form, and when it is submitted
 * save the record, say "Saved" and refresh. A cancel ends the flow.
 */
export const defaultNewDialogFlowSource = (input: DefaultNewDialogFlowInput): SourceFlow =>
  interactiveSource(input, {
    inputs: {
      ...(input.prefill === undefined
        ? {}
        : { [input.prefill.input]: { type: "text", required: false } }),
      ...(input.ownershipMode === "group"
        ? { selected_owner_group_id: { type: "text", required: true } }
        : {}),
    },
    tasks: [
      {
        id: "form",
        type: "interface.show_form",
        version: taskVersion,
        properties: {
          form: textLiteral(input.form),
          ...(input.prefill === undefined
            ? {}
            : {
                inputs: {
                  kind: "map",
                  entries: { [input.prefill.field]: `{{ inputs.${input.prefill.input} }}` },
                },
              }),
        },
      } as unknown as Task,
      {
        id: "if_submitted",
        type: "if",
        condition: {
          op: "reference",
          reference: { source: "task_output", task: "form", key: "submitted" },
        },
        then: [
          {
            id: "save",
            type: "record.save",
            version: taskVersion,
            properties: {
              record_type: textLiteral(input.recordType),
              values: outputReference("form", "values"),
              ...(input.ownershipMode === "group"
                ? { selected_owner_group_id: inputReference("selected_owner_group_id") }
                : {}),
            },
          },
          showMessage("saved", "Saved"),
          refreshTask("refresh"),
        ],
      } as unknown as Task,
    ],
    outputs: {},
  });

export type DefaultChangeFlowInput = DefaultFlowIdentity & Readonly<{ recordType: string }>;

/**
 * The default for a change made in place (inline edit, row edit, card move): save the changed
 * values of the record. A conflict or refusal refreshes the page, so the person sees the current
 * values; the flow's default error handler tells them why.
 */
export const defaultChangeFlowSource = (input: DefaultChangeFlowInput): SourceFlow =>
  interactiveSource(input, {
    inputs: {
      record: recordReferenceInput(input.recordType),
      values: { type: "json", required: true },
    },
    tasks: [
      {
        id: "save",
        type: "record.save",
        version: taskVersion,
        properties: {
          record_type: textLiteral(input.recordType),
          record: inputReference("record"),
          values: inputReference("values"),
        },
      },
    ],
    outputs: {
      record: {
        type: "record_reference",
        recordTypeIds: [input.recordType],
        value: outputReference("save", "record"),
      },
    },
    errors: [refreshTask("refresh_after_failure")],
  });

export type DefaultQueryFlowInput = DefaultFlowIdentity &
  Readonly<{
    /** The declared query the flow reads: its alias in the owning definition. */
    query: string;
    /** The record type of the rows the query returns, for the typed `records` output. */
    recordType: string;
  }>;

export type DefaultOperationFlowInput = DefaultFlowIdentity &
  Readonly<{
    /** The operation's key: `platformOperationKey(...)` or a named action's namespaced key. */
    operation: string;
    /** The operation's typed inputs; the invoking form supplies each by name. */
    inputs: SourceFlow["inputs"];
    /** The operation's typed results, returned to the caller as one value. */
    returnsResult?: boolean;
    /** Asks first; declining ends the flow. */
    confirm?: Readonly<{
      title: string;
      message: string;
      confirmLabel?: string;
      destructive?: boolean;
    }>;
    /** The toast that tells the person the operation was done; a refresh of the page's data follows it. */
    done?: string;
  }>;

/**
 * A flow of one Call protected operation task. With no `inputs` property the task passes the
 * flow's own inputs to the operation by name, so the flow's declarations are the operation's typed
 * input map and publication checks them against the operation's own declaration. A refused,
 * conflict, validation or uncertain result needs no task of its own: the default error handler
 * shows each safely.
 */
export const defaultOperationFlowSource = (input: DefaultOperationFlowInput): SourceFlow => {
  const call = {
    id: "call",
    type: "operation.call",
    version: taskVersion,
    properties: { operation: textLiteral(input.operation) },
  } as unknown as Task;
  const followUp =
    input.done === undefined ? [] : [showMessage("done", input.done), refreshTask("refresh")];
  return interactiveSource(input, {
    inputs: Object.fromEntries(
      Object.entries(input.inputs).map(([name, declaration]) => [
        name,
        {
          type: declaration.type,
          required: declaration.required,
          ...(declaration.recordTypeIds === undefined
            ? {}
            : { recordTypeIds: declaration.recordTypeIds }),
        },
      ]),
    ),
    tasks:
      input.confirm === undefined
        ? [call, ...followUp]
        : [
            {
              id: "confirm",
              type: "interface.confirm",
              version: taskVersion,
              properties: {
                title: textLiteral(input.confirm.title),
                message: textLiteral(input.confirm.message),
                ...(input.confirm.confirmLabel === undefined
                  ? {}
                  : { confirm_label: textLiteral(input.confirm.confirmLabel) }),
                ...(input.confirm.destructive === true
                  ? { destructive: { kind: "literal", literal: { type: "yes_no", value: true } } }
                  : {}),
              },
            } as unknown as Task,
            {
              id: "if_confirmed",
              type: "if",
              condition: {
                op: "reference",
                reference: { source: "task_output", task: "confirm", key: "confirmed" },
              },
              then: [call, ...followUp],
            } as unknown as Task,
          ],
    outputs:
      input.returnsResult === true
        ? {
            result: {
              type: "json",
              value: outputReference("call", "result"),
            },
          }
        : {},
  });
};
