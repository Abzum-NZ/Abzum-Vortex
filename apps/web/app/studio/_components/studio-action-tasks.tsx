"use client";
import {
  actionValueCompatible,
  type ApplicationSourceDocument,
  type FlowReference,
  type FlowValue,
} from "@vortex/platform/schema";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Label } from "@vortex/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import {
  StudioOptionControl,
  studioFieldValueType,
  studioFixedLiteralType,
  studioFlowReferenceToken,
  studioFlowValueOf,
  studioFlowValueSourceOf,
  type StudioFlowReferenceChoice,
} from "@vortex/ui/studio";
import { StudioFlowValueControl } from "./studio-flow-value-control";

type Module = ApplicationSourceDocument["body"]["modules"][number];
type RecordType = Module["record_types"][number];
type Action = Module["actions"][number];
type Task = Action["tasks"][number];
const titles = {
  "record.set_fields": "Set fields",
  "record.create": "Create record",
  "record.changes": "Copy relationships",
  "record.delete": "Delete record",
  "event.announce": "Announce event",
} as const;

function ActionValues({
  id,
  record,
  values,
  references,
  subject,
  inputs,
  subjectType,
  onChange,
}: Readonly<{
  id: string;
  record: RecordType | undefined;
  values: Record<string, FlowValue>;
  references: readonly StudioFlowReferenceChoice[];
  subject: RecordType;
  inputs: Action["inputs"];
  subjectType: string;
  onChange: (values: Record<string, FlowValue>) => void;
}>) {
  const fields =
    record?.fields.filter(
      (field) => !["reference_number", "calculation", "total"].includes(field.type),
    ) ?? [];
  return (
    <div className="space-y-3">
      {Object.entries(values).map(([key, value]) => {
        const field = fields.find((entry) => entry.key === key);
        const options =
          field?.type === "choice"
            ? (field.settings as { options: { value: string; label: string }[] }).options
            : [];
        return (
          <div key={key} className="space-y-1 rounded-md border p-2">
            <StudioFlowValueControl
              id={`${id}-${key}`}
              label={field?.label ?? key}
              disabled={false}
              valueType={field === undefined ? undefined : studioFieldValueType(field.type)}
              options={options}
              value={studioFlowValueSourceOf(value)}
              references={references}
              referenceCompatible={(reference) =>
                actionValueCompatible(
                  { kind: "reference", reference },
                  field,
                  new Map(subject.fields.map((entry) => [entry.key, entry])),
                  new Map(inputs.map((entry) => [entry.key, entry])),
                  subjectType,
                  "source",
                )
              }
              onChange={(next) => {
                if (next !== null) onChange({ ...values, [key]: studioFlowValueOf(next) });
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                onChange(
                  Object.fromEntries(Object.entries(values).filter(([name]) => name !== key)),
                )
              }
            >
              Remove field
            </Button>
          </div>
        );
      })}
      <Label htmlFor={`${id}-add-field`}>Set another field</Label>
      <StudioOptionControl
        id={`${id}-add-field`}
        value=""
        unset="Set another field"
        disabled={record === undefined}
        options={fields
          .filter((field) => !Object.hasOwn(values, field.key))
          .map((field) => ({ value: field.key, label: field.label }))}
        onChange={(key) => {
          const field = fields.find((entry) => entry.key === key);
          const option =
            field?.type === "choice"
              ? (field.settings as { options: { value: string }[] }).options[0]
              : undefined;
          const type = studioFixedLiteralType(
            field === undefined ? undefined : studioFieldValueType(field.type),
          );
          const reference = references.find((entry) =>
            actionValueCompatible(
              { kind: "reference", reference: entry.reference },
              field,
              new Map(subject.fields.map((entry) => [entry.key, entry])),
              new Map(inputs.map((entry) => [entry.key, entry])),
              subjectType,
              "source",
            ),
          );
          const value: FlowValue =
            option !== undefined
              ? { kind: "literal", literal: { type: "choice", value: option.value } }
              : type === undefined && reference !== undefined
                ? { kind: "reference", reference: reference.reference }
                : type === "several_choices"
                  ? { kind: "literal", literal: { type, value: [] } }
                  : type === "yes_no"
                    ? { kind: "literal", literal: { type: "yes_no", value: false } }
                    : type === "whole_number"
                      ? { kind: "literal", literal: { type: "whole_number", value: 0 } }
                      : { kind: "literal", literal: { type: type ?? "text", value: "" } };
          onChange({ ...values, [key]: value });
        }}
      />
    </div>
  );
}

export function StudioActionTasks({
  source,
  module,
  record,
  tasks,
  inputs,
  onChange,
}: Readonly<{
  source: ApplicationSourceDocument;
  module: Module;
  record: RecordType;
  tasks: Action["tasks"];
  inputs: Action["inputs"];
  onChange: (tasks: Action["tasks"]) => void;
}>) {
  const records = source.body.modules.flatMap((owner) =>
    owner.record_types.map((entry) => ({
      key: `${owner.key}:${entry.key}`,
      label: `${entry.name} (${owner.name})`,
      record: entry,
    })),
  );
  const choice = (
    reference: FlowReference,
    label: string,
    type: string | undefined,
    group: StudioFlowReferenceChoice["group"],
  ): StudioFlowReferenceChoice => ({
    token: studioFlowReferenceToken(reference),
    reference,
    label,
    type,
    group,
  });
  const references = [
    ...(inputs.some((input) => input.key === "record")
      ? []
      : [
          choice(
            { source: "input", name: "record" },
            "The subject record",
            "record_reference",
            "The record",
          ),
        ]),
    ...inputs.map((input) =>
      choice({ source: "input", name: input.key }, input.label, input.type, "Flow inputs"),
    ),
    ...record.fields.map((field) =>
      choice(
        { source: "trigger_record", field: field.key },
        field.label,
        studioFieldValueType(field.type),
        "The record",
      ),
    ),
    choice(
      { source: "execution_actor" },
      "The person running it",
      "organization_account_reference",
      "The run",
    ),
    choice({ source: "execution_now" }, "The time it runs", "date_time", "The run"),
  ];
  const events = module.events.filter((event) => event.record_type === record.key);
  const targets = inputs.filter(
    (input) =>
      input.type === "record_reference" &&
      input.record_types.includes(`${module.key}:${record.key}`),
  );
  const replace = (index: number, task: Task) =>
    onChange(tasks.map((entry, at) => (at === index ? task : entry)));
  const move = (index: number, by: number) => {
    const next = [...tasks];
    const [task] = next.splice(index, 1);
    next.splice(index + by, 0, task!);
    onChange(next);
  };
  const add = (type: Task["type"]) => {
    let n = tasks.length + 1;
    while (tasks.some((task) => task.id === `task_${n}`)) n += 1;
    const id = `task_${n}`;
    switch (type) {
      case "record.set_fields":
        onChange([...tasks, { id, type, properties: { values: {} } }]);
        break;
      case "record.create":
        if (records[0] !== undefined)
          onChange([
            ...tasks,
            { id, type, properties: { record_type: records[0].key, values: {} } },
          ]);
        break;
      case "record.delete":
        onChange([...tasks, { id, type, properties: {} }]);
        break;
      case "event.announce":
        if (events[0] !== undefined)
          onChange([...tasks, { id, type, properties: { event: events[0].key } }]);
        break;
      case "record.changes":
        if (record.relationships[0] !== undefined && targets[0] !== undefined)
          onChange([
            ...tasks,
            {
              id,
              type,
              properties: {
                changes: [
                  {
                    kind: "copy_relationships",
                    relationships: [record.relationships[0].key],
                    target_input: targets[0].key,
                  },
                ],
              },
            },
          ]);
        break;
    }
  };
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Ordered tasks</legend>
      {tasks.map((task, index) => (
        <div key={task.id} className="space-y-3 rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-auto text-sm font-medium">
              {index + 1}. {titles[task.type]}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              Move up
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={index === tasks.length - 1}
              onClick={() => move(index, 1)}
            >
              Move down
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onChange(tasks.filter((_, at) => at !== index))}
            >
              Remove task
            </Button>
          </div>
          {task.type === "record.create" && (
            <div className="space-y-1">
              <Label htmlFor={`${task.id}-record`}>Record type to create</Label>
              <NativeSelect
                id={`${task.id}-record`}
                className="w-full"
                value={task.properties.record_type}
                onChange={(event) =>
                  replace(index, {
                    ...task,
                    properties: { record_type: event.target.value, values: {} },
                  })
                }
              >
                {records.map((entry) => (
                  <NativeSelectOption key={entry.key} value={entry.key}>
                    {entry.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          {(task.type === "record.set_fields" || task.type === "record.create") && (
            <ActionValues
              id={task.id}
              record={
                task.type === "record.set_fields"
                  ? record
                  : records.find((entry) => entry.key === task.properties.record_type)?.record
              }
              values={task.properties.values}
              references={references}
              subject={record}
              inputs={inputs}
              subjectType={`${module.key}:${record.key}`}
              onChange={(values) =>
                replace(index, { ...task, properties: { ...task.properties, values } } as Task)
              }
            />
          )}
          {task.type === "event.announce" && (
            <div className="space-y-1">
              <Label htmlFor={`${task.id}-event`}>Declared event</Label>
              <NativeSelect
                id={`${task.id}-event`}
                className="w-full"
                value={task.properties.event}
                onChange={(event) =>
                  replace(index, { ...task, properties: { event: event.target.value } })
                }
              >
                {events.map((entry) => (
                  <NativeSelectOption key={entry.key} value={entry.key}>
                    {entry.key}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          {task.type === "record.changes" && (
            <div className="space-y-3">
              {task.properties.changes.map((change, at) => {
                const set = (next: typeof change) =>
                  replace(index, {
                    ...task,
                    properties: {
                      changes: task.properties.changes.map((entry, place) =>
                        place === at ? next : entry,
                      ),
                    },
                  });
                return (
                  <div className="space-y-2" key={at}>
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor={`${task.id}-target-${at}`}>Copy relationships to input</Label>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove copy group ${at + 1}`}
                        title="Remove copy group"
                        disabled={task.properties.changes.length === 1}
                        onClick={() =>
                          replace(index, {
                            ...task,
                            properties: {
                              changes: task.properties.changes.filter((_, place) => place !== at),
                            },
                          })
                        }
                      >
                        <Icon name="minus" />
                      </Button>
                    </div>
                    <NativeSelect
                      id={`${task.id}-target-${at}`}
                      className="w-full"
                      value={change.target_input}
                      onChange={(event) => set({ ...change, target_input: event.target.value })}
                    >
                      {targets.map((input) => (
                        <NativeSelectOption key={input.key} value={input.key}>
                          {input.label}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    {record.relationships.map((relationship) => (
                      <div className="flex items-center gap-2" key={relationship.key}>
                        <Checkbox
                          id={`${task.id}-${at}-${relationship.key}`}
                          checked={change.relationships.includes(relationship.key)}
                          onCheckedChange={(checked) =>
                            set({
                              ...change,
                              relationships:
                                checked === true
                                  ? [...change.relationships, relationship.key]
                                  : change.relationships.filter((key) => key !== relationship.key),
                            })
                          }
                        />
                        <Label htmlFor={`${task.id}-${at}-${relationship.key}`}>
                          {record.fields.find((field) => field.key === relationship.from_field)
                            ?.label ?? relationship.key}
                        </Label>
                      </div>
                    ))}
                  </div>
                );
              })}
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Add copy group"
                title="Add copy group"
                disabled={
                  task.properties.changes.length >= 10 ||
                  targets.length === 0 ||
                  record.relationships.length === 0
                }
                onClick={() =>
                  replace(index, {
                    ...task,
                    properties: {
                      changes: [
                        ...task.properties.changes,
                        {
                          kind: "copy_relationships",
                          target_input: targets[0]!.key,
                          relationships: [record.relationships[0]!.key],
                        },
                      ],
                    },
                  })
                }
              >
                <Icon name="plus" />
              </Button>
            </div>
          )}
          {task.type === "record.delete" && (
            <p className="text-sm text-muted-foreground">
              Soft-delete the record this action runs on.
            </p>
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {(Object.keys(titles) as Task["type"][]).map((type) => (
          <Button
            key={type}
            type="button"
            variant="outline"
            size="sm"
            disabled={
              tasks.length >= 10 ||
              (type === "event.announce" && events.length === 0) ||
              (type === "record.create" && records.length === 0) ||
              (type === "record.changes" &&
                (record.relationships.length === 0 || targets.length === 0))
            }
            onClick={() => add(type)}
          >
            Add {titles[type].toLowerCase()}
          </Button>
        ))}
      </div>
      {events.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Declare an event of this record type to add announcements.
        </p>
      )}
      {targets.length === 0 && record.relationships.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Add a record input permitting this record type to copy relationships.
        </p>
      )}
    </fieldset>
  );
}
