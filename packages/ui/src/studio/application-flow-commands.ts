import {
  builderKeySchema,
  flowMaximumTaskCount,
  flowMaximumForEachItemsOther,
  flowMaximumSetBasedForEachItems,
  isSetBasedForEach,
  flowTaskRegistry,
  flowExecutionRunLocations,
  parseFlowReference,
  sourceFlowTaskSchema,
  validateFlow,
  validateFlowTaskPlacement,
  applicationSourceDocumentSchema,
  flowTaskChildLists,
  type ApplicationSourceDocument,
  type FlowTaskPropertyType,
  type FlowTaskTypeDefinition,
  type FlowValue,
  type FlowFormula,
  type FlowLiteral,
  type SourceFlow,
  type SourceFlowTask,
} from "@vortex/platform/schema";
import type { StudioSemanticSelection } from "./semantic-selection";
import {
  sameStudioFlowContext,
  samePath,
  studioWords,
  studioFlowKeyFrom,
  studioFlowValidationOptions,
  studioWithoutUnusedFlows,
  studioFlowDefinitionOf,
  studioFlowListAt,
  studioFlowOutline,
  validatedStudioFlowEdit,
  type StudioFlowContext,
  type StudioFlowEditResult,
  type StudioFlowPath,
  type StudioFlowSelection,
  type StudioFlowTaskListOutline,
} from "./application-flow-model";
import { addStudioBackgroundFlow } from "./application-flow-background";
import {
  projectStudioFlowDraftChoices,
  applyStudioFlowStepDraft,
  type StudioFlowStepDraft,
} from "./application-flow-step-form";
import { studioDraftRecordType, studioFlowEventChoices } from "./application-flow-values";
import {
  addStudioFlowShownForm,
  studioFlowCanCreateShownForm,
} from "./application-flow-shown-form";
import { studioFlowLabel } from "./semantic-selection";
import { studioFlowCallerNames } from "./application-flow-start";

/**
 * The flow commands: one checked edit of the stored flow definition each, taken by the draft
 * history through the one apply function. Insert, remove, move and add a branch change the task
 * lists; set a step writes one step's whole settings form back. Every result is checked by
 * `validatedStudioFlowEdit` (limits, source schema, the one flow validator).
 */

export type StudioFlowCommand =
  | Readonly<{
      kind: "insert_task";
      taskType: string;
      settings: StudioFlowNewStepSettings;
      listPath: StudioFlowPath;
      index: number;
    }>
  | Readonly<{ kind: "remove_task"; taskId: string; taskPath: StudioFlowPath }>
  | Readonly<{
      kind: "move_task";
      taskId: string;
      taskPath: StudioFlowPath;
      direction: "up" | "down";
    }>
  /** Adds the branch a decision is missing (Else, Otherwise), starting with one step. */
  | Readonly<{
      kind: "add_branch";
      taskId: string;
      taskPath: StudioFlowPath;
      taskType: string;
      settings: StudioFlowNewStepSettings;
    }>
  /** Writes one step's settings form (its description, settings and control shape) back to the step. */
  | Readonly<{
      kind: "set_step";
      taskId: string;
      taskPath: StudioFlowPath;
      draft: StudioFlowStepDraft;
    }>;

type RegisteredTask = Extract<SourceFlowTask, { properties: unknown }>;

/** Required choices are authored before a new step enters the saved draft. */
export type StudioFlowNewStepSettings = Readonly<{
  /** The builder's pick for each required reference setting of the step, by property key. */
  choices?: Readonly<Record<string, string>>;
  message?: string;
  field?: string;
  condition?: FlowFormula;
  firstStep?: Readonly<{ type: string; settings: StudioFlowNewStepSettings }>;
  value?: FlowFormula;
  caseValue?: FlowLiteral;
  maximumItems?: number;
  flowId?: string;
  inputs?: Readonly<Record<string, FlowValue>>;
}>;

const staleEdit = (
  reason = "The draft or the selected step changed. Select the step again and retry.",
): StudioFlowEditResult => ({ kind: "stale", reason });

// ─── Inserting: steps seeded from the registry and the draft ─────────────────────────────────

const text = (value: string): FlowValue => ({ kind: "literal", literal: { type: "text", value } });

/** The record input the flow runs for: the one it names, or its first record reference input. */
const flowRecordInput = (flow: SourceFlow): string | undefined =>
  flow.recordInput ??
  Object.entries(flow.inputs ?? {}).find(([, input]) => input.type === "record_reference")?.[0];

/** The record type the flow itself runs for (its record input or its trigger), when it has one. */
const flowRecordType = (flow: SourceFlow): string | undefined => {
  const recordInput = flowRecordInput(flow);
  return (
    (recordInput === undefined ? undefined : flow.inputs?.[recordInput]?.recordTypeIds?.at(0)) ??
    (flow.triggers ?? [])
      .flatMap((trigger) => ("recordTypeId" in trigger ? [trigger.recordTypeId] : []))
      .at(0)
  );
};

/**
 * The pick that asks for a new form on the page of the flow's button instead of an existing one.
 * It is not a valid block name, so no form can be named like it.
 */
export const studioNewFormChoice = "+new_form";

/** The pick that asks for a new back-end flow for a Run on back end step instead of an existing one. */
export const studioNewBackendFlowChoice = "+new_backend_flow";

/** One builder decision a step needs before it is inserted: what the setting points at. */
export type StudioFlowStepBuilderChoice = Readonly<{
  property: string;
  label: string;
  unset: string;
  options: readonly Readonly<{ value: string; label: string }>[];
}>;

const builderChoiceLabels: Readonly<Record<string, readonly [label: string, unset: string]>> = {
  form: ["Form to show", "Choose a form before adding the step"],
  operation: ["Operation to call", "Choose an operation before adding the step"],
  page: ["Page to open", "Choose a page before adding the step"],
  query: ["Query to read", "Choose a query before adding the step"],
  record_type: ["Record type", "Choose a record type before adding the step"],
  event: ["Event to announce", "Choose an event before adding the step"],
};

/**
 * What a required setting points at when only the builder can decide it: the forms, operations,
 * pages, queries, record types or events of the draft. Undefined for a setting the flow itself
 * decides (a record type the flow already runs for, a value, a message).
 */
const builderChoiceOptions = (
  type: FlowTaskPropertyType,
  flow: SourceFlow,
  source: Readonly<ApplicationSourceDocument>,
  context: StudioFlowContext,
): StudioFlowStepBuilderChoice["options"] | undefined => {
  const draft = () =>
    projectStudioFlowDraftChoices({
      ...context,
      source: source as ApplicationSourceDocument,
      flow,
    });
  switch (type) {
    case "form_id": {
      const forms = draft().forms.map((form) => ({ value: form.alias, label: form.label }));
      return studioFlowCanCreateShownForm(
        context.catalogue,
        source as ApplicationSourceDocument,
        flow,
      )
        ? [...forms, { value: studioNewFormChoice, label: "Create a form for this step" }]
        : forms;
    }
    case "protected_operation_key":
      return draft().actions.map((action) => ({ value: action.key, label: action.label }));
    case "page_id":
      return draft().pages.map((page) => ({ value: page.key, label: page.label }));
    case "query_id":
      return draft().queries.map((query) => ({ value: query.key, label: query.label }));
    case "flow_id": {
      const module = source.body.modules.find((candidate) =>
        candidate.flows.some((entry) => entry.id === flow.id),
      );
      return (module?.flows ?? source.body.flows)
        .filter((entry) => entry.id !== flow.id)
        .map((entry) => ({ value: entry.id, label: entry.labels?.name ?? studioWords(entry.key) }));
    }
    case "record_type_id":
      return flowRecordType(flow) === undefined
        ? draft().recordTypes.map((record) => ({ value: record.key, label: record.label }))
        : undefined;
    case "namespaced_key": {
      const moduleKey =
        source.body.modules.find((module) =>
          module.flows.some((candidate) => candidate.id === flow.id),
        )?.key ?? null;
      return studioFlowEventChoices(source, flow, moduleKey);
    }
    default:
      return undefined;
  }
};

/** The draft definition of the record type the flow runs for, when it runs for one. */
const flowRecordDefinition = (flow: SourceFlow, source: Readonly<ApplicationSourceDocument>) => {
  const recordType = flowRecordType(flow);
  const moduleKey =
    source.body.modules.find((module) => module.flows.some((candidate) => candidate.id === flow.id))
      ?.key ?? null;
  return recordType === undefined
    ? undefined
    : studioDraftRecordType(source, recordType, moduleKey)?.record;
};

/** The flow's other record input: the target a link or a relationship copy starts with. */
const flowTargetInput = (flow: SourceFlow): string | undefined => {
  const recordInput = flowRecordInput(flow);
  return Object.entries(flow.inputs ?? {}).find(
    ([name, input]) => input.type === "record_reference" && name !== recordInput,
  )?.[0];
};

/** The first relationship of the record type the flow runs for, as a flow names it. */
const flowFirstRelationship = (
  flow: SourceFlow,
  source: Readonly<ApplicationSourceDocument>,
): string | undefined => {
  const relationship = flowRecordDefinition(flow, source)?.relationships.at(0);
  return relationship === undefined ? undefined : `${flowRecordType(flow)}.${relationship.key}`;
};

/** The value of a required setting the flow decides itself, or undefined when it has none. */
const seedValue = (
  type: FlowTaskPropertyType,
  flow: SourceFlow,
  source: Readonly<ApplicationSourceDocument>,
  declaredDefault?: FlowLiteral,
): FlowValue | undefined => {
  const modules = source.body.modules;
  const recordInput = flowRecordInput(flow);
  const recordType = flowRecordType(flow);
  switch (type) {
    case "any_value":
      return text("");
    case "builder_key":
      return declaredDefault === undefined
        ? undefined
        : { kind: "literal", literal: declaredDefault };
    case "record_reference": {
      return recordInput === undefined
        ? undefined
        : { kind: "reference", reference: { source: "input", name: recordInput } };
    }
    case "record_change_list": {
      // One copy of the run's record's first relationship onto the flow's other record.
      const relationship = flowFirstRelationship(flow, source);
      const target = flowTargetInput(flow);
      if (recordInput === undefined || relationship === undefined || target === undefined)
        return undefined;
      return {
        kind: "literal",
        literal: {
          type: "json",
          value: [
            {
              kind: "copy_relationships",
              relationshipIds: [relationship],
              subject: { kind: "reference", reference: { source: "input", name: recordInput } },
              target: { kind: "reference", reference: { source: "input", name: target } },
            },
          ],
        },
      };
    }
    case "relationship_id": {
      const relationship = flowFirstRelationship(flow, source);
      return recordInput === undefined || relationship === undefined
        ? undefined
        : text(relationship);
    }
    case "message_text":
      return text("");
    case "formula":
      return {
        kind: "formula",
        formula: {
          op: "add",
          args: [
            { op: "literal", type: "whole_number", value: 0 },
            { op: "literal", type: "whole_number", value: 0 },
          ],
        },
      };
    case "record_type_id":
      return recordType === undefined ? undefined : text(recordType);
    case "field_values": {
      const formAnswers = Object.entries(flow.inputs ?? {}).find(
        ([, declaration]) => declaration.type === "json",
      )?.[0];
      return formAnswers === undefined
        ? { kind: "map", entries: {} }
        : { kind: "reference", reference: { source: "input", name: formAnswers } };
    }
    case "field_id": {
      // A save rule names a field of the record it runs for, as `<record type>.<field>`: its title field first.
      const recordTypeId = (flow.triggers ?? []).flatMap((trigger) =>
        trigger.type === "BeforeSave" ? [trigger.recordTypeId] : [],
      )[0];
      if (recordTypeId === undefined) return undefined;
      const owner = modules.find((module) =>
        module.flows.some((candidate) => candidate.id === flow.id),
      );
      const record = owner?.record_types.find((candidate) => candidate.key === recordTypeId);
      const field =
        record?.fields.find((candidate) => candidate.key === record.title_field) ??
        record?.fields[0];
      return field === undefined ? undefined : text(`${recordTypeId}.${field.key}`);
    }
    default:
      return undefined;
  }
};

/**
 * Set fields starts with one text field of the run's record that its update permission lets people
 * change, valid as inserted: it keeps the current value, or an optional field starts empty.
 */
const setFieldsSeed = (
  flow: SourceFlow,
  source: Readonly<ApplicationSourceDocument>,
): FlowValue | undefined => {
  const recordType = flowRecordType(flow);
  const moduleKey =
    source.body.modules.find((module) => module.flows.some((candidate) => candidate.id === flow.id))
      ?.key ?? null;
  const found =
    recordType === undefined ? undefined : studioDraftRecordType(source, recordType, moduleKey);
  if (found === undefined) return undefined;
  const changeable = new Set(
    found.module.permissions.flatMap((permission) =>
      permission.action_kind === "update" && permission.record_type === found.record.key
        ? (permission.field_policy?.changeable_fields ?? [])
        : [],
    ),
  );
  const fields = found.record.fields.filter(
    (candidate) =>
      (candidate.type === "text" || candidate.type === "long_text") &&
      changeable.has(candidate.key),
  );
  // A flow that names its record keeps the field's current value until the builder changes it; a
  // save transaction has no triggering record to read, and otherwise an optional field starts empty.
  if (flow.execution === "transaction" && fields[0] !== undefined)
    return { kind: "map", entries: { [fields[0].key]: text("") } };
  if (flow.recordInput !== undefined && fields[0] !== undefined)
    return {
      kind: "map",
      entries: {
        [fields[0].key]: {
          kind: "reference",
          reference: { source: "trigger_record", field: fields[0].key },
        },
      },
    };
  const field = fields.find((candidate) => candidate.required !== true);
  return field === undefined ? undefined : { kind: "map", entries: { [field.key]: text("") } };
};

/** Read selected record fields starts with the title field of the run's record type. */
const readFieldsSeed = (
  flow: SourceFlow,
  source: Readonly<ApplicationSourceDocument>,
): FlowValue | undefined => {
  const recordType = flowRecordType(flow);
  const moduleKey =
    source.body.modules.find((module) => module.flows.some((candidate) => candidate.id === flow.id))
      ?.key ?? null;
  const found =
    recordType === undefined ? undefined : studioDraftRecordType(source, recordType, moduleKey);
  const field =
    found?.record.fields.find((candidate) => candidate.key === found.record.title_field) ??
    found?.record.fields[0];
  return recordType === undefined || field === undefined
    ? undefined
    : {
        kind: "literal",
        literal: {
          type: "json",
          value: [{ alias: field.key, field: `${recordType}.${field.key}` }],
        },
      };
};

/** Build list starts empty, reading `value` and `label` from each item, which the builder points at a list. */
const buildListSeeds: Readonly<Record<string, FlowValue>> = {
  items: { kind: "literal", literal: { type: "json", value: [] } },
  value: text("value"),
  label: text("label"),
};

/** A number a default formatter can show. */
const zeroSeed: FlowValue = { kind: "literal", literal: { type: "whole_number", value: 0 } };

/** A link's target: the flow's other record input, so a record is never linked to itself. */
const targetSeed = (flow: SourceFlow): FlowValue | undefined => {
  const target = flowTargetInput(flow);
  return target === undefined
    ? undefined
    : { kind: "reference", reference: { source: "input", name: target } };
};

/** The reason key a new Refuse save step starts with; the builder words its message. */
const refusalReasonSeed = text("save_refused");

/** The builder decisions a step type needs before it is inserted, with what each can point at. */
const stepBuilderChoices = (
  definition: FlowTaskTypeDefinition,
  flow: SourceFlow,
  source: Readonly<ApplicationSourceDocument>,
  context: StudioFlowContext,
): StudioFlowStepBuilderChoice[] => {
  const choices = Object.entries(definition.properties).flatMap(([property, declaration]) => {
    if (!declaration.required) return [];
    const options = builderChoiceOptions(declaration.type, flow, source, context);
    const [label, unset] = builderChoiceLabels[property] ?? [
      studioWords(property),
      `Choose ${studioWords(property).toLowerCase()} before adding the step`,
    ];
    if (definition.type === "backend.run" && property === "flow")
      // Only a back-end flow can run on the back end; one is made for the step when none exists.
      return [
        {
          property,
          label,
          unset,
          options: [
            ...(options ?? []).filter((option) =>
              [...source.body.flows, ...source.body.modules.flatMap((module) => module.flows)].some(
                (entry) => entry.id === option.value && entry.execution === "background",
              ),
            ),
            { value: studioNewBackendFlowChoice, label: "Create a back-end flow for this step" },
          ],
        },
      ];
    return options === undefined ? [] : [{ property, label, unset, options }];
  });
  // Set value changes a page value: which one is the builder's choice, from the values the flow's
  // pages declare. (Its form and field are the other way to name a target, chosen on the step.)
  if (definition.type === "interface.set_value")
    choices.push({
      property: "value",
      label: "Page value to set",
      unset: "Choose a page value before adding the step",
      options: projectStudioFlowDraftChoices({
        ...context,
        source: source as ApplicationSourceDocument,
        flow,
      }).pageValues.map((entry) => ({ value: entry.name, label: entry.label })),
    });
  return choices;
};

/**
 * A step with its required settings: the flow's own values, and the builder's pick for every
 * setting only the builder can decide. Undefined when a pick is missing or no choice exists.
 */
const seededTask = (
  definition: FlowTaskTypeDefinition,
  id: string,
  flow: SourceFlow,
  source: Readonly<ApplicationSourceDocument>,
  choices: readonly StudioFlowStepBuilderChoice[],
  picks: Readonly<Record<string, string>>,
): RegisteredTask | undefined => {
  const properties: RegisteredTask["properties"] = {};
  if (definition.type === "interface.set_value") {
    const value = picks.value;
    const choice = choices.find((entry) => entry.property === "value");
    if (value === undefined || choice?.options.some((option) => option.value === value) !== true)
      return undefined;
    properties.value = text(value);
    // It starts as an empty value of the page value's own type, which the builder then sets.
    const declared = source.body.pages
      .map((page) => page.values?.[value])
      .find((entry) => entry !== undefined);
    properties.to = {
      kind: "literal",
      literal:
        declared?.type === "money"
          ? { type: "money", value: "0" }
          : declared?.type === "decimal_number"
            ? { type: "decimal_number", value: "0" }
            : declared?.type === "yes_no"
              ? { type: "yes_no", value: false }
              : declared?.type === "json"
                ? { type: "json", value: [] }
                : { type: "text", value: "" },
    } as FlowValue;
  }
  for (const [key, declaration] of Object.entries(definition.properties)) {
    if (!declaration.required) continue;
    // Set value's target was chosen above, and its new value starts from that value's type.
    if (definition.type === "interface.set_value" && key === "to") continue;
    const choice = choices.find((entry) => entry.property === key);
    const pick = picks[key];
    if (choice !== undefined) {
      if (pick === undefined || !choice.options.some((option) => option.value === pick))
        return undefined;
      properties[key] = text(pick);
      continue;
    }
    const seed =
      definition.type === "backend.run" && key === "mode"
        ? text("await")
        : definition.type === "rule.refuse" && key === "reason"
          ? refusalReasonSeed
          : definition.type === "interface.show_message" && key === "target"
            ? // The page shows messages in a dialog today.
              text("dialog")
            : definition.type === "interface.show_message" && key === "severity"
              ? text("info")
              : definition.type === "data.calculate" && key === "result_type"
                ? text("decimal_number")
                : definition.type === "record.link" && key === "target"
                  ? targetSeed(flow)
                  : definition.type === "data.format" && key === "input"
                    ? // A number its default formatter can show; the builder points it at a value.
                      zeroSeed
                    : definition.type === "record.set_fields" && key === "values"
                      ? setFieldsSeed(flow, source)
                      : definition.type === "record.read_fields" && key === "fields"
                        ? readFieldsSeed(flow, source)
                        : definition.type === "data.build_list"
                          ? buildListSeeds[key]
                          : seedValue(declaration.type, flow, source, declaration.default);
    if (seed === undefined) return undefined;
    properties[key] = seed;
  }
  // Set fields changes the record the flow runs for; in a transaction it changes the saved record
  // and may not name it.
  if (definition.type === "record.set_fields" && flow.execution !== "transaction") {
    const record = seedValue("record_reference", flow, source);
    const recordType = seedValue("record_type_id", flow, source);
    if (record === undefined || recordType === undefined) return undefined;
    properties.record_type = recordType;
    properties.record = record;
  }
  // A dialog is headed by what the person was doing: the flow's name.
  if (definition.type === "interface.show_message")
    properties.title = text(flow.labels?.name ?? "");
  if (definition.type === "data.calculate") {
    properties.formula = {
      kind: "formula",
      formula: { op: "literal", type: "decimal_number", value: "0" },
    };
    properties.places = { kind: "literal", literal: { type: "whole_number", value: 2 } };
    properties.rounding = text("half_up");
  }
  return { id, type: definition.type, version: definition.version, properties };
};

/**
 * The inputs of a Call protected operation step: always an explicit map, so the step passes
 * nothing the builder did not map. The flow's record goes to the operation's record input only
 * when the operation declares one for the record type the flow runs for.
 */
export const studioOperationCallProperties = (
  flow: SourceFlow,
  operation: Readonly<{
    key: string;
    inputs: readonly Readonly<{ key: string; type: string; record_types?: readonly string[] }>[];
  }>,
): RegisteredTask["properties"] => {
  const recordInput = flowRecordInput(flow);
  const flowRecordTypes =
    recordInput === undefined ? [] : (flow.inputs?.[recordInput]?.recordTypeIds ?? []);
  const target = operation.inputs.find(
    (input) =>
      input.type === "record_reference" &&
      (input.record_types ?? []).some((type) => flowRecordTypes.includes(type)),
  );
  return {
    operation: text(operation.key),
    inputs: {
      kind: "map",
      entries:
        target === undefined || recordInput === undefined
          ? {}
          : {
              [target.key]: {
                kind: "reference",
                reference: { source: "input", name: recordInput },
              },
            },
    },
  };
};

/** The registry's own placement rule for a flow of this execution kind holding these tasks. */
const placementIssues = (flow: SourceFlow, tasks: readonly SourceFlowTask[]): string[] =>
  validateFlowTaskPlacement({ ...flow, tasks: [...tasks] } as Parameters<
    typeof validateFlowTaskPlacement
  >[0]).map((issue) => issue.message);

export type StudioFlowStepType = Readonly<{
  type: string;
  title: string;
  summary: string;
  /** What the builder decides before the step is inserted; the palette asks for each first. */
  choices: readonly StudioFlowStepBuilderChoice[];
}>;

/** The control steps a person adds from the palette: a decision and an early end. */
const paletteControls = ["if", "switch", "for_each", "sequential", "run_flow", "stop"] as const;

const supportsPlacement = (
  definition: FlowTaskTypeDefinition,
  flow: SourceFlow,
  location: "page" | "server" | "backend",
): boolean => {
  const runLocation =
    location === "page" ? "browser" : flow.execution === "transaction" ? "transaction" : "server";
  const allowed = flowExecutionRunLocations[flow.execution] as readonly string[];
  const actionFlowTask =
    runLocation === "transaction" &&
    flow.triggers.length === 0 &&
    definition.actionFlowTransaction === true;
  return (
    (flow.execution === "interactive"
      ? location !== "backend"
      : flow.execution === "transaction"
        ? location === "server"
        : location === "backend") &&
    allowed.includes(runLocation) &&
    (definition.runLocations.includes(runLocation) || actionFlowTask) &&
    definition.runs[location]
  );
};

/** Registered step types the flow's execution kind accepts and that can start from seeds. */
const registeredTypes = (
  flow: SourceFlow,
  source: Readonly<ApplicationSourceDocument>,
  context: StudioFlowContext,
): FlowTaskTypeDefinition[] =>
  Object.values(flowTaskRegistry).filter((definition) => {
    if (definition.category !== "registered") return false;
    if (
      !(["page", "server", "backend"] as const).some((location) =>
        supportsPlacement(definition, flow, location),
      )
    )
      return false;
    const choices = stepBuilderChoices(definition, flow, source, context);
    // The type is offered when each decision has at least one option; the probe only proves the
    // step would be valid, and is never inserted.
    const probe = Object.fromEntries(
      choices.flatMap((choice) => {
        const option = choice.options.at(0);
        return option === undefined ? [] : [[choice.property, option.value]];
      }),
    );
    const task = seededTask(definition, "probe", flow, source, choices, probe);
    return (
      task !== undefined &&
      sourceFlowTaskSchema.safeParse(task).success &&
      placementIssues({ ...flow, errors: [], finally: [] }, [task]).length === 0
    );
  });

const stepTypes = (
  flow: SourceFlow,
  source: Readonly<ApplicationSourceDocument>,
  context: StudioFlowContext,
): readonly StudioFlowStepType[] => {
  const registered = registeredTypes(flow, source, context);
  const controls =
    registered.length === 0
      ? []
      : paletteControls
          .filter(
            (type) =>
              !flow.triggers.some((trigger) => trigger.type === "BeforeSave") ||
              type === "if" ||
              type === "stop",
          )
          .map((type) => flowTaskRegistry[type])
          .filter((definition) =>
            (["page", "server", "backend"] as const).some((location) =>
              supportsPlacement(definition, flow, location),
            ),
          );
  return [...registered, ...controls].map((definition) => ({
    type: definition.type,
    title: definition.title,
    summary: definition.summary,
    choices:
      definition.category === "registered"
        ? stepBuilderChoices(definition, flow, source, context)
        : [],
  }));
};

const uniqueTaskId = (type: string, used: Set<string>): string => {
  const base = (type.split(".").pop() ?? type).replace(/[^a-z0-9_]/g, "_");
  let candidate = base;
  for (let n = 2; used.has(candidate); n += 1) candidate = `${base}_${n}`;
  used.add(candidate);
  return candidate;
};

/**
 * The visible step before a form's save that stops with "No changes to save." when the form's
 * answers carry no change: the same steps the default Save flow has, shown inline under the form
 * the flow runs from (a dialog when the flow has none).
 */
const noChangeGuard = (
  flow: SourceFlow,
  source: Readonly<ApplicationSourceDocument>,
  context: StudioFlowContext,
  used: Set<string>,
): SourceFlowTask[] => {
  const form = projectStudioFlowDraftChoices({
    ...context,
    source: source as ApplicationSourceDocument,
    flow,
  }).forms.at(0);
  return [
    {
      id: uniqueTaskId("unchanged", used),
      type: "if",
      condition: {
        op: "is_empty",
        arg: { op: "reference", reference: { source: "input", name: "values" } },
      },
      then: [
        {
          id: uniqueTaskId("none_changed", used),
          type: "interface.show_message",
          version: "1.0.0",
          properties: {
            message: text("No changes to save."),
            target: text(form === undefined ? "dialog" : "inline"),
            severity: text("info"),
            ...(form === undefined ? {} : { component: text(form.alias) }),
          },
        },
        { id: uniqueTaskId("stop_unchanged", used), type: "stop", outcome: "no_changes" },
      ],
    },
  ] as unknown as SourceFlowTask[];
};

/** A new step of a type, with required decisions made explicitly by the author. */
const newStep = (
  flow: SourceFlow,
  source: Readonly<ApplicationSourceDocument>,
  taskType: string,
  used: Set<string>,
  context: StudioFlowContext,
  settings: StudioFlowNewStepSettings,
): SourceFlowTask | StudioFlowEditResult => {
  const refused: StudioFlowEditResult = {
    kind: "unsupported",
    reason:
      "This flow cannot run that kind of step, or the step needs settings this application does not have yet.",
  };
  const offered = stepTypes(flow, source, context).find((entry) => entry.type === taskType);
  if (offered === undefined) return refused;
  const picks = settings.choices ?? {};
  const unpicked = offered.choices.find(
    (choice) => !choice.options.some((option) => option.value === picks[choice.property]),
  );
  if (unpicked !== undefined) return { kind: "invalid", reason: `${unpicked.unset}.` };
  const definition = studioFlowDefinitionOf(taskType);
  const needsMessage = definition?.properties.message?.required === true;
  if (needsMessage && !settings.message?.trim())
    return { kind: "invalid", reason: "Write the message before adding this step." };
  if (taskType === "rule.require" && !settings.field)
    return { kind: "invalid", reason: "Choose the field before adding this step." };
  if (taskType === "stop")
    return { id: uniqueTaskId("stop", used), type: "stop", outcome: "stopped" };
  if (taskType === "if") {
    if (settings.condition === undefined || settings.condition.op === "literal")
      return { kind: "invalid", reason: "Set a comparison before adding an If step." };
    if (settings.firstStep === undefined)
      return { kind: "invalid", reason: "Choose the first step of the Then branch." };
    const inner = newStep(
      flow,
      source,
      settings.firstStep.type,
      used,
      context,
      settings.firstStep.settings,
    );
    if ("kind" in inner && !("id" in inner)) return inner;
    return {
      id: uniqueTaskId("decision", used),
      type: "if",
      condition: settings.condition,
      then: [inner as SourceFlowTask],
    };
  }
  if (taskType === "run_flow") {
    if (!settings.flowId || settings.inputs === undefined)
      return { kind: "invalid", reason: "Choose a flow and its required inputs." };
    return {
      id: uniqueTaskId("run_flow", used),
      type: "run_flow",
      flowId: settings.flowId,
      inputs: { ...settings.inputs },
    };
  }
  if (taskType === "switch" || taskType === "for_each" || taskType === "sequential") {
    if (settings.firstStep === undefined)
      return { kind: "invalid", reason: "Choose the first step." };
    const inner = newStep(
      flow,
      source,
      settings.firstStep.type,
      used,
      context,
      settings.firstStep.settings,
    );
    if ("kind" in inner && !("id" in inner)) return inner;
    const tasks = [inner as SourceFlowTask];
    if (taskType === "sequential")
      return { id: uniqueTaskId("sequential", used), type: "sequential", tasks };
    if (settings.value === undefined)
      return { kind: "invalid", reason: "Enter a value expression." };
    const value: FlowValue = { kind: "formula", formula: settings.value };
    if (taskType === "switch") {
      if (settings.caseValue === undefined)
        return { kind: "invalid", reason: "Enter a case value." };
      return {
        id: uniqueTaskId("switch", used),
        type: "switch",
        value,
        cases: [{ key: "case_1", when: settings.caseValue, tasks }],
      };
    }
    if (
      !Number.isSafeInteger(settings.maximumItems) ||
      settings.maximumItems! < 1 ||
      settings.maximumItems! >
        (isSetBasedForEach({ type: "for_each", tasks })
          ? flowMaximumSetBasedForEachItems
          : flowMaximumForEachItemsOther)
    )
      return { kind: "invalid", reason: "Enter a valid maximum number of items." };
    return {
      id: uniqueTaskId("for_each", used),
      type: "for_each",
      items: value,
      maximumItems: settings.maximumItems!,
      tasks,
    };
  }
  const task =
    definition === undefined
      ? undefined
      : seededTask(
          definition,
          uniqueTaskId(definition.type, used),
          flow,
          source,
          offered.choices,
          picks,
        );
  if (task !== undefined && settings.message !== undefined)
    task.properties.message = text(settings.message.trim());
  if (task?.type === "rule.require" && settings.field !== undefined)
    task.properties.field = text(settings.field);
  if (task?.type === "operation.call") {
    const operation = source.body.modules
      .flatMap((module) => module.actions)
      .find((entry) => entry.key === picks.operation);
    if (operation === undefined) return refused;
    task.properties = studioOperationCallProperties(flow, operation);
  }
  if (task?.type === "interface.show_form") {
    const form = projectStudioFlowDraftChoices({
      ...context,
      source: source as ApplicationSourceDocument,
      flow,
    }).forms.find((entry) => entry.alias === picks.form);
    if (form === undefined) return refused;
    task.properties.inputs = {
      kind: "map",
      entries: Object.fromEntries(
        form.fields.map((field) => [field.name, field.initialValue ?? text("")]),
      ),
    };
  }
  return task ?? refused;
};

// ─── Step actions: what the inspector offers for one step ────────────────────────────────────

export type StudioFlowStepActions = Readonly<{
  /** Step types that can be added to this flow. */
  stepTypes: readonly StudioFlowStepType[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** The branch Add branch would create, or null when this step has none to add. */
  branch: string | null;
}>;

export const projectStudioFlowStepActions = (
  context: StudioFlowContext,
  selection: StudioFlowSelection,
  taskPath: StudioFlowPath | null,
): StudioFlowStepActions => {
  try {
    const current = studioFlowOutline(context, selection);
    const types =
      current.entries.length < flowMaximumTaskCount
        ? stepTypes(current.flow, context.source, context)
        : [];
    if (taskPath === null)
      return { stepTypes: types, canMoveUp: false, canMoveDown: false, branch: null };
    const index = taskPath[taskPath.length - 1];
    const list = studioFlowListAt(current.flow, taskPath.slice(0, -1));
    const task = typeof index === "number" ? list?.[index] : undefined;
    const branch =
      task === undefined
        ? null
        : task.type === "if" && "then" in task && task.else === undefined
          ? "Else"
          : task.type === "switch" && "cases" in task && task.default === undefined
            ? "Otherwise"
            : null;
    return {
      stepTypes: types,
      canMoveUp: typeof index === "number" && index > 0,
      canMoveDown: typeof index === "number" && list !== undefined && index < list.length - 1,
      branch,
    };
  } catch (error) {
    console.error("[studio-flow] step actions unavailable", error);
    return { stepTypes: [], canMoveUp: false, canMoveDown: false, branch: null };
  }
};

/** The step types for a flow, or why none could be worked out. */
export const projectStudioFlowStepTypes = (
  context: StudioFlowContext,
  selection: StudioFlowSelection,
): readonly StudioFlowStepType[] =>
  projectStudioFlowStepActions(context, selection, null).stepTypes;

/** A step is offered inside a control only where the control and the step share an implementation. */
export const studioFlowStepTypesUnder = (
  types: readonly StudioFlowStepType[],
  flow: SourceFlow,
  controlTypes: readonly string[],
): readonly StudioFlowStepType[] => {
  const controls = controlTypes.map((type) => studioFlowDefinitionOf(type));
  return types.filter((entry) => {
    const definition = studioFlowDefinitionOf(entry.type);
    return (
      definition !== undefined &&
      controls.every(
        (control) =>
          control !== undefined &&
          (["page", "server", "backend"] as const).some(
            (location) =>
              supportsPlacement(control, flow, location) &&
              supportsPlacement(definition, flow, location),
          ),
      )
    );
  });
};

/**
 * The step types offered in one list: those every enclosing control can run, and inside a loop
 * only those its compiled placement can run, as a loop body cannot mix page and server steps.
 */
export const studioFlowStepTypesAt = (
  types: readonly StudioFlowStepType[],
  flow: SourceFlow,
  entries: readonly Readonly<{ task: SourceFlowTask; path: StudioFlowPath }>[],
  listPath: StudioFlowPath,
  placements: Readonly<Record<string, "page" | "server" | "backend">> | null,
): readonly StudioFlowStepType[] => {
  const enclosing = entries.filter(
    (entry) =>
      listPath.length > entry.path.length &&
      samePath(listPath.slice(0, entry.path.length), entry.path),
  );
  const offered = studioFlowStepTypesUnder(
    types,
    flow,
    enclosing.map((entry) => entry.task.type),
  );
  const loop = enclosing.find((entry) => entry.task.type === "for_each");
  if (loop === undefined) return offered;
  const location = placements?.[loop.task.id];
  if (location === undefined) return [];
  return offered.filter((entry) => {
    const definition = studioFlowDefinitionOf(entry.type);
    return definition !== undefined && supportsPlacement(definition, flow, location);
  });
};

// ─── Removing ────────────────────────────────────────────────────────────────────────────────

/** Refuse retained references; never turn deletion into an implicit reference repair. */
const hasRetainedTaskReference = (flow: Readonly<SourceFlow>, taskId: string): boolean => {
  const pending: unknown[] = [flow];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      const reference = parseFlowReference(value);
      if (reference?.source === "task_output" && reference.task === taskId) return true;
    } else if (typeof value === "object" && value !== null) {
      if (seen.has(value)) continue;
      seen.add(value);
      if (
        ("source" in value &&
          value.source === "task_output" &&
          "task" in value &&
          value.task === taskId) ||
        ("kind" in value && value.kind === "flow_node" && "key" in value && value.key === taskId)
      )
        return true;
      pending.push(...Object.values(value));
    }
  }
  return false;
};

// ─── The one apply function ──────────────────────────────────────────────────────────────────

const commandTask = (
  lists: readonly StudioFlowTaskListOutline[],
  id: string,
  path: StudioFlowPath,
): string | undefined => {
  for (const list of lists)
    for (const task of list.tasks) {
      if (task.id === id && samePath(task.path, path)) return task.title;
      const child = commandTask(task.children, id, path);
      if (child !== undefined) return child;
    }
  return undefined;
};

/** Applies one flow command to a detached copy of the current draft and checks the result. */
export const applyStudioFlowCommand = (
  current: StudioFlowContext,
  expected: StudioFlowContext,
  selection: StudioSemanticSelection | null,
  expectedSelection: StudioFlowSelection,
  command: StudioFlowCommand,
): StudioFlowEditResult => {
  if (!sameStudioFlowContext(current, expected, selection, expectedSelection)) return staleEdit();
  try {
    const original = studioFlowOutline(current, expectedSelection);
    const used = new Set(original.entries.map((entry) => entry.task.id));
    const candidate: ApplicationSourceDocument = structuredClone(current.source);
    const detached = studioFlowOutline({ ...current, source: candidate }, expectedSelection).flow;
    const done = (taskId: string) =>
      validatedStudioFlowEdit(candidate, current.source, expectedSelection, taskId, current);
    const full =
      original.entries.length >= flowMaximumTaskCount
        ? {
            kind: "invalid" as const,
            reason: `A flow can hold at most ${flowMaximumTaskCount} steps, nested steps included.`,
          }
        : undefined;

    /** A Show form step that asks for a new form gets it on the page of the flow's button first. */
    const stepInputs = (
      taskType: string,
      settings: StudioFlowNewStepSettings,
    ):
      | { source: Readonly<ApplicationSourceDocument>; settings: StudioFlowNewStepSettings }
      | { refused: StudioFlowEditResult } => {
      let source: Readonly<ApplicationSourceDocument> = current.source;
      if (settings.firstStep !== undefined) {
        const inner = stepInputs(settings.firstStep.type, settings.firstStep.settings);
        if ("refused" in inner) return inner;
        source = inner.source;
        settings = { ...settings, firstStep: { ...settings.firstStep, settings: inner.settings } };
      }
      if (taskType === "backend.run" && settings.choices?.flow === studioNewBackendFlowChoice) {
        const recordType = flowRecordType(original.flow);
        if (recordType === undefined)
          return {
            refused: {
              kind: "invalid",
              reason: "This flow runs for no record, so a back-end flow cannot be made for it.",
            } as const,
          };
        const moduleKey =
          candidate.body.modules.find((entry) =>
            entry.flows.some((flow) => flow.id === original.flow.id),
          )?.key ?? null;
        const made = addStudioBackgroundFlow(
          candidate.body,
          {
            kind: "background",
            moduleKey,
            recordTypeKey: recordType,
            name: `${studioFlowLabel(original.flow)} back-end flow`,
            event: null,
          },
          `${studioFlowLabel(original.flow)} back-end flow`,
        );
        if (typeof made === "string")
          return { refused: { kind: "invalid", reason: made } as const };
        return {
          source: candidate as Readonly<ApplicationSourceDocument>,
          settings: { ...settings, choices: { ...settings.choices, flow: made.flow.id } },
        };
      }
      if (taskType !== "interface.show_form" || settings.choices?.form !== studioNewFormChoice)
        return { source, settings };
      const added = addStudioFlowShownForm(
        current.catalogue,
        candidate,
        original.flow,
        studioFlowLabel(original.flow),
      );
      if (!added.ok) return { refused: { kind: "invalid", reason: added.reason } as const };
      return {
        source: candidate as Readonly<ApplicationSourceDocument>,
        settings: { ...settings, choices: { ...settings.choices, form: added.alias } },
      };
    };

    if (command.kind === "insert_task") {
      const target = studioFlowListAt(detached, command.listPath);
      if (
        target === undefined ||
        !Number.isInteger(command.index) ||
        command.index < 0 ||
        command.index > target.length
      )
        return staleEdit("That place in the flow changed. Select a step again and retry.");
      if (full !== undefined) return full;
      const inputs = stepInputs(command.taskType, command.settings);
      if ("refused" in inputs) return inputs.refused;
      const task = newStep(
        original.flow,
        inputs.source,
        command.taskType,
        used,
        current,
        inputs.settings,
      );
      if ("kind" in task && !("id" in task)) return task;
      // Saving the changes of a form's record starts by saying so when nothing changed.
      const guard =
        command.taskType === "record.save" &&
        original.flow.inputs?.values?.type === "json" &&
        flowRecordInput(original.flow) !== undefined
          ? noChangeGuard(original.flow, inputs.source, current, used)
          : [];
      target.splice(command.index, 0, ...guard, task as SourceFlowTask);
      return done((task as SourceFlowTask).id);
    }

    if (
      !builderKeySchema.safeParse(command.taskId).success ||
      commandTask(original.lists, command.taskId, command.taskPath) === undefined
    )
      return staleEdit("That step is no longer in the draft. Select it again.");
    const index = command.taskPath[command.taskPath.length - 1];
    const parentPath = command.taskPath.slice(0, -1);
    const list = studioFlowListAt(detached, parentPath);
    if (typeof index !== "number" || list?.[index]?.id !== command.taskId) return staleEdit();

    switch (command.kind) {
      case "remove_task": {
        if (list.length === 1 && parentPath[0] !== "errors" && parentPath[0] !== "finally")
          return {
            kind: "unsupported",
            reason:
              parentPath.length === 1
                ? "A flow keeps at least one step. Add another step first, then remove this one."
                : "A branch keeps at least one step. Remove the step that owns the branch instead.",
          };
        const removed = original.entries
          .filter(
            ({ path }) =>
              path.length >= command.taskPath.length &&
              samePath(path.slice(0, command.taskPath.length), command.taskPath),
          )
          .map(({ task }) => task.id);
        list.splice(index, 1);
        const referenced = removed.find((id) => hasRetainedTaskReference(detached, id));
        if (referenced !== undefined)
          return {
            kind: "unsupported",
            reason:
              "Another step or part of the application still reads the result of this step. Change that first.",
          };
        return done(command.taskId);
      }
      case "move_task": {
        const to = index + (command.direction === "up" ? -1 : 1);
        if (to < 0 || to >= list.length)
          return {
            kind: "invalid",
            reason:
              command.direction === "up"
                ? "This step is already first in its list."
                : "This step is already last in its list.",
          };
        const [moved] = list.splice(index, 1);
        list.splice(to, 0, moved!);
        return done(command.taskId);
      }
      case "add_branch": {
        if (full !== undefined) return full;
        const inputs = stepInputs(command.taskType, command.settings);
        if ("refused" in inputs) return inputs.refused;
        const task = newStep(
          original.flow,
          inputs.source,
          command.taskType,
          used,
          current,
          inputs.settings,
        );
        if ("kind" in task && !("id" in task)) return task;
        const owner = list[index]!;
        if (owner.type === "if" && "then" in owner && owner.else === undefined)
          owner.else = [task as SourceFlowTask];
        else if (owner.type === "switch" && "cases" in owner && owner.default === undefined)
          owner.default = [task as SourceFlowTask];
        else
          return {
            kind: "unsupported",
            reason:
              "This step has no branch to add. Only a decision without Else or Otherwise can get one.",
          };
        return done((task as SourceFlowTask).id);
      }
      case "set_step": {
        const built = applyStudioFlowStepDraft(
          current.source,
          original.flow,
          expectedSelection.moduleKey,
          list[index]!,
          command.taskPath,
          command.draft,
        );
        if (!built.ok) return { kind: "invalid", reason: built.reason };
        // Settings that come out as the step already has them apply as no change.
        list[index] = built.value;
        const checked = done(command.taskId);
        // A well-formed formula belongs in the draft even when its type or references will
        // prevent publication. Other new validation issues still refuse the edit.
        if (
          checked.kind === "invalid" &&
          Array.isArray(checked.cause) &&
          checked.cause.length > 0 &&
          checked.cause.every((issue) => {
            if (issue.taskId !== command.taskId || !Array.isArray(issue.path)) return false;
            const property = issue.path.lastIndexOf("properties");
            return property >= 0 && issue.path[property + 1] === "formula";
          })
        )
          return { kind: "applied", source: candidate, taskId: command.taskId };
        return checked;
      }
    }
  } catch (cause) {
    return { kind: "invalid", cause, reason: "The draft could not be read to make this change." };
  }
};

// ─── Combining two flows on one event ────────────────────────────────────────────────────────

export type StudioFlowCombineResult =
  | Readonly<{
      kind: "applied";
      source: ApplicationSourceDocument;
      /** The new flow the event runs, and the two flows it replaced (removed when nothing else uses them). */
      flowKey: string;
      replaced: readonly [string, string];
    }>
  | Readonly<{ kind: "refused"; reason: string }>;

/** Step types after which a flow does not carry on: a second flow's steps would never run. */
const endingStepTypes: ReadonlySet<string> = new Set(["stop", "interface.navigate", "rule.refuse"]);

type FlowTaskList = readonly SourceFlowTask[];
const childTaskLists = (task: SourceFlowTask): FlowTaskList[] =>
  flowTaskChildLists(task as never).map((child) => child.tasks as unknown as FlowTaskList);

const flowTaskIds = (tasks: FlowTaskList, ids: string[] = []): string[] => {
  for (const task of tasks) {
    ids.push(task.id);
    for (const children of childTaskLists(task)) flowTaskIds(children, ids);
  }
  return ids;
};

const endsEarly = (tasks: FlowTaskList): boolean =>
  tasks.some(
    (task) =>
      endingStepTypes.has(task.type) || childTaskLists(task).some((list) => endsEarly(list)),
  );

/** The value with every reference to a renamed step pointing at its new id. */
const renameStepReferences = (value: unknown, renames: ReadonlyMap<string, string>): unknown => {
  if (typeof value === "string")
    return value.replace(/{{\s*outputs\.([a-z][a-z0-9_]*)\./g, (whole, task: string) => {
      const next = renames.get(task);
      return next === undefined ? whole : `{{ outputs.${next}.`;
    });
  if (Array.isArray(value)) return value.map((item) => renameStepReferences(item, renames));
  if (value === null || typeof value !== "object") return value;
  const entry = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(entry).map(([key, child]) => {
      const renamed =
        typeof child === "string" &&
        renames.has(child) &&
        (key === "id" || (key === "task" && entry.source === "task_output"));
      return [key, renamed ? renames.get(child as string) : renameStepReferences(child, renames)];
    }),
  );
};

/**
 * One event runs one flow, so two flows wanted on one event become one new flow: the first flow's
 * steps, then the second's. The second flow's step ids are made unique and its references to its
 * own steps follow. Inputs, variables and outputs are merged; two different declarations of one
 * name are refused with a sentence. The event now runs the new flow; the two old flows stay in the
 * draft for the caller to remove when nothing else uses them. It is one edit of the draft.
 */
export const applyStudioFlowCombine = (
  source: ApplicationSourceDocument,
  bindingId: string,
  otherFlowKey: string,
): StudioFlowCombineResult => {
  const refuse = (reason: string): StudioFlowCombineResult => ({ kind: "refused", reason });
  const candidate = structuredClone(source);
  const body = candidate.body;
  const binding = body.flow_bindings.find((entry) => entry.id === bindingId);
  const first = body.flows.find((flow) => flow.id === binding?.flow || flow.key === binding?.flow);
  const second = body.flows.find((flow) => flow.key === otherFlowKey);
  if (binding === undefined || first === undefined || second === undefined)
    return refuse("That event or flow is no longer in the draft. Reload the draft.");
  if (first.id === second.id) return refuse("Choose a different flow to combine with.");
  if (second.execution !== "interactive" || second.triggers.length > 0)
    return refuse(
      `${studioFlowLabel(second)} also starts from a record event, so it cannot be combined.`,
    );
  if (endsEarly(first.tasks))
    return refuse(
      `${studioFlowLabel(first)} can end before the second flow's steps run (it navigates, stops or refuses). Remove that step first.`,
    );
  if (JSON.stringify(first.runAs) !== JSON.stringify(second.runAs))
    return refuse("The two flows run as different people, so they cannot be combined.");
  const merge = <Value>(
    what: string,
    a: Readonly<Record<string, Value>>,
    b: Readonly<Record<string, Value>>,
  ): Record<string, Value> | string => {
    const merged: Record<string, Value> = { ...a };
    for (const [name, declared] of Object.entries(b)) {
      if (name in merged && JSON.stringify(merged[name]) !== JSON.stringify(declared))
        return `Both flows declare the ${what} "${name}" differently. Rename one of them first.`;
      merged[name] = declared;
    }
    return merged;
  };
  const inputs = merge("input", first.inputs, second.inputs);
  if (typeof inputs === "string") return refuse(inputs);
  const variables = merge("variable", first.variables, second.variables);
  if (typeof variables === "string") return refuse(variables);
  const clashing = Object.keys(second.outputs).find((name) => name in first.outputs);
  if (clashing !== undefined)
    return refuse(`Both flows return "${clashing}". Rename one of them first.`);
  if (
    first.recordInput !== undefined &&
    second.recordInput !== undefined &&
    first.recordInput !== second.recordInput
  )
    return refuse("The two flows run for different record inputs, so they cannot be combined.");
  const lists = (flow: SourceFlow): FlowTaskList[] => [flow.tasks, flow.errors, flow.finally];
  const taken = new Set(lists(first).flatMap((list) => flowTaskIds(list)));
  const renames = new Map<string, string>();
  for (const id of lists(second).flatMap((list) => flowTaskIds(list))) {
    if (!taken.has(id)) {
      taken.add(id);
      continue;
    }
    const next = studioFlowKeyFrom(`${id}_2`, taken);
    if (next === undefined) return refuse("No free step name could be made. Rename a step first.");
    taken.add(next);
    renames.set(id, next);
  }
  const moved = <Value>(value: Value): Value => renameStepReferences(value, renames) as Value;
  const wantedName = `${studioFlowLabel(first)} and ${studioFlowLabel(second)}`.slice(0, 94);
  const names = new Set(
    [...body.flows, ...body.modules.flatMap((module) => module.flows)].map((flow) =>
      (flow.labels?.name ?? flow.key).toLowerCase(),
    ),
  );
  let name = wantedName;
  for (let n = 2; names.has(name.toLowerCase()); n += 1) name = `${wantedName} ${n}`;
  const key = studioFlowKeyFrom(name, new Set(body.flows.flatMap((flow) => [flow.id, flow.key])));
  if (key === undefined) return refuse("No free name could be made for the combined flow.");
  const supplied = new Set(studioFlowCallerNames(binding.event).map((entry) => entry.name));
  const bindingInputs: typeof binding.inputs = { ...binding.inputs };
  for (const [inputName, declared] of Object.entries(second.inputs)) {
    if (inputName in bindingInputs) continue;
    if (supplied.has(inputName)) bindingInputs[inputName] = { kind: "caller", name: inputName };
    else if (declared.required)
      return refuse(
        `${studioFlowLabel(second)} needs "${inputName}", which this event does not supply.`,
      );
  }
  const recordInput = first.recordInput ?? second.recordInput;
  const combined: SourceFlow = {
    id: key,
    key,
    description: `${studioFlowLabel(first)}, then ${studioFlowLabel(second)}.`,
    labels: { name },
    execution: "interactive",
    runAs: first.runAs,
    inputs,
    ...(recordInput === undefined ? {} : { recordInput }),
    variables,
    triggers: [],
    tasks: [...first.tasks, ...moved(second.tasks)],
    outputs: { ...first.outputs, ...moved(second.outputs) },
    errors: [...first.errors, ...moved(second.errors)],
    finally: [...first.finally, ...moved(second.finally)],
  };
  body.flows.push(combined);
  binding.flow = key;
  binding.inputs = bindingInputs;
  const parsed = applicationSourceDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return refuse(
      issue === undefined
        ? "The combined flow is not valid."
        : `The combined flow is not valid: ${issue.message} (${issue.path.map(String).join(", ")}).`,
    );
  }
  const problem = validateFlow(
    combined,
    studioFlowValidationOptions(parsed.data, combined, [
      ...parsed.data.body.flows,
      ...parsed.data.body.modules.flatMap((module) => module.flows),
    ]),
  )[0];
  if (problem !== undefined) return refuse(`The combined flow is not valid: ${problem.message}.`);
  return {
    kind: "applied",
    source: studioWithoutUnusedFlows(parsed.data, [first.key, second.key]),
    flowKey: key,
    replaced: [first.key, second.key],
  };
};
