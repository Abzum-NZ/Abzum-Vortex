import {
  builderKeySchema,
  flowLiteralSchema,
  namespacedKeySchema,
  parseFlowReference,
  type ApplicationSourceDocument,
  type FlowLiteral,
  type FlowReference,
  type FlowValue,
  type JsonValue,
  type SourceFlow,
  type SourceFlowTask,
} from "@vortex/platform/schema";
import type { StudioFlowDraftChoices } from "./application-flow-step-form";
import {
  describeStudioFlowLocation,
  studioFlowDefinitionOf,
  studioFlowListAt,
  studioWords,
  type StudioFlowPath,
} from "./application-flow-model";

/**
 * The values a step setting can take, as Studio offers them: a fixed value of the setting's type,
 * or one of the closed references the flow can read at that step (its inputs, its variables, an
 * earlier step's output, the record it runs for, the person running it, the time). A value the
 * controls do not build (a formula, a constructed map) is kept as it is until it is replaced.
 */

export type StudioFlowValueSource =
  | Readonly<{ kind: "fixed"; literal: FlowLiteral }>
  | Readonly<{ kind: "reference"; reference: FlowReference }>
  | Readonly<{ kind: "built"; value: FlowValue }>
  | Readonly<{ kind: "kept"; value: FlowValue }>;

export type StudioFlowReferenceChoice = Readonly<{
  /** A stable spelling of the reference, for a picker's option value. */
  token: string;
  label: string;
  group:
    | "Flow inputs"
    | "From the triggering event"
    | "Saved values"
    | "Earlier steps"
    | "The record"
    | "The run";
  /** The declared type, when the flow declares one. */
  type: string | undefined;
  reference: FlowReference;
  /** The options of a choice field, which a value compared with it is picked from. */
  options?: readonly Readonly<{ value: string; label: string }>[];
}>;

type LiteralType = FlowLiteral["type"];

export const studioFlowReferenceToken = (reference: FlowReference): string => {
  switch (reference.source) {
    case "input":
    case "variable":
      return `${reference.source}:${reference.name}`;
    case "trigger_record":
    case "trigger_previous":
      return `${reference.source}:${reference.field}`;
    case "task_output":
      return `task_output:${reference.task}:${reference.key}${reference.path === undefined ? "" : `:${reference.path.join(".")}`}`;
    case "module_field":
      return `module_field:${reference.fieldId}`;
    case "execution_actor":
    case "execution_now":
      return reference.source;
  }
};

// ─── The draft's record types and fields ─────────────────────────────────────────────────────

type DraftModule = ApplicationSourceDocument["body"]["modules"][number];
type DraftRecordType = DraftModule["record_types"][number];
export type StudioDraftField = DraftRecordType["fields"][number];

/** A record type of the draft by its flow reference: `module:record`, or `record` inside its own Module. */
export const studioDraftRecordType = (
  source: Readonly<ApplicationSourceDocument>,
  reference: string,
  moduleKey: string | null,
): Readonly<{ module: DraftModule; record: DraftRecordType }> | undefined => {
  const split = reference.lastIndexOf(":");
  const owner = split < 0 ? moduleKey : reference.slice(0, split);
  const key = split < 0 ? reference : reference.slice(split + 1);
  const module = source.body.modules.find((candidate) => candidate.key === owner);
  const record = module?.record_types.find((candidate) => candidate.key === key);
  return module === undefined || record === undefined ? undefined : { module, record };
};

/** Events must match every possible type of the selected record, or the flow's subject. */
export const studioFlowEventChoices = (
  source: Readonly<ApplicationSourceDocument>,
  flow: SourceFlow,
  moduleKey: string | null,
  record?: FlowValue,
): readonly Readonly<{ value: string; label: string }>[] => {
  const inputTypes = (name: string): readonly string[] =>
    flow.inputs?.[name]?.recordTypeIds ??
    (flow.triggers ?? []).flatMap((trigger) => trigger.inputs?.[name]?.recordTypeIds ?? []);
  const selectedTypes = (): readonly string[] => {
    if (record === undefined)
      return flow.recordInput === undefined
        ? (flow.triggers ?? []).flatMap((trigger) =>
            "recordTypeId" in trigger ? [trigger.recordTypeId] : [],
          )
        : inputTypes(flow.recordInput);
    if (record.kind !== "reference") return [];
    const reference = record.reference;
    if (reference.source === "input") return inputTypes(reference.name);
    if (reference.source === "variable")
      return flow.variables?.[reference.name]?.recordTypeIds ?? [];
    if (
      reference.source === "task_output" &&
      reference.key === "record" &&
      !reference.path?.length
    ) {
      const path = studioFlowTaskPath(flow, reference.task);
      const task =
        path === undefined
          ? undefined
          : studioFlowListAt(flow, path.slice(0, -1))?.[path.at(-1) as number];
      const type =
        task !== undefined && "properties" in task ? task.properties.record_type : undefined;
      return type?.kind === "literal" && typeof type.literal.value === "string"
        ? [type.literal.value]
        : [];
    }
    return [];
  };
  const types = [
    ...new Set(selectedTypes().map((type) => (type.includes(":") ? type : `${moduleKey}:${type}`))),
  ];
  if (types.length !== 1) return [];
  return source.body.modules.flatMap((module) =>
    module.events
      .filter((event) => `${module.key}:${event.record_type}` === types[0])
      .map((event) => ({ value: event.key, label: event.key })),
  );
};

/** The flow value type a field's values have, or undefined for a field no flow value sets. */
export const studioFieldValueType = (fieldType: string): LiteralType | undefined => {
  switch (fieldType) {
    case "text":
    case "long_text":
    case "email_address":
    case "phone_number":
    case "web_address":
    case "reference_number":
      return "text";
    case "whole_number":
    case "decimal_number":
    case "money":
    case "yes_no":
    case "date":
    case "date_time":
    case "choice":
    case "several_choices":
    case "formatted_text":
      return fieldType;
    case "link":
    case "link_to_one_of_several":
      return "record_reference";
    default:
      return undefined;
  }
};

/** The options of a choice field, or undefined for any other field. */
export const studioFieldChoiceOptions = (
  field: StudioDraftField,
): readonly Readonly<{ value: string; label: string }>[] | undefined =>
  field.type === "choice" || field.type === "several_choices"
    ? (
        (field.settings as { options?: readonly { value: string; label: string }[] } | undefined)
          ?.options ?? []
      ).map((option) => ({ value: option.value, label: option.label }))
    : undefined;

/** The literal types a fixed value can be typed in as; the others are only read from references. */
const typedFixed: ReadonlySet<LiteralType> = new Set([
  "text",
  "whole_number",
  "decimal_number",
  "yes_no",
  "date",
  "date_time",
  "choice",
  "several_choices",
]);

/** The literal type a fixed value of this expected type is written as, or undefined when there is none. */
export const studioFixedLiteralType = (expected: string | undefined): LiteralType | undefined =>
  expected === undefined
    ? "text"
    : typedFixed.has(expected as LiteralType)
      ? (expected as LiteralType)
      : undefined;

/** A fixed value typed by a person, or why it does not fit its type. */
export const studioFixedLiteral = (
  type: LiteralType,
  input: string | boolean,
  label: string,
): Readonly<{ ok: true; literal: FlowLiteral }> | Readonly<{ ok: false; reason: string }> => {
  if (type === "yes_no")
    return typeof input === "boolean"
      ? { ok: true, literal: { type, value: input } }
      : { ok: false, reason: `${label}: choose yes or no.` };
  if (typeof input !== "string") return { ok: false, reason: `${label}: enter a value.` };
  const text = type === "text" ? input : input.trim();
  let value: JsonValue = text;
  if (type === "whole_number") {
    if (!/^-?(?:0|[1-9]\d*)$/.test(text) || !Number.isSafeInteger(Number(text)))
      return { ok: false, reason: `${label}: enter a whole number without decimals or spaces.` };
    value = Number(text);
  } else if (type === "several_choices")
    value = text
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  else if (text.length === 0 && type !== "text")
    return { ok: false, reason: `${label}: enter a value.` };
  const checked = flowLiteralSchema.safeParse({ type, value });
  return checked.success
    ? { ok: true, literal: checked.data }
    : {
        ok: false,
        reason: `${label}: ${
          type === "date"
            ? "write the date as year-month-day, such as 2026-01-31"
            : type === "date_time"
              ? "write the moment as 2026-01-31T09:30:00Z"
              : type === "decimal_number"
                ? "enter a number such as 12.5"
                : "this value does not fit here"
        }.`,
      };
};

/** A fixed key setting: lowercase words joined by underscores, or by dots for a namespaced key. */
export const studioKeyProblem = (
  type: "builder_key" | "namespaced_key",
  value: string,
  label: string,
): string | undefined =>
  (type === "builder_key" ? builderKeySchema : namespacedKeySchema).safeParse(value).success
    ? undefined
    : type === "builder_key"
      ? `${label}: use lowercase words joined by underscores, up to 40 characters, such as follow_up.`
      : `${label}: use lowercase names joined by dots, such as record.saved.`;

// ─── What a step can read ────────────────────────────────────────────────────────────────────

/** The tasks that have certainly run before the task at `path`: earlier tasks of its list and of every enclosing list. */
export const studioFlowTasksBefore = (flow: SourceFlow, path: StudioFlowPath): SourceFlowTask[] => {
  const before: SourceFlowTask[] = [];
  let cursor = [...path];
  while (cursor.length >= 2) {
    const index = cursor[cursor.length - 1];
    const listPath = cursor.slice(0, -1);
    const list = studioFlowListAt(flow, listPath);
    if (typeof index !== "number" || list === undefined) break;
    before.unshift(...list.slice(0, index));
    // The enclosing task is the longest shorter prefix that ends at a task.
    let owner: (string | number)[] | undefined;
    for (let length = listPath.length - 1; length >= 2; length -= 1) {
      const candidate = listPath.slice(0, length);
      const last = candidate[candidate.length - 1];
      if (
        typeof last === "number" &&
        studioFlowListAt(flow, candidate.slice(0, -1))?.[last] !== undefined
      ) {
        owner = candidate;
        break;
      }
    }
    if (owner === undefined) break;
    cursor = owner;
  }
  return before;
};

const outputLabel = (key: string): string =>
  key === "record"
    ? "the record"
    : key === "records"
      ? "the records"
      : key === "values"
        ? "the answers"
        : studioWords(key).toLowerCase();

/** The outputs one task gives the steps after it. */
const taskOutputs = (
  flow: SourceFlow,
  siblings: readonly SourceFlow[],
  task: SourceFlowTask,
  location: string,
  forms: StudioFlowDraftChoices["forms"],
): StudioFlowReferenceChoice[] => {
  const choice = (
    key: string,
    type: string | undefined,
    path?: readonly string[],
    words?: string,
  ): StudioFlowReferenceChoice => {
    const reference: FlowReference = {
      source: "task_output",
      task: task.id,
      key,
      ...(path === undefined ? {} : { path: [...path] }),
    };
    return {
      token: studioFlowReferenceToken(reference),
      label: `${location}: ${words ?? outputLabel(key)}`,
      group: "Earlier steps",
      type,
      reference,
    };
  };
  if (task.type === "run_flow" && "flowId" in task) {
    const target = siblings.find(
      (candidate) => candidate.id === task.flowId || candidate.key === task.flowId,
    );
    return Object.entries(target?.outputs ?? {}).map(([key, declaration]) =>
      choice(key, declaration.type),
    );
  }
  if (!("properties" in task)) return [];
  const definition = studioFlowDefinitionOf(task.type);
  const outputs = (definition?.outputs ?? []).flatMap((output) => {
    if (task.type === "interface.show_form" && output.key === "values") {
      const form = task.properties.form;
      const alias = form?.kind === "literal" ? form.literal.value : undefined;
      const fields = forms.find((entry) => entry.alias === alias)?.fields ?? [];
      const inputs = task.properties.inputs;
      const members =
        inputs?.kind === "map"
          ? Object.entries(inputs.entries).map(([name, value]) => {
              const field = fields.find((field) => field.name === name);
              return choice(
                "values",
                field?.type ?? (value.kind === "literal" ? value.literal.type : undefined),
                [name],
                `the answer ${(field?.label ?? studioWords(name)).toLowerCase()}`,
              );
            })
          : [];
      return [choice("values", "json"), ...members];
    }
    return [choice(output.key, output.type)];
  });
  if (task.allowRefusal === true)
    outputs.push(choice("outcome", "choice", undefined, "how it ended"));
  return outputs;
};

/**
 * Every reference a value at `path` in the flow can read, in the order a person looks for them: the
 * flow's inputs and variables, what earlier steps gave, the record it runs for, the run itself.
 * `path` null asks for what the whole flow can read before its first step.
 */
export const studioFlowReferenceChoices = (
  source: Readonly<ApplicationSourceDocument>,
  flow: SourceFlow,
  siblings: readonly SourceFlow[],
  moduleKey: string | null,
  path: StudioFlowPath | null,
  forms: StudioFlowDraftChoices["forms"],
): readonly StudioFlowReferenceChoice[] => {
  const choices: StudioFlowReferenceChoice[] = [];
  const add = (
    reference: FlowReference,
    label: string,
    group: StudioFlowReferenceChoice["group"],
    type: string | undefined,
  ) => choices.push({ token: studioFlowReferenceToken(reference), label, group, type, reference });
  for (const [name, declaration] of Object.entries(flow.inputs ?? {}))
    add({ source: "input", name }, studioWords(name), "Flow inputs", declaration.type);
  for (const trigger of flow.triggers ?? [])
    for (const [name, declaration] of Object.entries(trigger.inputs ?? {}))
      if (!Object.hasOwn(flow.inputs ?? {}, name))
        add(
          { source: "input", name },
          studioWords(name),
          "From the triggering event",
          declaration.type,
        );
  for (const [name, declaration] of Object.entries(flow.variables ?? {}))
    add({ source: "variable", name }, studioWords(name), "Saved values", declaration.type);
  if (path !== null)
    for (const task of studioFlowTasksBefore(flow, path)) {
      const location = describeStudioFlowLocation(flow, studioFlowTaskPath(flow, task.id) ?? []);
      choices.push(...taskOutputs(flow, siblings, task, location, forms));
    }
  // The record the flow runs for: the record a trigger saves or announces, or the record an
  // interactive flow's record input names. Each field offers its type and, for a choice, its options.
  const recordTrigger = (flow.triggers ?? []).find(
    (trigger) => trigger.type === "BeforeSave" || trigger.type === "Event",
  );
  const recordType =
    recordTrigger !== undefined && "recordTypeId" in recordTrigger
      ? recordTrigger.recordTypeId
      : flow.recordInput === undefined
        ? undefined
        : flow.inputs?.[flow.recordInput]?.recordTypeIds?.[0];
  if (recordType !== undefined) {
    const found = studioDraftRecordType(source, recordType, moduleKey);
    for (const field of found?.record.fields ?? []) {
      const options = studioFieldChoiceOptions(field);
      const addField = (reference: FlowReference, label: string) =>
        choices.push({
          token: studioFlowReferenceToken(reference),
          label,
          group: "The record",
          type: studioFieldValueType(field.type),
          reference,
          ...(options === undefined ? {} : { options }),
        });
      addField(
        { source: "trigger_record", field: field.key },
        `${found!.record.name}: ${field.label}`,
      );
      if (recordTrigger?.type === "BeforeSave")
        addField(
          { source: "trigger_previous", field: field.key },
          `${found!.record.name}: ${field.label} before the change`,
        );
    }
  }
  add(
    { source: "execution_actor" },
    "The person running it",
    "The run",
    "organization_account_reference",
  );
  if (flow.execution === "interactive" || flow.execution === "background")
    add({ source: "execution_now" }, "Now", "The run", "date_time");
  // Offer the members the definition already reads, only when their producing step is in scope.
  const members = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    const entry = value as Record<string, unknown>;
    if (entry.source === "task_output" && Array.isArray(entry.path)) {
      const reference = entry as Extract<FlowReference, { source: "task_output" }>;
      const token = studioFlowReferenceToken(reference);
      const base = choices.find(
        (choice) =>
          choice.reference.source === "task_output" &&
          choice.reference.task === reference.task &&
          choice.reference.key === reference.key &&
          choice.reference.path === undefined,
      );
      if (base !== undefined && !choices.some((choice) => choice.token === token))
        choices.push({
          ...base,
          token,
          reference,
          type: undefined,
          label: `${base.label}: ${reference.path!.map(studioWords).join(" / ")}`,
        });
    }
    for (const child of Object.values(entry)) members(child);
  };
  members(flow);
  return choices;
};

/** The path of a task in a flow by its id. */
export const studioFlowTaskPath = (
  flow: SourceFlow,
  taskId: string,
): StudioFlowPath | undefined => {
  const walk = (
    tasks: readonly SourceFlowTask[] | undefined,
    path: StudioFlowPath,
  ): StudioFlowPath | undefined => {
    for (const [index, task] of (tasks ?? []).entries()) {
      const here = [...path, index];
      if (task.id === taskId) return here;
      const lists: [readonly SourceFlowTask[] | undefined, StudioFlowPath][] =
        "then" in task
          ? [
              [task.then, [...here, "then"]],
              [task.else, [...here, "else"]],
            ]
          : "cases" in task
            ? [
                ...task.cases.map(
                  (entry, caseIndex): [readonly SourceFlowTask[], StudioFlowPath] => [
                    entry.tasks,
                    [...here, "cases", caseIndex, "tasks"],
                  ],
                ),
                [task.default, [...here, "default"]],
              ]
            : "branches" in task
              ? task.branches.map(
                  (branch, branchIndex): [readonly SourceFlowTask[], StudioFlowPath] => [
                    branch,
                    [...here, "branches", branchIndex],
                  ],
                )
              : "tasks" in task
                ? [[task.tasks, [...here, "tasks"]]]
                : [];
      for (const [list, listPath] of lists) {
        const found = walk(list, listPath);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return (
    walk(flow.tasks, ["tasks"]) ?? walk(flow.errors, ["errors"]) ?? walk(flow.finally, ["finally"])
  );
};

// ─── Between stored values and the controls ──────────────────────────────────────────────────

/** How a stored value is shown in the controls. */
export const studioFlowValueSourceOf = (value: FlowValue): StudioFlowValueSource => {
  if (typeof value === "string") {
    const reference = parseFlowReference(value);
    return reference === undefined ? { kind: "kept", value } : { kind: "reference", reference };
  }
  if (value.kind === "reference") {
    // Authored text such as "{{ inputs.x }}" is the same reference as its typed form.
    const reference: FlowReference | undefined =
      typeof value.reference === "string" ? parseFlowReference(value.reference) : value.reference;
    return reference === undefined ? { kind: "kept", value } : { kind: "reference", reference };
  }
  return value.kind === "literal"
    ? // A literal object or list (other than several choices) has no single field to type it in.
      value.literal.type !== "several_choices" &&
      typeof value.literal.value === "object" &&
      value.literal.value !== null
      ? { kind: "kept", value }
      : { kind: "fixed", literal: value.literal }
    : value.kind === "map" ||
        value.kind === "array" ||
        (value.kind === "formula" &&
          [
            "join",
            "if",
            "now",
            "record_id",
            "date_add",
            "is_empty",
            "is_not_empty",
            "gt",
            "literal",
            "reference",
          ].includes(value.formula.op))
      ? { kind: "built", value }
      : { kind: "kept", value };
};

/** The stored value a control's choice writes. */
export const studioFlowValueOf = (source: StudioFlowValueSource): FlowValue =>
  source.kind === "fixed"
    ? { kind: "literal", literal: source.literal }
    : source.kind === "reference"
      ? { kind: "reference", reference: source.reference }
      : source.value;

/** A value in words, for a caption or a read-only row. */
export const describeStudioFlowValue = (
  value: StudioFlowValueSource,
  choices: readonly StudioFlowReferenceChoice[],
): string => {
  if (value.kind === "fixed")
    return Array.isArray(value.literal.value)
      ? value.literal.value.join(", ")
      : typeof value.literal.value === "string"
        ? `“${value.literal.value}”`
        : JSON.stringify(value.literal.value);
  if (value.kind === "reference") {
    const token = studioFlowReferenceToken(value.reference);
    return (
      choices.find((choice) => choice.token === token)?.label ??
      "A value the flow can no longer read here"
    );
  }
  return value.value.kind === "formula"
    ? "Worked out by a calculation"
    : "A set of values built by the flow";
};
