"use client";

import { useId, useState, type ReactElement } from "react";
import {
  applicationSourceDocumentSchema,
  authoredRecordsTableFeatureEnabled,
  sourcePageItems,
  recordsTableRowActionIcons,
  type ApplicationSourceDocument,
  type JsonValue,
} from "@vortex/platform/schema";
import type { StudioActionChoice } from "../contextual-palette";
import type { StudioFlowCreateCommand, StudioFlowCreateChoices } from "../application-flow-create";
import { Input } from "../../components/input";
import { Label } from "../../components/label";
import { NativeSelect, NativeSelectOption } from "../../components/native-select";
import { StudioEntryList } from "../studio-entry-list";
import {
  StudioReferencePicker,
  type StudioReferencePickerOption,
} from "../studio-reference-picker";

export type StudioRowAction = Readonly<{
  event_id: string;
  label: string;
  icon: string;
  placement: string;
  capability?: string;
}>;

const placementOf = (source: ApplicationSourceDocument, alias: string) =>
  source.body.pages
    .flatMap((page) => sourcePageItems(page.composition))
    .find((item) => item.props.id === alias);

export const studioRowActionsFor = (
  source: ApplicationSourceDocument,
  alias: string,
): readonly StudioRowAction[] | undefined => {
  const item = placementOf(source, alias);
  if (
    item?.type !== "platform.renderer.table" ||
    !authoredRecordsTableFeatureEnabled(item.props, "row_actions")
  )
    return undefined;
  return (item.props.row_actions ?? []) as readonly StudioRowAction[];
};

/** Removing a declaration removes its binding in the same draft edit, never a dangling reference. */
export const applyStudioRowActionChange = (
  source: ApplicationSourceDocument,
  alias: string,
  expected: readonly StudioRowAction[],
  next: readonly StudioRowAction[],
):
  | Readonly<{ kind: "applied"; source: ApplicationSourceDocument }>
  | Readonly<{ kind: "refused"; reason: string }> => {
  if (JSON.stringify(studioRowActionsFor(source, alias)) !== JSON.stringify(expected))
    return {
      kind: "refused",
      reason: "The row actions changed. Reload the inspector and try again.",
    };
  if (next.length > 20 || next.filter((action) => action.placement === "inline").length > 3)
    return {
      kind: "refused",
      reason: "At most three actions can sit beside the row; move the rest to the menu",
    };
  const candidate = structuredClone(source);
  const item = placementOf(candidate, alias);
  if (item === undefined) return { kind: "refused", reason: "The table is no longer on the page." };
  item.props.row_actions = next.map((action) => ({ ...action }));
  const removed = new Set(
    expected
      .filter((action) => !next.some((entry) => entry.event_id === action.event_id))
      .map((action) => action.event_id),
  );
  candidate.body.flow_bindings = candidate.body.flow_bindings.filter(
    (binding) =>
      binding.control !== alias || binding.event !== "row_action" || !removed.has(binding.event_id),
  );
  const parsed = applicationSourceDocumentSchema.safeParse(candidate);
  return parsed.success
    ? { kind: "applied", source: parsed.data }
    : { kind: "refused", reason: "The row action settings are invalid." };
};

/** Named actions and interactive flows are choices for the same flow-binding declaration. */
export function StudioRowActionsBindings({
  source,
  placementAlias,
  createChoices,
  namedActions,
  disabled,
  onCreate,
  onChange,
}: Readonly<{
  source: ApplicationSourceDocument;
  placementAlias: string;
  createChoices: StudioFlowCreateChoices;
  namedActions: readonly StudioActionChoice[];
  disabled: boolean;
  onCreate: (command: StudioFlowCreateCommand) => true | string;
  onChange: (
    expected: readonly StudioRowAction[],
    next: readonly StudioRowAction[],
  ) => true | string;
}>): ReactElement | null {
  const actions = studioRowActionsFor(source, placementAlias);
  const control = createChoices.actions.find(
    (choice) => choice.controlAlias === placementAlias && choice.event === "row_action",
  );
  if (actions === undefined || control === undefined || control.recordType === null) return null;
  const recordType = control.recordType;
  const named = namedActions.filter((action) => action.recordType === recordType);
  const flows = source.body.flows.filter(
    (flow) => flow.execution === "interactive" && flow.runAs.kind === "initiator",
  );
  const flowReason = (flow: (typeof flows)[number]): string | undefined => {
    const record = Object.entries(flow.inputs).find(
      ([, input]) => input.type === "record_reference" && input.recordTypeIds?.includes(recordType),
    );
    if (record === undefined)
      return "This workflow needs a record input for the table's record type.";
    if (Object.entries(flow.inputs).some(([key, input]) => input.required && key !== record[0]))
      return "This workflow needs details before it can run from a row.";
    return undefined;
  };
  return (
    <StudioRowActionsEditor
      actions={actions}
      disabled={disabled}
      choices={[
        ...named.map((action) => ({
          value: `action:${action.reference}`,
          label: action.label,
          group: "Record actions",
          disabled: !action.acceptsSelection,
          description: action.acceptsSelection
            ? undefined
            : `${action.label} needs details for each record, so it cannot be a row button`,
        })),
        ...flows.map((flow) => ({
          value: `flow:${flow.key}`,
          label: flow.labels.name ?? flow.key,
          group: "Workflows",
          disabled: flowReason(flow) !== undefined,
          description: flowReason(flow),
        })),
      ]}
      onChange={(next) => onChange(actions, next)}
      onAdd={(choice) => {
        const action = named.find((entry) => `action:${entry.reference}` === choice);
        if (action !== undefined) {
          if (!action.acceptsSelection)
            return `${action.label} needs details for each record, so it cannot be a row button`;
          return onCreate({
            kind: "control",
            controlAlias: placementAlias,
            event: "row_action",
            name: action.label,
            description: `Runs ${action.label} for the row.`,
            rowActionLabel: action.label,
            inputs: {
              record_id: { type: "record_reference", required: true, recordTypeIds: [recordType] },
            },
            bindingInputs: { record_id: { kind: "caller", name: "record_id" } },
            outputs: {},
            tasks: [
              {
                id: "run_action",
                type: "operation.call",
                version: "1.0.0",
                properties: {
                  operation: {
                    kind: "literal",
                    literal: { type: "text", value: action.reference },
                  },
                  inputs: { kind: "map", entries: {} },
                },
              },
            ],
          });
        }
        const flow = flows.find((entry) => `flow:${entry.key}` === choice);
        if (flow === undefined)
          return "Choose a row action from this table's available actions and workflows.";
        const reason = flowReason(flow);
        if (reason !== undefined) return reason;
        const record = Object.entries(flow.inputs).find(
          ([, input]) =>
            input.type === "record_reference" && input.recordTypeIds?.includes(recordType),
        )!;
        return onCreate({
          kind: "bind",
          controlAlias: placementAlias,
          event: "row_action",
          flowKey: flow.key,
          rowActionLabel: flow.labels.name ?? flow.key,
          bindingInputs: { [record[0]]: { kind: "caller", name: "record_id" } },
        });
      }}
    />
  );
}

/** The same declarations the runtime reads; all insertion and removal includes its flow binding. */
export function StudioRowActionsEditor({
  actions,
  choices,
  disabled,
  onAdd,
  onChange,
}: Readonly<{
  actions: readonly StudioRowAction[];
  choices: readonly StudioReferencePickerOption[];
  disabled: boolean;
  onAdd: (choice: string) => true | string;
  onChange: (actions: readonly StudioRowAction[]) => true | string;
}>): ReactElement {
  const id = useId();
  const [problem, setProblem] = useState("");
  const commit = (next: readonly StudioRowAction[]): void => {
    const result = onChange(next);
    setProblem(result === true ? "" : result);
  };
  const change = (index: number, key: string, value: JsonValue): void => {
    const next = actions.map((action, i) =>
      i === index ? ({ ...action, [key]: value } as StudioRowAction) : action,
    );
    if (next.filter((action) => action.placement === "inline").length > 3) {
      setProblem("At most three actions can sit beside the row; move the rest to the menu");
      return;
    }
    commit(next);
  };
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Record actions are checked for each row. Other workflows are offered when the row allows
        their required capability. Workflows handle their own forms and confirmations.
      </p>
      <StudioEntryList
        label="Row actions"
        itemName="row action"
        disabled={disabled}
        items={actions.map((action, index) => ({
          key: action.event_id,
          title: action.label,
          summary: action.placement === "inline" ? "Beside the row" : "Row menu",
          content: (
            <div className="space-y-3">
              <Label htmlFor={`${id}-${index}-label`}>Label</Label>
              <Input
                id={`${id}-${index}-label`}
                value={action.label}
                maxLength={60}
                disabled={disabled}
                onChange={(event) => change(index, "label", event.target.value)}
              />
              <Label htmlFor={`${id}-${index}-icon`}>Icon</Label>
              <NativeSelect
                id={`${id}-${index}-icon`}
                value={action.icon}
                disabled={disabled}
                onChange={(event) => change(index, "icon", event.target.value)}
              >
                {recordsTableRowActionIcons.map((icon) => (
                  <NativeSelectOption key={icon} value={icon}>
                    {icon.replaceAll("-", " ")}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <Label htmlFor={`${id}-${index}-placement`}>Show in</Label>
              <NativeSelect
                id={`${id}-${index}-placement`}
                value={action.placement}
                disabled={disabled}
                onChange={(event) => change(index, "placement", event.target.value)}
              >
                <NativeSelectOption value="inline">Beside the row</NativeSelectOption>
                <NativeSelectOption value="menu">Row menu</NativeSelectOption>
              </NativeSelect>
              <Label htmlFor={`${id}-${index}-capability`}>Required capability</Label>
              <NativeSelect
                id={`${id}-${index}-capability`}
                value={action.capability ?? ""}
                disabled={disabled}
                onChange={(event) => {
                  const rest = { ...action };
                  delete rest.capability;
                  commit(
                    actions.map((entry, i) =>
                      i !== index
                        ? entry
                        : event.target.value === ""
                          ? rest
                          : { ...rest, capability: event.target.value },
                    ),
                  );
                }}
              >
                <NativeSelectOption value="">None</NativeSelectOption>
                <NativeSelectOption value="update">Update</NativeSelectOption>
                <NativeSelectOption value="delete">Delete</NativeSelectOption>
                <NativeSelectOption value="restore">Restore</NativeSelectOption>
              </NativeSelect>
            </div>
          ),
        }))}
        onMove={(from, to) => {
          const next = [...actions];
          next.splice(to, 0, next.splice(from, 1)[0]!);
          commit(next);
        }}
        onRemove={(index) => commit(actions.filter((_, i) => i !== index))}
      >
        <StudioReferencePicker
          id={`${id}-add`}
          value=""
          unset="Add a row action"
          options={choices}
          disabled={disabled || actions.length >= 20}
          onChange={(choice) => {
            if (choice === "") return;
            const result = onAdd(choice);
            setProblem(result === true ? "" : result);
          }}
        />
      </StudioEntryList>
      {problem === "" ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
