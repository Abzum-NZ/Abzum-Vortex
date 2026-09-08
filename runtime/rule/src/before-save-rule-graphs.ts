import {
  recordLinkValueV2Schema,
  ruleGraphTypedValueSchema,
  type JsonValue,
  type ModuleDefinitionConsumerReadResultV3,
  type ModuleFieldV2,
  type RuleGraph,
  type RuleGraphInputDeclaration,
  type RuleGraphOperand,
  type RuleGraphValueType,
  type RuleGraphVariableDeclaration,
} from "@vortex/contracts";
import { codePointCompare, exactJsonEqual } from "./typed-condition-core";
import {
  evaluateResolvedTypedConditionV2,
  semanticTypeForFieldV2,
  valueMatchesFieldV2,
  type ResolvedTypedConditionOperandV2,
  type SemanticTypeV2,
} from "./typed-condition-v2-semantics";

export const beforeSaveRuleGraphEvaluationErrorReasons = [
  "input_refused",
  "graph_refused",
] as const;

export type BeforeSaveRuleGraphEvaluationErrorReason =
  (typeof beforeSaveRuleGraphEvaluationErrorReasons)[number];

export class BeforeSaveRuleGraphEvaluationError extends Error {
  constructor(readonly reason: BeforeSaveRuleGraphEvaluationErrorReason) {
    super(`vortex.rule.before_save_graph_${reason}`);
    this.name = "BeforeSaveRuleGraphEvaluationError";
  }
}

export type BeforeSaveRuleRequirement = Readonly<{
  fieldId: string;
  code: string;
  message: string;
}>;

export type BeforeSaveRuleWarning = Readonly<{
  code: string;
  message: string;
}>;

export type BeforeSaveRuleRefusal = Readonly<{
  code: string;
  message: string;
  fieldId?: string;
}>;

type BeforeSaveRuleGraphEvaluationInputBase = Readonly<{
  release: ModuleDefinitionConsumerReadResultV3;
  subjectRecordTypeId: string;
  initialCandidateValues: Readonly<Record<string, JsonValue>>;
  inputValuesByRuleId?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}>;

export type EvaluateBeforeSaveRuleGraphsInput =
  | (BeforeSaveRuleGraphEvaluationInputBase &
      Readonly<{ operation: "create"; previousValues?: never }>)
  | (BeforeSaveRuleGraphEvaluationInputBase &
      Readonly<{
        operation: "update";
        previousValues: Readonly<Record<string, JsonValue>>;
      }>);

export type EvaluateBeforeSaveRuleGraphsResult =
  | Readonly<{
      success: true;
      setValues: Readonly<Record<string, JsonValue>>;
      clearFieldIds: readonly string[];
      requirements: readonly BeforeSaveRuleRequirement[];
      warnings: readonly BeforeSaveRuleWarning[];
    }>
  | Readonly<{
      success: false;
      refusal: BeforeSaveRuleRefusal;
      warnings: readonly BeforeSaveRuleWarning[];
    }>;

type GraphDeclaration = RuleGraphInputDeclaration | RuleGraphVariableDeclaration;
type ResolvedGraphOperand = ResolvedTypedConditionOperandV2 & Readonly<{ missing: boolean }>;

const refuse = (reason: BeforeSaveRuleGraphEvaluationErrorReason): never => {
  throw new BeforeSaveRuleGraphEvaluationError(reason);
};

const hasOwn = (value: Readonly<Record<string, unknown>>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const clone = <Value extends JsonValue>(value: Value): Value => structuredClone(value);

const semanticTypeForGraphValue = (type: RuleGraphValueType): SemanticTypeV2 => {
  switch (type) {
    case "whole_number":
      return "whole_number";
    case "decimal_number":
      return "decimal_number";
    case "money":
      return "money";
    case "yes_no":
      return "boolean";
    case "date":
      return "date";
    case "date_time":
      return "date_time";
    case "several_choices":
      return "text_collection";
    case "formatted_text":
    case "table":
    case "attachment":
      return "opaque_json";
    case "link":
    case "link_to_one_of_several":
      return "record_reference";
    case "link_to_person":
      return "organization_account_reference";
    default:
      return "text";
  }
};

const valueMatchesDeclaration = (
  value: unknown,
  declaration: GraphDeclaration,
): value is JsonValue => {
  const parsed = ruleGraphTypedValueSchema.safeParse({
    type: declaration.type,
    value,
    ...(declaration.columns === undefined ? {} : { columns: declaration.columns }),
  });
  if (!parsed.success) return false;
  if (declaration.recordTypeIds === undefined) return true;
  const link = recordLinkValueV2Schema.safeParse(value);
  return link.success && declaration.recordTypeIds.includes(link.data.recordTypeId);
};

const validateFieldMap = (
  values: Readonly<Record<string, JsonValue>>,
  fieldsById: ReadonlyMap<string, ModuleFieldV2>,
): Map<string, JsonValue> => {
  if (!isRecord(values)) refuse("input_refused");
  const validated = new Map<string, JsonValue>();
  for (const [fieldId, value] of Object.entries(values)) {
    const field = fieldsById.get(fieldId);
    if (field === undefined || value === null || !valueMatchesFieldV2(value, field))
      refuse("input_refused");
    validated.set(fieldId, clone(value));
  }
  return validated;
};

const outgoingEdge = (graph: RuleGraph, nodeId: string, port: "next" | "true" | "false") =>
  graph.edges.find((edge) => edge.fromNodeId === nodeId && edge.port === port)?.toNodeId;

const graphInputs = (
  graph: RuleGraph,
  supplied: Readonly<Record<string, unknown>> | undefined,
): Map<string, JsonValue> => {
  const raw = supplied ?? {};
  if (!isRecord(raw)) refuse("input_refused");
  const declarations = new Map<string, RuleGraphInputDeclaration>(
    graph.inputs.map((entry) => [entry.inputId, entry]),
  );
  if (Object.keys(raw).some((inputId) => !declarations.has(inputId))) refuse("input_refused");
  const values = new Map<string, JsonValue>();
  for (const declaration of graph.inputs) {
    if (!hasOwn(raw, declaration.inputId)) {
      if (declaration.required) refuse("input_refused");
      continue;
    }
    const value = raw[declaration.inputId];
    const parsedValue = valueMatchesDeclaration(value, declaration)
      ? value
      : refuse("input_refused");
    values.set(declaration.inputId, clone(parsedValue));
  }
  return values;
};

const graphVariables = (graph: RuleGraph): Map<string, JsonValue> => {
  const values = new Map<string, JsonValue>();
  for (const declaration of graph.variables)
    if (declaration.defaultValue !== undefined)
      values.set(declaration.variableId, clone(declaration.defaultValue.value));
  return values;
};

const resolved = (
  type: SemanticTypeV2,
  value: JsonValue | undefined,
  missing: boolean,
  literal = false,
): ResolvedGraphOperand => ({
  type,
  value: value ?? null,
  missing,
  ...(literal ? { literal: value ?? null } : {}),
});

const resolveOperand = (
  operand: RuleGraphOperand,
  graph: RuleGraph,
  fieldsById: ReadonlyMap<string, ModuleFieldV2>,
  candidate: ReadonlyMap<string, JsonValue>,
  previous: ReadonlyMap<string, JsonValue> | undefined,
  inputs: ReadonlyMap<string, JsonValue>,
  variables: ReadonlyMap<string, JsonValue>,
): ResolvedGraphOperand => {
  if (operand.source === "literal")
    return resolved(
      semanticTypeForGraphValue(operand.value.type),
      clone(operand.value.value),
      false,
      true,
    );

  if (operand.source === "input") {
    const declaration = graph.inputs.find((entry) => entry.inputId === operand.inputId);
    if (declaration === undefined) return refuse("graph_refused");
    return resolved(
      semanticTypeForGraphValue(declaration.type),
      inputs.get(operand.inputId),
      !inputs.has(operand.inputId),
    );
  }

  if (operand.source === "variable") {
    const declaration = graph.variables.find((entry) => entry.variableId === operand.variableId);
    if (declaration === undefined) return refuse("graph_refused");
    return resolved(
      semanticTypeForGraphValue(declaration.type),
      variables.get(operand.variableId),
      !variables.has(operand.variableId),
    );
  }

  const field = fieldsById.get(operand.fieldId);
  if (field === undefined) return refuse("graph_refused");
  const values = operand.source === "current_field" ? candidate : previous;
  return resolved(
    semanticTypeForFieldV2(field),
    values?.get(operand.fieldId),
    values === undefined || !values.has(operand.fieldId),
  );
};

/**
 * Evaluates exact published before-save graphs without performing persistence or final field policy.
 * Requirements are declarations for Record to check after owning generators have produced the final candidate.
 */
export const evaluateBeforeSaveRuleGraphs = (
  input: EvaluateBeforeSaveRuleGraphsInput,
): EvaluateBeforeSaveRuleGraphsResult => {
  if (
    (input.operation !== "create" && input.operation !== "update") ||
    (input.operation === "create" && hasOwn(input, "previousValues"))
  )
    return refuse("input_refused");
  const release = input.release;
  const recordType = release.content.recordTypes.find(
    (entry) => entry.recordTypeId === input.subjectRecordTypeId,
  );
  if (recordType === undefined) return refuse("input_refused");
  const fieldsById = new Map(recordType.fields.map((field) => [field.fieldId, field]));
  const initial = validateFieldMap(input.initialCandidateValues, fieldsById);
  const candidate = new Map(initial);
  const previous =
    input.operation === "update" ? validateFieldMap(input.previousValues, fieldsById) : undefined;
  const suppliedByRule = input.inputValuesByRuleId ?? {};
  if (!isRecord(suppliedByRule)) return refuse("input_refused");

  const applicableGraphs = release.content.rules
    .filter(
      (graph) =>
        graph.subjectRecordTypeId === input.subjectRecordTypeId &&
        graph.nodes.some(
          (node) => node.type === "start" && node.operations.includes(input.operation),
        ),
    )
    .sort(
      (left, right) =>
        left.priority - right.priority || codePointCompare(left.ruleId, right.ruleId),
    );
  const applicableIds = new Set<string>(applicableGraphs.map((graph) => graph.ruleId));
  if (Object.keys(suppliedByRule).some((ruleId) => !applicableIds.has(ruleId)))
    return refuse("input_refused");

  const requirements: BeforeSaveRuleRequirement[] = [];
  const warnings: BeforeSaveRuleWarning[] = [];

  for (const graph of applicableGraphs) {
    const inputs = graphInputs(graph, suppliedByRule[graph.ruleId]);
    const variables = graphVariables(graph);
    const nodesById = new Map<string, RuleGraph["nodes"][number]>(
      graph.nodes.map((node) => [node.nodeId, node]),
    );
    const starts = graph.nodes.filter(
      (node) => node.type === "start" && node.operations.includes(input.operation),
    );
    if (starts.length !== 1) return refuse("graph_refused");
    let nextNodeId: string | undefined = starts[0]!.nodeId;
    const visited = new Set<string>();

    while (nextNodeId !== undefined) {
      if (visited.has(nextNodeId)) return refuse("graph_refused");
      visited.add(nextNodeId);
      const node = nodesById.get(nextNodeId);
      if (node === undefined) return refuse("graph_refused");

      if (node.type === "start") {
        nextNodeId = outgoingEdge(graph, node.nodeId, "next");
        continue;
      }
      if (node.type === "condition") {
        const outcome = evaluateResolvedTypedConditionV2(node.condition, (operand) =>
          resolveOperand(operand, graph, fieldsById, candidate, previous, inputs, variables),
        );
        nextNodeId = outgoingEdge(graph, node.nodeId, outcome ? "true" : "false");
        continue;
      }
      if (node.type === "set_variable") {
        const declaration = graph.variables.find((entry) => entry.variableId === node.variableId);
        if (declaration === undefined) return refuse("graph_refused");
        const value = resolveOperand(
          node.value,
          graph,
          fieldsById,
          candidate,
          previous,
          inputs,
          variables,
        );
        if (value.missing || !valueMatchesDeclaration(value.value, declaration))
          return refuse("input_refused");
        variables.set(node.variableId, clone(value.value));
        nextNodeId = outgoingEdge(graph, node.nodeId, "next");
        continue;
      }
      if (node.type === "set_field") {
        if (!fieldsById.has(node.fieldId)) return refuse("graph_refused");
        if (node.assignment.kind === "clear") candidate.delete(node.fieldId);
        else {
          const value = resolveOperand(
            node.assignment.value,
            graph,
            fieldsById,
            candidate,
            previous,
            inputs,
            variables,
          );
          if (value.missing) return refuse("input_refused");
          candidate.set(node.fieldId, clone(value.value));
        }
        nextNodeId = outgoingEdge(graph, node.nodeId, "next");
        continue;
      }
      if (node.type === "require_field") {
        requirements.push({ fieldId: node.fieldId, code: node.code, message: node.message });
        nextNodeId = outgoingEdge(graph, node.nodeId, "next");
        continue;
      }
      if (node.type === "warn") {
        warnings.push({ code: node.code, message: node.message });
        nextNodeId = outgoingEdge(graph, node.nodeId, "next");
        continue;
      }
      if (node.type === "refuse")
        return {
          success: false,
          refusal: {
            code: node.code,
            message: node.message,
            ...(node.fieldId === undefined ? {} : { fieldId: node.fieldId }),
          },
          warnings,
        };
      nextNodeId = undefined;
    }
  }

  const setValues = Object.fromEntries(
    [...candidate.entries()]
      .filter(([fieldId, value]) => {
        const initialValue = initial.get(fieldId);
        return initialValue === undefined || !exactJsonEqual(value, initialValue);
      })
      .sort(([left], [right]) => codePointCompare(left, right))
      .map(([fieldId, value]) => [fieldId, clone(value)]),
  );
  const clearFieldIds = [...initial.keys()]
    .filter((fieldId) => !candidate.has(fieldId))
    .sort(codePointCompare);

  return { success: true, setValues, clearFieldIds, requirements, warnings };
};
