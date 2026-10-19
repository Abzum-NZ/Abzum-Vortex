import {
  builderKeySchema,
  flowFormulaSchema,
  flowLiteralSchema,
  flowRoundingModeSchema,
  sourcePageShell,
  type ApplicationSourceDocument,
  type FlowFormula,
  type FlowLiteral,
  type FlowRoundingMode,
  type FlowTaskPropertyType,
  type FlowValue,
  type ImmutablePlatformBlockCatalogue,
  type SourceFlow,
  type SourceFlowTask,
} from "@vortex/platform/schema";
import { traverseStudioSemanticSelectionDraft, type StudioSemanticPlacementOwner } from "./semantic-selection";
import {
  describeStudioFlowLocation,
  studioFlowDefinitionOf,
  studioWords,
  type StudioFlowPath,
} from "./application-flow-model";
import {
  studioDraftRecordType,
  studioFlowEventChoices,
  studioFieldValueType,
  studioFlowValueOf,
  studioFlowValueSourceOf,
  studioKeyProblem,
  type StudioFlowValueSource,
} from "./application-flow-values";

/**
 * The settings form of one flow step, generated from the step catalogue's declaration of its type
 * (or, for a control step, from the flow contract's shape of it), with one typed control per
 * declared property type. Every registered step type and every control step has a form; a step
 * whose type is not in the catalogue is refused with where it is. The form's edited values are one
 * step draft, which `applyStudioFlowStepDraft` turns back into the stored task.
 */

// ─── Calculations: one operator over two numbers ─────────────────────────────────────────────

export type StudioFlowCalculationOperand =
  | Readonly<{ kind: "literal"; literal:
      | Readonly<{ type: "whole_number"; value: number }>
      | Readonly<{ type: "decimal_number"; value: string }> }>
  | Readonly<{ kind: "input" | "variable"; name: string }>;
export type StudioFlowCalculation = Readonly<{
  operator: "add" | "subtract" | "multiply" | "divide";
  left: StudioFlowCalculationOperand;
  right: StudioFlowCalculationOperand;
  scale: number;
  rounding: FlowRoundingMode;
}>;
export type StudioFlowCalculationReference = Readonly<{ kind: "input" | "variable"; name: string;
  type: "whole_number" | "decimal_number" }>;

const calculationReferences = (flow: SourceFlow): StudioFlowCalculationReference[] => {
  const references: StudioFlowCalculationReference[] = [];
  for (const [name, declaration] of Object.entries(flow.inputs ?? {}))
    if (declaration.type === "whole_number" || declaration.type === "decimal_number")
      references.push({ kind: "input", name, type: declaration.type });
  for (const [name, declaration] of Object.entries(flow.variables ?? {}))
    if ((declaration.type === "whole_number" || declaration.type === "decimal_number") && Object.hasOwn(declaration, "default"))
      references.push({ kind: "variable", name, type: declaration.type });
  return references;
};

const formulaOperand = (formula: FlowFormula): StudioFlowCalculationOperand | undefined => {
  if (formula.op === "literal") {
    if (formula.type === "whole_number" && typeof formula.value === "number")
      return { kind: "literal", literal: { type: "whole_number", value: formula.value } };
    if (formula.type === "decimal_number" && typeof formula.value === "string")
      return { kind: "literal", literal: { type: "decimal_number", value: formula.value } };
    return undefined;
  }
  if (formula.op === "reference" && (formula.reference.source === "input" || formula.reference.source === "variable") &&
    "name" in formula.reference)
    return { kind: formula.reference.source, name: formula.reference.name };
  return undefined;
};

/** A formula the calculation control shows: one operator over two numbers or numeric references. */
const formulaCalculation = (value: FlowValue): StudioFlowCalculation | undefined => {
  if (value.kind !== "formula") return undefined;
  const formula = value.formula;
  if ((formula.op !== "add" && formula.op !== "subtract" && formula.op !== "multiply" && formula.op !== "divide") ||
    formula.args.length !== 2) return undefined;
  const left = formulaOperand(formula.args[0]!);
  const right = formulaOperand(formula.args[1]!);
  return left === undefined || right === undefined ? undefined
    : { operator: formula.op, left, right, scale: formula.scale, rounding: formula.rounding };
};

const calculationFormula = (flow: SourceFlow, calculation: StudioFlowCalculation, label: string):
  Readonly<{ ok: true; value: FlowValue }> | Readonly<{ ok: false; reason: string }> => {
  if (!Number.isInteger(calculation.scale) || calculation.scale < 0 || calculation.scale > 18)
    return { ok: false, reason: `${label}: keep between 0 and 18 decimal places.` };
  if (!flowRoundingModeSchema.safeParse(calculation.rounding).success) return { ok: false, reason: `${label}: choose how to round.` };
  const references = calculationReferences(flow);
  const operand = (side: StudioFlowCalculationOperand): FlowFormula | undefined => {
    if (side.kind === "literal")
      return flowLiteralSchema.safeParse(side.literal).success ? { op: "literal", type: side.literal.type, value: side.literal.value } : undefined;
    return references.some((entry) => entry.kind === side.kind && entry.name === side.name)
      ? { op: "reference", reference: { source: side.kind, name: side.name } } : undefined;
  };
  const left = operand(calculation.left);
  const right = operand(calculation.right);
  if (left === undefined || right === undefined)
    return { ok: false, reason: `${label}: each side must be a number or one of the flow's numeric inputs or variables.` };
  const formula: FlowFormula = { op: calculation.operator, args: [left, right], scale: calculation.scale, rounding: calculation.rounding };
  return flowFormulaSchema.safeParse(formula).success ? { ok: true, value: { kind: "formula", formula } }
    : { ok: false, reason: `${label}: this calculation is not valid.` };
};

// ─── What the draft offers a step ────────────────────────────────────────────────────────────

export type StudioFlowNamedEntry = Readonly<{ name: string; label: string; type: string | undefined; required: boolean; initialValue?: FlowValue }>;

/** The parts of the draft a step setting can point at, read from the draft being edited. */
export type StudioFlowDraftChoices = Readonly<{
  recordTypes: readonly Readonly<{ key: string; label: string }>[];
  pages: readonly Readonly<{ key: string; label: string; recordType: string | null }>[];
  forms: readonly Readonly<{ alias: string; label: string; fields: readonly StudioFlowNamedEntry[] }>[];
  actions: readonly Readonly<{ key: string; label: string; recordType: string; inputs: readonly StudioFlowNamedEntry[] }>[];
  queries: readonly Readonly<{ key: string; label: string }>[];
  connections: readonly Readonly<{ key: string; label: string }>[];
}>;

const actionInputType = (type: string): string =>
  type;

/** Everything a step setting can point at in the draft: record types, pages, forms, module actions, queries and connections. */
export const projectStudioFlowDraftChoices = (draft: Readonly<{
  rootId: Parameters<typeof traverseStudioSemanticSelectionDraft>[0]["rootId"];
  source: ApplicationSourceDocument; catalogue: ImmutablePlatformBlockCatalogue; flow?: SourceFlow }>): StudioFlowDraftChoices => {
  const source = draft.source;
  const forms: { alias: string; label: string; fields: StudioFlowNamedEntry[] }[] = [];
  const open: { alias: string; fields: StudioFlowNamedEntry[] }[] = [];
  const owners = new Map<string, StudioSemanticPlacementOwner>();
  const pagesFor = (owner: StudioSemanticPlacementOwner): string[] => owner.kind === "page" ? [owner.pageAlias]
    : source.body.pages.filter((page) => sourcePageShell(page.composition) === owner.shellAlias).map((page) => page.id);
  traverseStudioSemanticSelectionDraft(draft, ({ phase, node }) => {
    if (node.kind !== "placement") return;
    const release = draft.catalogue.releases.find((candidate) => String(candidate.blockId) === node.block.block_id &&
      String(candidate.releaseVersion) === node.block.release_version);
    const isForm = release?.supportedEvents.includes("form_submit") === true;
    if (phase === "exit") { if (isForm) open.pop(); return; }
    owners.set(node.selection.placementAlias, node.owner);
    const name = node.settings.name;
    const fieldProperty = release?.properties.find((property) => property.kind === "field_reference" && property.derivesFieldInput === true);
    const reference = fieldProperty === undefined ? undefined : node.settings[fieldProperty.key];
    const dot = typeof reference === "string" ? reference.lastIndexOf(".") : -1;
    const found = typeof reference === "string" && dot > 0 ? studioDraftRecordType(source, reference.slice(0, dot), null) : undefined;
    const field = found?.record.fields.find((field) => field.key === String(reference).slice(dot + 1));
    if (!isForm && open.length > 0) {
      if (field !== undefined) open[open.length - 1]!.fields.push({ name: field.key, label: field.label,
        type: studioFieldValueType(field.type), required: field.required,
        initialValue: { kind: "literal", literal: { type: "json", value: field.default ?? null } } });
      else if (typeof name === "string") open[open.length - 1]!.fields.push({ name,
        label: typeof node.settings.label === "string" ? node.settings.label : studioWords(name),
        type: undefined, required: node.settings.required === true });
    }
    if (isForm) {
      const entry = { alias: node.selection.placementAlias, label: node.label, fields: [] as StudioFlowNamedEntry[] };
      forms.push(entry);
      open.push(entry);
    }
  });
  const controls = source.body.flow_bindings.filter((binding) => draft.flow !== undefined &&
    (binding.flow === draft.flow.id || binding.flow === draft.flow.key)).map((binding) => binding.control);
  const invokingPages = [...new Set(controls.flatMap((control) => {
    const owner = owners.get(control); return owner === undefined ? [] : pagesFor(owner);
  }))];
  const availableForms = draft.flow === undefined ? forms : forms.filter((form) => {
    const owner = owners.get(form.alias);
    if (owner === undefined || invokingPages.length === 0) return false;
    const pages = pagesFor(owner);
    return invokingPages.every((page) => pages.includes(page));
  });
  return {
    recordTypes: source.body.modules.flatMap((module) => module.record_types.map((record) =>
      ({ key: `${module.key}:${record.key}`, label: `${record.name} (${module.name})` }))),
    pages: source.body.pages.map((page) => ({ key: page.key, label: page.name,
      recordType: page.type === "detail" && "record_type" in page && typeof page.record_type === "string" ? page.record_type : null })),
    forms: availableForms,
    actions: source.body.modules.flatMap((module) => module.actions.map((action) => ({
      key: action.key, label: action.label, recordType: `${module.key}:${action.record_type}`,
      inputs: action.inputs.map((input) => ({ name: input.key, label: input.label, type: actionInputType(input.type), required: input.required })),
    }))),
    queries: source.body.modules.flatMap((module) => module.queries.map((query) =>
      ({ key: `${module.key}:${query.key}`, label: query.label ?? studioWords(query.key) }))),
    connections: source.body.connection_bindings.map((binding) => ({ key: binding.id, label: studioWords(binding.id) })),
  };
};

// ─── The form ────────────────────────────────────────────────────────────────────────────────

/** How one setting is edited. Each maps to one stored value shape, chosen by the declared property type. */
export type StudioFlowPropertyControl =
  | "value" | "message" | "key" | "record_type" | "page" | "form" | "query" | "flow" | "operation" | "connection"
  | "field" | "relationship" | "calculation" | "field_values" | "input_map";

/** One field of a record type, as a field mapping row offers it. */
export type StudioFlowRecordField = Readonly<{ key: string; label: string; type: string; valueType: string | undefined;
  required: boolean; options: readonly Readonly<{ value: string; label: string }>[] }>;

export type StudioFlowPropertyField = Readonly<{
  key: string;
  label: string;
  required: boolean;
  control: StudioFlowPropertyControl;
  /** The value type a value control expects; undefined accepts any. */
  valueType: string | undefined;
  keyType?: "builder_key" | "namespaced_key";
  /** For a name-value map: the names this setting expects here, such as a page's parameters. */
  entries?: readonly StudioFlowNamedEntry[];
  /** For field values: the fields of the step's record type. */
  fields?: readonly StudioFlowRecordField[];
  /** For a field: the fields it can name, each stored as `<record type>.<field>`. */
  options?: readonly Readonly<{ value: string; label: string }>[];
  help?: string;
}>;

export type StudioFlowPropertyDraft =
  | Readonly<{ kind: "value"; source: StudioFlowValueSource }>
  /** A fixed text: a key, or a pointer at a part of the draft (a record type, a page, a form…). */
  | Readonly<{ kind: "text"; value: string }>
  | Readonly<{ kind: "calculation"; calculation: StudioFlowCalculation }>
  | Readonly<{ kind: "whole"; source: StudioFlowValueSource }>
  | Readonly<{ kind: "fields"; entries: readonly Readonly<{ field: string; source: StudioFlowValueSource }>[] }>
  | Readonly<{ kind: "map"; entries: readonly Readonly<{ name: string; source: StudioFlowValueSource }>[] }>
  /** A stored value the form shows but does not rebuild (a formula, a nested map); kept until replaced. */
  | Readonly<{ kind: "kept"; value: FlowValue }>;

export type StudioFlowControlDraft =
  | Readonly<{ kind: "if"; condition: FlowFormula }>
  | Readonly<{ kind: "stop"; outcome: string }>
  | Readonly<{ kind: "run_flow"; flow: string; inputs: readonly Readonly<{ name: string; source: StudioFlowValueSource }>[] }>
  | Readonly<{ kind: "for_each"; items: StudioFlowValueSource; maximumItems: number }>
  | Readonly<{ kind: "switch"; value: StudioFlowValueSource; cases: readonly Readonly<{ key: string; when: FlowLiteral }>[] }>
  | Readonly<{ kind: "wait_until"; until: StudioFlowValueSource }>
  | Readonly<{ kind: "wait_for_person"; form: string; assignee: StudioFlowValueSource;
      inputs: readonly Readonly<{ name: string; source: StudioFlowValueSource }>[] }>
  | Readonly<{ kind: "none" }>;

/** The whole edited form of one step: its description, its settings and, for a control step, its shape. */
export type StudioFlowStepDraft = Readonly<{
  description: string;
  properties: Readonly<Record<string, StudioFlowPropertyDraft | null>>;
  control: StudioFlowControlDraft | null;
}>;

export type StudioFlowStepForm =
  | Readonly<{ kind: "available"; fields: readonly StudioFlowPropertyField[]; draft: StudioFlowStepDraft;
      /** For a control step: what it can point at (other flows, forms). */
      controlEntries?: readonly StudioFlowNamedEntry[];
      calculationReferences: readonly StudioFlowCalculationReference[] }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

const propertyLabels: Readonly<Record<string, string>> = {
  record_type: "Record type", record: "Record to change", values: "Field values", selected_owner_group_id: "Owner group",
  action_inputs: "Inputs of the action it runs", page: "Page", parameters: "Page parameters", operation: "Operation",
  inputs: "Inputs", form: "Form", message: "Message", tone: "Tone", title: "Title", component: "Component",
  query: "Query", flow: "Flow", formula: "Calculation", variable: "Variable", value: "Value", field: "Field",
  details: "What it covers (list of lines)", choice: "Opt-in that goes with a yes", confirm_label: "Confirm button",
};

const controlFor = (type: FlowTaskPropertyType): StudioFlowPropertyControl | undefined => {
  switch (type) {
    case "message_text": return "message";
    case "builder_key": case "namespaced_key": return "key";
    case "record_type_id": return "record_type";
    case "page_id": return "page";
    case "form_id": return "form";
    case "query_id": return "query";
    case "flow_id": return "flow";
    case "protected_operation_key": return "operation";
    case "connection_binding_id": return "connection";
    case "field_id": return "field";
    case "relationship_id": return "relationship";
    case "formula": return "calculation";
    case "field_values": return "field_values";
    case "input_map": return "input_map";
    case "any_value": case "record_change_list": return "value";
    default: return "value";
  }
};

const literalText = (value: FlowValue | undefined): string | undefined =>
  value?.kind === "literal" && typeof value.literal.value === "string" ? value.literal.value : undefined;

const mapEntries = (value: FlowValue): readonly Readonly<{ name: string; source: StudioFlowValueSource }>[] | undefined =>
  value.kind === "map" ? Object.entries(value.entries).map(([name, entry]) => ({ name, source: studioFlowValueSourceOf(entry) })) : undefined;

const recordFields = (source: Readonly<ApplicationSourceDocument>, reference: string | undefined, moduleKey: string | null):
  StudioFlowRecordField[] | undefined => {
  if (reference === undefined) return undefined;
  const found = studioDraftRecordType(source, reference, moduleKey);
  return found?.record.fields.map((field) => ({ key: field.key, label: field.label, type: field.type,
    valueType: studioFieldValueType(field.type), required: field.required,
    options: field.type === "choice" ? ((field.settings as { options?: { value: string; label: string }[] }).options ?? [])
      .map((option) => ({ value: option.value, label: option.label })) : [] }));
};

/** The record type a step's field values are written against: its own, or the record that started a save rule. */
const stepRecordType = (flow: SourceFlow, properties: Readonly<Record<string, FlowValue>>): string | undefined =>
  literalText(properties.record_type) ?? (flow.execution === "transaction"
    ? (flow.triggers ?? []).flatMap((trigger) => "recordTypeId" in trigger ? [trigger.recordTypeId] : [])[0] : undefined);

/** The fields a field setting can name: of the step's record type, or of the record the flow runs for. */
export const studioFlowFieldOptions = (source: Readonly<ApplicationSourceDocument>, flow: SourceFlow, moduleKey: string | null,
  properties: Readonly<Record<string, FlowValue>>): readonly Readonly<{ value: string; label: string }>[] | undefined => {
  const recordType = stepRecordType(flow, properties) ?? (flow.triggers ?? []).flatMap((trigger) =>
    "recordTypeId" in trigger ? [trigger.recordTypeId] : [])[0] ??
    (flow.recordInput === undefined ? undefined : flow.inputs?.[flow.recordInput]?.recordTypeIds?.[0]);
  return recordFields(source, recordType, moduleKey)?.map((field) => ({ value: `${recordType}.${field.key}`, label: field.label }));
};

/** The named action whose choice option a Save record step saves, when it saves exactly one owned option. */
const ownedOptionAction = (choices: StudioFlowDraftChoices, source: Readonly<ApplicationSourceDocument>,
  properties: Readonly<Record<string, FlowValue>>) => {
  const recordType = literalText(properties.record_type);
  const values = properties.values;
  const entries = values?.kind === "map" ? Object.entries(values.entries) : [];
  if (recordType === undefined || entries.length !== 1) return undefined;
  const [field, value] = entries[0]!;
  const option = literalText(value);
  const found = studioDraftRecordType(source, recordType, null);
  const action = found?.module.actions.find((candidate) => candidate.record_type === found.record.key &&
    candidate.sets_choice_field === field && candidate.sets_choice_option === option);
  return action === undefined ? undefined : choices.actions.find((candidate) => candidate.key === action.key);
};

/** The names an input map expects here, from what the step points at. */
const expectedEntries = (task: Extract<SourceFlowTask, { properties: unknown }>, key: string,
  choices: StudioFlowDraftChoices, source: Readonly<ApplicationSourceDocument>): readonly StudioFlowNamedEntry[] | undefined => {
  const properties = task.properties;
  if (task.type === "interface.navigate" && key === "parameters") {
    const page = choices.pages.find((candidate) => candidate.key === literalText(properties.page));
    return page?.recordType === null || page === undefined ? undefined
      : [{ name: "record_id", label: "Record to open", type: "record_reference", required: true }];
  }
  if (task.type === "operation.call" && key === "inputs")
    return choices.actions.find((candidate) => candidate.key === literalText(properties.operation))?.inputs;
  if (task.type === "interface.show_form" && key === "inputs")
    return choices.forms.find((candidate) => candidate.alias === literalText(properties.form))?.fields;
  if (task.type === "record.save" && key === "action_inputs") return ownedOptionAction(choices, source, properties)?.inputs;
  return undefined;
};

const help: Readonly<Record<string, string>> = {
  "record.save record": "Leave it unset to create a new record. Set it to the record the page shows, or one an earlier step saved, to change that record.",
  "record.save values": "All the answers of a form, or the fields one by one: each from a fixed value, an input or an earlier step.",
  "record.save action_inputs": "Saving an option that a named action owns runs that action; give the inputs it asks for.",
  "interface.navigate parameters": "A record page opens the record you name here.",
};

const propertyDraft = (type: FlowTaskPropertyType, value: FlowValue): StudioFlowPropertyDraft => {
  const control = controlFor(type);
  switch (control) {
    case "key": case "record_type": case "page": case "form": case "query": case "flow": case "operation":
    case "connection": case "field": case "relationship": {
      const text = literalText(value);
      return text === undefined ? { kind: "kept", value } : { kind: "text", value: text };
    }
    case "calculation": {
      const calculation = formulaCalculation(value);
      return calculation === undefined ? { kind: "kept", value } : { kind: "calculation", calculation };
    }
    case "field_values": {
      const entries = mapEntries(value);
      if (entries !== undefined) return { kind: "fields", entries: entries.map((entry) => ({ field: entry.name, source: entry.source })) };
      return value.kind === "reference" ? { kind: "whole", source: studioFlowValueSourceOf(value) } : { kind: "kept", value };
    }
    case "input_map": {
      const entries = mapEntries(value);
      return entries === undefined ? { kind: "kept", value } : { kind: "map", entries };
    }
    default:
      return { kind: "value", source: studioFlowValueSourceOf(value) };
  }
};

const controlDraft = (task: SourceFlowTask): StudioFlowControlDraft | null | undefined => {
  if ("properties" in task) return null;
  const entries = (inputs: Readonly<Record<string, FlowValue>>) =>
    Object.entries(inputs).map(([name, value]) => ({ name, source: studioFlowValueSourceOf(value) }));
  switch (task.type) {
    case "if": return "condition" in task ? { kind: "if", condition: task.condition } : undefined;
    case "stop": return "outcome" in task ? { kind: "stop", outcome: task.outcome } : undefined;
    case "run_flow": return "flowId" in task ? { kind: "run_flow", flow: task.flowId, inputs: entries(task.inputs) } : undefined;
    case "for_each": return "items" in task ? { kind: "for_each", items: studioFlowValueSourceOf(task.items), maximumItems: task.maximumItems } : undefined;
    case "switch": return "cases" in task ? { kind: "switch", value: studioFlowValueSourceOf(task.value),
      cases: task.cases.map((entry) => ({ key: entry.key, when: entry.when })) } : undefined;
    case "wait_until": return "until" in task ? { kind: "wait_until", until: studioFlowValueSourceOf(task.until) } : undefined;
    case "wait_for_person": return "formId" in task ? { kind: "wait_for_person", form: task.formId,
      assignee: studioFlowValueSourceOf(task.assignee), inputs: entries(task.inputs) } : undefined;
    case "sequential": case "parallel": return { kind: "none" };
    default: return undefined;
  }
};

/** The form of one step, or why it has none, named by where the step is. */
export const projectStudioFlowStepForm = (
  source: Readonly<ApplicationSourceDocument>,
  flow: SourceFlow,
  siblings: readonly SourceFlow[],
  moduleKey: string | null,
  task: SourceFlowTask,
  path: StudioFlowPath,
  choices: StudioFlowDraftChoices,
): StudioFlowStepForm => {
  const where = describeStudioFlowLocation(flow, path);
  const description = task.description ?? "";
  const references = calculationReferences(flow);
  if (!("properties" in task)) {
    const control = controlDraft(task);
    if (control === undefined || control === null)
      return { kind: "unavailable", reason: `${where}: Studio does not know this kind of step (${task.type}), so it cannot be edited. Remove it or replace it with a known step.` };
    const controlEntries = control.kind === "run_flow"
      ? Object.entries(siblings.find((candidate) => candidate.id === control.flow || candidate.key === control.flow)?.inputs ?? {})
        .map(([name, declaration]) => ({ name, label: studioWords(name), type: declaration.type, required: declaration.required }))
      : control.kind === "wait_for_person" ? choices.forms.find((form) => form.alias === control.form)?.fields : undefined;
    return { kind: "available", fields: [], draft: { description, properties: {}, control },
      ...(controlEntries === undefined ? {} : { controlEntries }), calculationReferences: references };
  }
  const definition = studioFlowDefinitionOf(task.type, task.version);
  if (definition === undefined)
    return { kind: "unavailable", reason: `${where}: the ${studioWords(task.type)} step (version ${task.version}) is not in the step catalogue, so it cannot be edited. Remove it or replace it with a known step.` };
  const unknown = Object.keys(task.properties).find((key) => !Object.hasOwn(definition.properties, key));
  if (unknown !== undefined)
    return { kind: "unavailable", reason: `${where}, ${studioWords(unknown)}: the step catalogue does not declare this setting, so the step cannot be edited. Remove the step or replace it.` };
  const recordType = stepRecordType(flow, task.properties);
  const fields = Object.entries(definition.properties).map(([key, declaration]): StudioFlowPropertyField => {
    const control = task.type === "event.announce" && key === "event" ? "field" : controlFor(declaration.type)!;
    const entries = control === "input_map" ? expectedEntries(task, key, choices, source) : undefined;
    const recordFieldList = control === "field_values" ? recordFields(source, recordType, moduleKey) : undefined;
    const options = task.type === "event.announce" && key === "event"
      ? studioFlowEventChoices(source, flow, moduleKey, task.properties.record)
      : control === "field" ? studioFlowFieldOptions(source, flow, moduleKey, task.properties) : undefined;
    const valueType = control === "value" && declaration.type === "record_change_list" ? "json"
      : control === "value" && declaration.type !== "any_value"
      ? declaration.type : control === "message" ? "text" : undefined;
    const hint = help[`${task.type} ${key}`];
    return { key, label: propertyLabels[key] ?? studioWords(key), required: declaration.required, control, valueType,
      ...(declaration.type === "builder_key" || declaration.type === "namespaced_key" ? { keyType: declaration.type } : {}),
      ...(entries === undefined ? {} : { entries }), ...(recordFieldList === undefined ? {} : { fields: recordFieldList }),
      ...(options === undefined ? {} : { options }), ...(hint === undefined ? {} : { help: hint }) };
  });
  const properties = Object.fromEntries(Object.entries(definition.properties).map(([key, declaration]) => [key,
    Object.hasOwn(task.properties, key) ? propertyDraft(declaration.type, task.properties[key]!) : null]));
  return { kind: "available", fields, draft: { description, properties, control: null }, calculationReferences: references };
};

// ─── Back to the stored task ─────────────────────────────────────────────────────────────────

type Refused = Readonly<{ ok: false; reason: string }>;
type Built<T> = Readonly<{ ok: true; value: T }> | Refused;

const entryMap = (entries: readonly Readonly<{ name: string; source: StudioFlowValueSource }>[], label: string): Built<Record<string, FlowValue>> => {
  const map: Record<string, FlowValue> = {};
  for (const entry of entries) {
    if (!builderKeySchema.safeParse(entry.name).success)
      return { ok: false, reason: `${label}: name each entry with lowercase words joined by underscores, such as record_id.` };
    if (Object.hasOwn(map, entry.name)) return { ok: false, reason: `${label}: ${studioWords(entry.name)} is given twice. Give each entry once.` };
    map[entry.name] = studioFlowValueOf(entry.source);
  }
  return { ok: true, value: map };
};

const propertyValue = (flow: SourceFlow, field: StudioFlowPropertyField, draft: StudioFlowPropertyDraft, label: string,
  recordFieldKeys: ReadonlySet<string> | undefined): Built<FlowValue> => {
  switch (draft.kind) {
    case "kept": return { ok: true, value: draft.value };
    case "value": case "whole": return { ok: true, value: studioFlowValueOf(draft.source) };
    case "calculation": return calculationFormula(flow, draft.calculation, label);
    case "text": {
      const text = draft.value.trim();
      if (text.length === 0) return { ok: false, reason: `${label}: choose a value, or leave the setting unset if it is optional.` };
      if (field.keyType !== undefined) {
        const problem = studioKeyProblem(field.keyType, text, label);
        if (problem !== undefined) return { ok: false, reason: problem };
      }
      return { ok: true, value: { kind: "literal", literal: { type: "text", value: text } } };
    }
    case "fields": {
      const map: Record<string, FlowValue> = {};
      for (const entry of draft.entries) {
        if (recordFieldKeys !== undefined && !recordFieldKeys.has(entry.field))
          return { ok: false, reason: `${label}: the record type has no field ${studioWords(entry.field)}. Choose one of its fields.` };
        if (Object.hasOwn(map, entry.field)) return { ok: false, reason: `${label}: ${studioWords(entry.field)} is set twice. Set each field once.` };
        map[entry.field] = studioFlowValueOf(entry.source);
      }
      return { ok: true, value: { kind: "map", entries: map } };
    }
    case "map": {
      const built = entryMap(draft.entries, label);
      return built.ok ? { ok: true, value: { kind: "map", entries: built.value } } : built;
    }
  }
};

const valueOrKept = (source: StudioFlowValueSource): FlowValue => studioFlowValueOf(source);

/**
 * The stored task a step draft writes: every declared setting from its control, the description,
 * and a control step's own shape. Child step lists and policies are kept as they are.
 */
export const applyStudioFlowStepDraft = (
  source: Readonly<ApplicationSourceDocument>,
  flow: SourceFlow,
  moduleKey: string | null,
  task: SourceFlowTask,
  path: StudioFlowPath,
  draft: StudioFlowStepDraft,
): Built<SourceFlowTask> => {
  const where = describeStudioFlowLocation(flow, path);
  const description = draft.description.trim();
  if (description.length > 1_000) return { ok: false, reason: `${where}, Description: use at most 1000 characters.` };
  const base = { ...task } as SourceFlowTask & { description?: string };
  if (description.length === 0) delete base.description; else base.description = description;
  if (!("properties" in task)) {
    const control = draft.control;
    if (control === null || control.kind !== (task.type === "sequential" || task.type === "parallel" ? "none" : task.type))
      return { ok: false, reason: `${where}: this step changed kind. Select it again.` };
    const next = base as Record<string, unknown>;
    switch (control.kind) {
      case "if":
        if (!flowFormulaSchema.safeParse(control.condition).success) return { ok: false, reason: `${where}, Condition: this condition is not valid.` };
        next.condition = control.condition; break;
      case "stop": {
        const problem = studioKeyProblem("builder_key", control.outcome, `${where}, Outcome`);
        if (problem !== undefined) return { ok: false, reason: problem };
        next.outcome = control.outcome; break;
      }
      case "run_flow": {
        const inputs = entryMap(control.inputs, `${where}, Inputs`);
        if (!inputs.ok) return inputs;
        next.flowId = control.flow; next.inputs = inputs.value; break;
      }
      case "for_each":
        if (!Number.isSafeInteger(control.maximumItems) || control.maximumItems < 1)
          return { ok: false, reason: `${where}, Most items: enter a whole number of at least 1.` };
        next.items = valueOrKept(control.items); next.maximumItems = control.maximumItems; break;
      case "switch": {
        const keys = new Set<string>();
        for (const entry of control.cases) {
          const problem = studioKeyProblem("builder_key", entry.key, `${where}, Case name`);
          if (problem !== undefined) return { ok: false, reason: problem };
          if (keys.has(entry.key)) return { ok: false, reason: `${where}: two cases are called ${studioWords(entry.key)}. Name each case once.` };
          keys.add(entry.key);
        }
        const cases = (task as Extract<SourceFlowTask, { type: "switch" }>).cases;
        if (cases.length !== control.cases.length) return { ok: false, reason: `${where}: the cases changed. Select the step again.` };
        next.value = valueOrKept(control.value);
        next.cases = cases.map((entry, index) => ({ ...entry, key: control.cases[index]!.key, when: control.cases[index]!.when }));
        break;
      }
      case "wait_until": next.until = valueOrKept(control.until); break;
      case "wait_for_person": {
        const inputs = entryMap(control.inputs, `${where}, Inputs`);
        if (!inputs.ok) return inputs;
        next.formId = control.form; next.assignee = valueOrKept(control.assignee); next.inputs = inputs.value; break;
      }
      case "none": break;
    }
    return { ok: true, value: next as SourceFlowTask };
  }
  const definition = studioFlowDefinitionOf(task.type, task.version);
  if (definition === undefined) return { ok: false, reason: `${where}: this kind of step is not in the step catalogue, so it cannot be changed.` };
  const recordType = stepRecordType(flow, Object.fromEntries(Object.entries(draft.properties).flatMap(([key, value]) =>
    key === "record_type" && value?.kind === "text" ? [[key, { kind: "literal", literal: { type: "text", value: value.value } } as FlowValue]] : [])))
    ?? stepRecordType(flow, task.properties);
  const recordFieldKeys = recordType === undefined ? undefined
    : new Set(studioDraftRecordType(source, recordType, moduleKey)?.record.fields.map((field) => field.key) ?? []);
  const properties: Record<string, FlowValue> = {};
  for (const [key, declaration] of Object.entries(definition.properties)) {
    const label = `${where}, ${propertyLabels[key] ?? studioWords(key)}`;
    const value = Object.hasOwn(draft.properties, key) ? draft.properties[key]! : undefined;
    if (value === null || value === undefined) {
      if (declaration.required) return { ok: false, reason: `${label} is required. Give it a value.` };
      continue;
    }
    const field: StudioFlowPropertyField = { key, label, required: declaration.required, control: controlFor(declaration.type)!,
      valueType: undefined, ...(declaration.type === "builder_key" || declaration.type === "namespaced_key" ? { keyType: declaration.type } : {}) };
    const built = propertyValue(flow, field, value, label, recordFieldKeys);
    if (!built.ok) return built;
    properties[key] = built.value;
  }
  for (const key of Object.keys(draft.properties))
    if (!Object.hasOwn(definition.properties, key))
      return { ok: false, reason: `${where}, ${studioWords(key)}: the step catalogue does not declare this setting.` };
  return { ok: true, value: { ...base, properties } as SourceFlowTask };
};

/**
 * The form's fields as the draft now stands: the fields a mapping offers follow the record type
 * chosen, and the names a map expects follow the page, action or form chosen, before Apply.
 */
export const refreshStudioFlowStepFields = (
  source: Readonly<ApplicationSourceDocument>,
  flow: SourceFlow,
  moduleKey: string | null,
  task: SourceFlowTask,
  draft: StudioFlowStepDraft,
  choices: StudioFlowDraftChoices,
  fields: readonly StudioFlowPropertyField[],
): readonly StudioFlowPropertyField[] => {
  if (!("properties" in task)) return fields;
  const properties: Record<string, FlowValue> = { ...task.properties };
  for (const [key, value] of Object.entries(draft.properties)) {
    if (value === null) delete properties[key];
    else if (value.kind === "text") properties[key] = { kind: "literal", literal: { type: "text", value: value.value } };
    else if (value.kind === "fields") properties[key] = { kind: "map", entries: Object.fromEntries(value.entries.map((entry) =>
      [entry.field, studioFlowValueOf(entry.source)])) };
  }
  const current = { ...task, properties };
  const recordType = stepRecordType(flow, properties);
  return fields.map((field): StudioFlowPropertyField => {
    if (field.control === "field_values") return { ...field, fields: recordFields(source, recordType, moduleKey) ?? [] };
    if (field.control !== "input_map") return field;
    const entries = expectedEntries(current, field.key, choices, source);
    if (entries !== undefined) return { ...field, entries };
    const rest: { -readonly [K in keyof StudioFlowPropertyField]?: StudioFlowPropertyField[K] } = { ...field };
    delete rest.entries;
    return rest as StudioFlowPropertyField;
  });
};
