import {
  moduleFieldValueV2Schemas,
  ruleGraphSchema,
  type DefinitionRuleFailureFamily,
  type ModuleFieldV2,
  type RecordTypeDefinitionV2,
  type RuleGraph,
  type RuleGraphCondition,
  type RuleGraphOperand,
  type RuleTableColumn,
  type RuleGraphTypedValue,
  type RuleGraphValueType,
} from "@vortex/contracts";

export const ruleGraphValidationCodes = Object.freeze({
  topology: "vortex.definition.rule_graph_topology",
  references: "vortex.definition.rule_graph_references",
  valueTypes: "vortex.definition.rule_graph_value_types",
  variableAvailability: "vortex.definition.rule_graph_variable_availability",
} as const);

export type RuleGraphValidationCode =
  (typeof ruleGraphValidationCodes)[keyof typeof ruleGraphValidationCodes];

export type RuleGraphValidationIssue = Readonly<{
  ruleCode: RuleGraphValidationCode;
  family: DefinitionRuleFailureFamily;
  /** Canonical path relative to the graph root. */
  path: readonly (string | number)[];
}>;

export type RuleGraphValidationInput = Readonly<{
  graph: RuleGraph;
  subjectRecordType: RecordTypeDefinitionV2;
  /** Subject and exact dependency record types available to this published Module. */
  availableRecordTypeIds: ReadonlySet<string>;
}>;

type ValueDeclaration = Readonly<{
  type: RuleGraphValueType | "reference_number";
  recordTypeIds?: readonly string[] | undefined;
  columns?: readonly RuleTableColumn[] | undefined;
  field?: ModuleFieldV2 | undefined;
}>;

type Availability = ReadonlySet<string>;

const inputAvailability = (inputId: string) => `input:${inputId}`;
const variableAvailability = (variableId: string) => `variable:${variableId}`;

const issue = (
  ruleCode: RuleGraphValidationCode,
  family: DefinitionRuleFailureFamily,
  path: readonly (string | number)[],
): RuleGraphValidationIssue => ({ ruleCode, family, path });

const fieldRecordTypeIds = (field: ModuleFieldV2): readonly string[] | undefined => {
  if (field.type === "link")
    return field.settings.target.state === "resolved" ? [field.settings.target.recordTypeId] : [];
  if (field.type === "link_to_one_of_several")
    return field.settings.targets.flatMap((target) =>
      target.state === "resolved" ? [target.recordTypeId] : [],
    );
  return undefined;
};

const fieldColumns = (field: ModuleFieldV2): readonly RuleTableColumn[] | undefined =>
  field.type === "table"
    ? field.settings.columns.map((column) => ({
        key: column.key,
        type: column.type,
        required: column.required,
      }))
    : undefined;

const fieldValueType = (field: ModuleFieldV2): ValueDeclaration["type"] => {
  if (field.type === "calculation" || field.type === "total") return field.settings.resultType;
  return field.type;
};

const declarationForField = (field: ModuleFieldV2): ValueDeclaration => ({
  type: fieldValueType(field),
  field,
  ...(fieldRecordTypeIds(field) ? { recordTypeIds: fieldRecordTypeIds(field) } : {}),
  ...(fieldColumns(field) ? { columns: fieldColumns(field) } : {}),
});

const declarationForTypedValue = (value: RuleGraphTypedValue): ValueDeclaration => {
  const recordTypeId =
    value.type === "link" || value.type === "link_to_one_of_several"
      ? (value.value as { recordTypeId: string }).recordTypeId
      : undefined;
  return {
    type: value.type,
    ...(recordTypeId ? { recordTypeIds: [recordTypeId] } : {}),
    ...(value.type === "table" ? { columns: value.columns } : {}),
  };
};

const textTypes = new Set<ValueDeclaration["type"]>([
  "text",
  "long_text",
  "choice",
  "email_address",
  "phone_number",
  "web_address",
  "reference_number",
]);

const semanticType = (type: ValueDeclaration["type"]): string => {
  if (textTypes.has(type)) return "text";
  if (type === "yes_no") return "boolean";
  if (type === "several_choices") return "text_collection";
  if (type === "link" || type === "link_to_one_of_several") return "record_reference";
  if (type === "link_to_person") return "organization_account_reference";
  if (type === "formatted_text" || type === "table" || type === "attachment") return "opaque_json";
  return type;
};

const targetsSubset = (
  actual: readonly string[] | undefined,
  expected: readonly string[] | undefined,
): boolean =>
  expected === undefined ||
  (actual !== undefined &&
    actual.length > 0 &&
    actual.every((target) => expected.includes(target)));

const columnsCompatible = (
  actual: readonly RuleTableColumn[] | undefined,
  expected: readonly RuleTableColumn[] | undefined,
): boolean => {
  if (!actual || !expected) return false;
  const actualByKey = new Map(actual.map((column) => [column.key, column]));
  const expectedByKey = new Map(expected.map((column) => [column.key, column]));
  return (
    actual.every((column) => expectedByKey.get(column.key)?.type === column.type) &&
    expected.every(
      (column) =>
        !column.required ||
        (actualByKey.get(column.key)?.required === true &&
          actualByKey.get(column.key)?.type === column.type),
    )
  );
};

const assignmentCompatible = (actual: ValueDeclaration, expected: ValueDeclaration): boolean => {
  if (expected.type === "table")
    return actual.type === "table" && columnsCompatible(actual.columns, expected.columns);
  if (textTypes.has(actual.type) && textTypes.has(expected.type)) return true;
  if (
    (actual.type === "link" || actual.type === "link_to_one_of_several") &&
    (expected.type === "link" || expected.type === "link_to_one_of_several")
  )
    return targetsSubset(actual.recordTypeIds, expected.recordTypeIds);
  return actual.type === expected.type;
};

const conditionCompatible = (left: ValueDeclaration, right: ValueDeclaration): boolean => {
  const leftType = semanticType(left.type);
  const rightType = semanticType(right.type);
  if (leftType === "record_reference" && rightType === "record_reference")
    return (
      left.recordTypeIds !== undefined &&
      right.recordTypeIds !== undefined &&
      left.recordTypeIds.some((target) => right.recordTypeIds!.includes(target))
    );
  if (leftType === rightType) return true;
  return (
    ["whole_number", "decimal_number"].includes(leftType) &&
    ["whole_number", "decimal_number"].includes(rightType)
  );
};

const intersect = (values: readonly Availability[]): Set<string> => {
  if (values.length === 0) return new Set();
  const result = new Set(values[0]);
  for (const value of values.slice(1))
    for (const item of result) if (!value.has(item)) result.delete(item);
  return result;
};

export const validateRuleGraph = ({
  graph: candidate,
  subjectRecordType,
  availableRecordTypeIds,
}: RuleGraphValidationInput): readonly RuleGraphValidationIssue[] => {
  ruleGraphSchema.parse(candidate);
  const issues: RuleGraphValidationIssue[] = [];
  const fields = new Map(subjectRecordType.fields.map((field) => [field.fieldId, field]));
  const inputs = new Map(candidate.inputs.map((input) => [input.inputId, input]));
  const variables = new Map(candidate.variables.map((variable) => [variable.variableId, variable]));
  const nodes = new Map(candidate.nodes.map((node) => [node.nodeId, node]));
  const nodeIndexes = new Map(candidate.nodes.map((node, index) => [node.nodeId, index]));
  const starts = candidate.nodes.filter((node) => node.type === "start");

  if (candidate.subjectRecordTypeId !== subjectRecordType.recordTypeId)
    issues.push(
      issue(ruleGraphValidationCodes.references, "scope_conflict", ["subjectRecordTypeId"]),
    );

  const validateAvailableTargets = (
    recordTypeIds: readonly string[] | undefined,
    path: readonly (string | number)[],
  ): void => {
    recordTypeIds?.forEach((recordTypeId, index) => {
      if (!availableRecordTypeIds.has(recordTypeId))
        issues.push(
          issue(ruleGraphValidationCodes.references, "broken_reference", [...path, index]),
        );
    });
  };
  const validateTypedValueTargets = (
    value: RuleGraphTypedValue,
    path: readonly (string | number)[],
  ): void => {
    if (value.type === "link" || value.type === "link_to_one_of_several") {
      const recordTypeId = (value.value as { recordTypeId: string }).recordTypeId;
      if (!availableRecordTypeIds.has(recordTypeId))
        issues.push(
          issue(ruleGraphValidationCodes.references, "broken_reference", [
            ...path,
            "value",
            "recordTypeId",
          ]),
        );
    }
  };
  let previousUsed = false;
  const validateOperandTargets = (
    operand: RuleGraphOperand,
    path: readonly (string | number)[],
  ): void => {
    if (operand.source === "previous_field") previousUsed = true;
    if (operand.source === "literal") validateTypedValueTargets(operand.value, [...path, "value"]);
  };
  const validateConditionTargets = (
    condition: RuleGraphCondition,
    path: readonly (string | number)[],
  ): void => {
    if (condition.kind === "all" || condition.kind === "any") {
      condition.conditions.forEach((child, index) =>
        validateConditionTargets(child, [...path, "conditions", index]),
      );
      return;
    }
    if (condition.kind === "not") {
      validateConditionTargets(condition.condition, [...path, "condition"]);
      return;
    }
    const comparison = condition as {
      left: RuleGraphOperand;
      right?: RuleGraphOperand;
    };
    validateOperandTargets(comparison.left, [...path, "left"]);
    if (comparison.right) validateOperandTargets(comparison.right, [...path, "right"]);
  };

  candidate.inputs.forEach((input, index) =>
    validateAvailableTargets(input.recordTypeIds, ["inputs", index, "recordTypeIds"]),
  );
  candidate.variables.forEach((variable, index) => {
    validateAvailableTargets(variable.recordTypeIds, ["variables", index, "recordTypeIds"]);
    if (variable.defaultValue) {
      validateTypedValueTargets(variable.defaultValue, ["variables", index, "defaultValue"]);
      if (!assignmentCompatible(declarationForTypedValue(variable.defaultValue), variable))
        issues.push(
          issue(ruleGraphValidationCodes.valueTypes, "invalid_value", [
            "variables",
            index,
            "defaultValue",
          ]),
        );
    }
  });
  candidate.nodes.forEach((node, index) => {
    const path: readonly (string | number)[] = ["nodes", index];
    if (node.type === "condition") validateConditionTargets(node.condition, [...path, "condition"]);
    else if (node.type === "set_variable") validateOperandTargets(node.value, [...path, "value"]);
    else if (node.type === "set_field" && node.assignment.kind === "set")
      validateOperandTargets(node.assignment.value, [...path, "assignment", "value"]);
  });
  if (starts.length !== 1)
    issues.push(issue(ruleGraphValidationCodes.topology, "invalid_value", ["nodes"]));

  const outgoing = new Map<string, typeof candidate.edges>();
  const incoming = new Map<string, typeof candidate.edges>();
  candidate.edges.forEach((edge, edgeIndex) => {
    if (!nodes.has(edge.fromNodeId))
      issues.push(
        issue(ruleGraphValidationCodes.topology, "broken_reference", [
          "edges",
          edgeIndex,
          "fromNodeId",
        ]),
      );
    if (!nodes.has(edge.toNodeId))
      issues.push(
        issue(ruleGraphValidationCodes.topology, "broken_reference", [
          "edges",
          edgeIndex,
          "toNodeId",
        ]),
      );
    outgoing.set(edge.fromNodeId, [...(outgoing.get(edge.fromNodeId) ?? []), edge]);
    incoming.set(edge.toNodeId, [...(incoming.get(edge.toNodeId) ?? []), edge]);
  });

  candidate.nodes.forEach((node, nodeIndex) => {
    const ports = (outgoing.get(node.nodeId) ?? []).map((edge) => edge.port).sort();
    const expected =
      node.type === "condition"
        ? ["false", "true"]
        : node.type === "refuse" || node.type === "finish"
          ? []
          : ["next"];
    if (JSON.stringify(ports) !== JSON.stringify(expected))
      issues.push(issue(ruleGraphValidationCodes.topology, "invalid_value", ["nodes", nodeIndex]));
  });

  const reachable = new Set<string>();
  if (starts[0]) {
    const pending = [starts[0].nodeId];
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      if (reachable.has(nodeId)) continue;
      reachable.add(nodeId);
      for (const edge of outgoing.get(nodeId) ?? [])
        if (nodes.has(edge.toNodeId)) pending.push(edge.toNodeId);
    }
  }
  candidate.nodes.forEach((node, nodeIndex) => {
    if (!reachable.has(node.nodeId))
      issues.push(
        issue(ruleGraphValidationCodes.topology, "broken_reference", ["nodes", nodeIndex]),
      );
  });

  const visiting = new Set<string>();
  const visited = new Set<string>();
  let cyclic = false;
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      cyclic = true;
      return;
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const edge of outgoing.get(nodeId) ?? [])
      if (nodes.has(edge.toNodeId)) visit(edge.toNodeId);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  candidate.nodes.forEach((node) => visit(node.nodeId));
  if (cyclic) issues.push(issue(ruleGraphValidationCodes.topology, "dependency_cycle", ["edges"]));

  const declarationForOperand = (
    operand: RuleGraphOperand,
    path: readonly (string | number)[],
    available: Availability,
    optionalProbe = false,
  ): ValueDeclaration | undefined => {
    if (operand.source === "literal") return declarationForTypedValue(operand.value);
    if (operand.source === "input") {
      const input = inputs.get(operand.inputId);
      if (!input) {
        issues.push(issue(ruleGraphValidationCodes.references, "broken_reference", path));
        return undefined;
      }
      if (!input.required && !available.has(inputAvailability(input.inputId)) && !optionalProbe)
        issues.push(issue(ruleGraphValidationCodes.variableAvailability, "required_value", path));
      return {
        type: input.type,
        ...(input.recordTypeIds ? { recordTypeIds: input.recordTypeIds } : {}),
        ...(input.type === "table" ? { columns: input.columns } : {}),
      };
    }
    if (operand.source === "variable") {
      const variable = variables.get(operand.variableId);
      if (!variable) {
        issues.push(issue(ruleGraphValidationCodes.references, "broken_reference", path));
        return undefined;
      }
      if (!available.has(variableAvailability(variable.variableId)) && !optionalProbe)
        issues.push(issue(ruleGraphValidationCodes.variableAvailability, "required_value", path));
      return {
        type: variable.type,
        ...(variable.recordTypeIds ? { recordTypeIds: variable.recordTypeIds } : {}),
        ...(variable.type === "table" ? { columns: variable.columns } : {}),
      };
    }
    const field = fields.get(operand.fieldId);
    if (!field) {
      issues.push(issue(ruleGraphValidationCodes.references, "scope_conflict", path));
      return undefined;
    }
    return declarationForField(field);
  };

  const validateCondition = (
    condition: RuleGraphCondition,
    path: readonly (string | number)[],
    available: Availability,
  ): void => {
    if (condition.kind === "all" || condition.kind === "any") {
      condition.conditions.forEach((child, index) =>
        validateCondition(child, [...path, "conditions", index], available),
      );
      return;
    }
    if (condition.kind === "not") {
      validateCondition(condition.condition, [...path, "condition"], available);
      return;
    }
    const comparison = condition as {
      operator: string;
      left: RuleGraphOperand;
      right?: RuleGraphOperand;
    };
    const unary = comparison.operator === "is_empty" || comparison.operator === "is_not_empty";
    const left = declarationForOperand(comparison.left, [...path, "left"], available, unary);
    if (unary) return;
    const right = comparison.right
      ? declarationForOperand(comparison.right, [...path, "right"], available)
      : undefined;
    if (!left || !right) return;
    const leftType = semanticType(left.type);
    const rightType = semanticType(right.type);
    let compatible = conditionCompatible(left, right);
    if (comparison.operator === "contains" || comparison.operator === "not_contains")
      compatible =
        (leftType === "text" && rightType === "text") ||
        (leftType === "text_collection" && rightType === "text");
    else if (comparison.operator === "in" || comparison.operator === "not_in")
      compatible = leftType === "text" && rightType === "text_collection";
    else if (
      comparison.operator === "greater_than" ||
      comparison.operator === "greater_than_or_equal" ||
      comparison.operator === "less_than" ||
      comparison.operator === "less_than_or_equal"
    )
      compatible =
        compatible &&
        ["whole_number", "decimal_number", "money", "date", "date_time", "text"].includes(leftType);
    if (!compatible) issues.push(issue(ruleGraphValidationCodes.valueTypes, "invalid_value", path));
  };

  const validateAssignment = (
    actual: ValueDeclaration | undefined,
    expected: ValueDeclaration | undefined,
    path: readonly (string | number)[],
  ) => {
    if (actual && expected && !assignmentCompatible(actual, expected))
      issues.push(issue(ruleGraphValidationCodes.valueTypes, "invalid_value", path));
  };

  const initial = new Set<string>([
    ...candidate.inputs
      .filter((input) => input.required)
      .map((input) => inputAvailability(input.inputId)),
    ...candidate.variables
      .filter((variable) => variable.defaultValue !== undefined)
      .map((variable) => variableAvailability(variable.variableId)),
  ]);
  const edgeAvailability = new Map<string, Set<string>>();
  const edgeKey = (edge: (typeof candidate.edges)[number]) =>
    `${edge.fromNodeId}:${edge.port}:${edge.toNodeId}`;
  const indegree = new Map(candidate.nodes.map((node) => [node.nodeId, 0]));
  candidate.edges.forEach((edge) => {
    if (nodes.has(edge.fromNodeId) && nodes.has(edge.toNodeId))
      indegree.set(edge.toNodeId, (indegree.get(edge.toNodeId) ?? 0) + 1);
  });
  const queue = candidate.nodes
    .filter((node) => (indegree.get(node.nodeId) ?? 0) === 0)
    .map((node) => node.nodeId);
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    const node = nodes.get(nodeId)!;
    const nodeIndex = nodeIndexes.get(nodeId)!;
    const predecessors = incoming.get(nodeId) ?? [];
    const available =
      node.type === "start"
        ? new Set(initial)
        : intersect(predecessors.map((edge) => edgeAvailability.get(edgeKey(edge)) ?? new Set()));

    if (node.type === "condition")
      validateCondition(node.condition, ["nodes", nodeIndex, "condition"], available);
    else if (node.type === "set_variable") {
      const expected = variables.get(node.variableId);
      if (!expected)
        issues.push(
          issue(ruleGraphValidationCodes.references, "broken_reference", [
            "nodes",
            nodeIndex,
            "variableId",
          ]),
        );
      const actual = declarationForOperand(node.value, ["nodes", nodeIndex, "value"], available);
      validateAssignment(
        actual,
        expected
          ? {
              type: expected.type,
              ...(expected.recordTypeIds ? { recordTypeIds: expected.recordTypeIds } : {}),
              ...(expected.type === "table" ? { columns: expected.columns } : {}),
            }
          : undefined,
        ["nodes", nodeIndex, "value"],
      );
      if (expected) available.add(variableAvailability(expected.variableId));
    } else if (node.type === "set_field") {
      const target = fields.get(node.fieldId);
      if (!target)
        issues.push(
          issue(ruleGraphValidationCodes.references, "scope_conflict", [
            "nodes",
            nodeIndex,
            "fieldId",
          ]),
        );
      else if (["reference_number", "calculation", "total"].includes(target.type))
        issues.push(
          issue(ruleGraphValidationCodes.references, "scope_conflict", [
            "nodes",
            nodeIndex,
            "fieldId",
          ]),
        );
      if (node.assignment.kind === "set") {
        const actual = declarationForOperand(
          node.assignment.value,
          ["nodes", nodeIndex, "assignment", "value"],
          available,
        );
        validateAssignment(actual, target ? declarationForField(target) : undefined, [
          "nodes",
          nodeIndex,
          "assignment",
          "value",
        ]);
        const targetValueSchema =
          target && !["reference_number", "calculation", "total"].includes(target.type)
            ? moduleFieldValueV2Schemas[target.type as keyof typeof moduleFieldValueV2Schemas]
            : undefined;
        if (
          actual?.field === undefined &&
          node.assignment.value.source === "literal" &&
          targetValueSchema !== undefined &&
          !targetValueSchema.safeParse(node.assignment.value.value.value).success
        )
          issues.push(
            issue(ruleGraphValidationCodes.valueTypes, "invalid_value", [
              "nodes",
              nodeIndex,
              "assignment",
              "value",
            ]),
          );
      }
    } else if (node.type === "require_field" || node.type === "refuse") {
      if (node.fieldId !== undefined && !fields.has(node.fieldId))
        issues.push(
          issue(ruleGraphValidationCodes.references, "scope_conflict", [
            "nodes",
            nodeIndex,
            "fieldId",
          ]),
        );
    }

    const refinement = (
      condition: RuleGraphCondition,
    ): { key: string; port: "true" | "false" } | undefined => {
      if (condition.kind === "not") {
        const child = refinement(condition.condition);
        return child
          ? { key: child.key, port: child.port === "true" ? "false" : "true" }
          : undefined;
      }
      if (condition.kind !== "comparison") return undefined;
      const comparison = condition as {
        operator: string;
        left: RuleGraphOperand;
      };
      if (comparison.operator !== "is_empty" && comparison.operator !== "is_not_empty")
        return undefined;
      const operand = comparison.left;
      const key =
        operand.source === "input"
          ? inputAvailability(operand.inputId)
          : operand.source === "variable"
            ? variableAvailability(operand.variableId)
            : undefined;
      if (!key) return undefined;
      return { key, port: comparison.operator === "is_empty" ? "false" : "true" };
    };
    const refined = node.type === "condition" ? refinement(node.condition) : undefined;
    for (const edge of outgoing.get(nodeId) ?? []) {
      if (!nodes.has(edge.toNodeId)) continue;
      const next = new Set(available);
      if (refined && edge.port === refined.port) next.add(refined.key);
      edgeAvailability.set(edgeKey(edge), next);
      indegree.set(edge.toNodeId, (indegree.get(edge.toNodeId) ?? 1) - 1);
      if (indegree.get(edge.toNodeId) === 0) queue.push(edge.toNodeId);
    }
  }

  if (previousUsed && starts.some((start) => start.operations.includes("create")))
    issues.push(issue(ruleGraphValidationCodes.references, "scope_conflict", ["nodes"]));

  return issues;
};
