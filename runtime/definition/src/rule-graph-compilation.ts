import {
  normalizeExactDecimal,
  ruleGraphSchema,
  ruleGraphTypedValueSchema,
  sourceRuleGraphSchema,
  type DefinitionProvenanceEntry,
  type ContainedComponentId,
  type FieldId,
  type RecordTypeId,
  type RuleId,
  type RuleGraph,
  type RuleGraphCondition,
  type RuleGraphOperand,
  type RuleTableColumn,
  type RuleGraphTypedValue,
  type SourceRuleGraph,
  type SourceRuleGraphCondition,
  type SourceRuleGraphOperand,
  type SourceRuleGraphTypedValue,
} from "@vortex/contracts";
import { compareCanonicalStrings } from "./canonical-json";

type Path = Array<string | number>;
type Provenance = DefinitionProvenanceEntry[];

const resolutionRule = "vortex.definition.immutable_resolution";
const transformRule = "vortex.definition.semantic_transform";

export type RuleGraphCompilationResolver = Readonly<{
  ruleId: (alias: string) => RuleId;
  nodeId: (ruleAlias: string, nodeAlias: string) => ContainedComponentId;
  inputId: (ruleAlias: string, inputAlias: string) => ContainedComponentId;
  variableId: (ruleAlias: string, variableAlias: string) => ContainedComponentId;
  localRecordTypeId: (recordAlias: string) => RecordTypeId;
  localFieldId: (recordAlias: string, fieldAlias: string) => FieldId;
  qualifiedRecordTypeId: (reference: string) => RecordTypeId;
}>;

export type CompiledRuleGraph = Readonly<{
  graph: RuleGraph;
  /** Paths are relative to the source and canonical graph roots. */
  provenance: readonly DefinitionProvenanceEntry[];
}>;

type Compiled<T> = Readonly<{
  value: T;
  trace: (canonicalBase: Path, provenance: Provenance) => void;
}>;

const jsonEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const sourceEntry = (
  canonicalPath: Path,
  sourcePath: Path,
  sourceValue: unknown,
  canonicalValue: unknown,
): DefinitionProvenanceEntry => ({
  canonicalPath,
  origin: "source",
  sourcePath,
  ...(!jsonEqual(sourceValue, canonicalValue) ? { ruleCode: transformRule } : {}),
});

const resolvedEntry = (canonicalPath: Path, sourcePath: Path): DefinitionProvenanceEntry => ({
  canonicalPath,
  origin: "resolved",
  sourcePath,
  ruleCode: resolutionRule,
});

const traceSameShape = (
  source: unknown,
  canonical: unknown,
  sourceBase: Path,
  canonicalBase: Path,
  provenance: Provenance,
): void => {
  if (canonical === null || typeof canonical !== "object") {
    provenance.push(sourceEntry(canonicalBase, sourceBase, source, canonical));
    return;
  }
  if (Array.isArray(canonical)) {
    canonical.forEach((value, index) =>
      traceSameShape(
        Array.isArray(source) ? source[index] : undefined,
        value,
        [...sourceBase, index],
        [...canonicalBase, index],
        provenance,
      ),
    );
    return;
  }
  const sourceObject =
    source !== null && typeof source === "object" && !Array.isArray(source)
      ? (source as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(canonical))
    traceSameShape(
      sourceObject[key],
      value,
      [...sourceBase, key],
      [...canonicalBase, key],
      provenance,
    );
};

const normaliseExact = (value: string): string => normalizeExactDecimal(value) ?? value;

const compileColumns = (
  columns: readonly RuleTableColumn[] | undefined,
  sourceBase: Path,
): Compiled<readonly RuleTableColumn[]> | undefined => {
  if (!columns) return undefined;
  const sorted = columns
    .map((column, sourceIndex) => ({ column, sourceIndex }))
    .sort((left, right) => compareCanonicalStrings(left.column.key, right.column.key));
  return {
    value: sorted.map(({ column }) => column),
    trace: (canonicalBase, provenance) =>
      sorted.forEach(({ column, sourceIndex }, canonicalIndex) =>
        traceSameShape(
          column,
          column,
          [...sourceBase, sourceIndex],
          [...canonicalBase, canonicalIndex],
          provenance,
        ),
      ),
  };
};

const compileTableRows = (value: unknown, columns: readonly RuleTableColumn[]): unknown => {
  if (!Array.isArray(value)) return value;
  const byKey = new Map(columns.map((column) => [column.key, column]));
  return value.map((candidate) => {
    const row = candidate as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(row).map(([key, cell]) => {
        const column = byKey.get(key);
        if (column?.type === "decimal_number" && typeof cell === "string")
          return [key, normaliseExact(cell)];
        if (
          column?.type === "money" &&
          cell !== null &&
          typeof cell === "object" &&
          !Array.isArray(cell)
        ) {
          const money = cell as { amount: string; currency: string };
          return [key, { ...money, amount: normaliseExact(money.amount) }];
        }
        return [key, cell];
      }),
    );
  });
};

const compileTypedValue = (
  source: SourceRuleGraphTypedValue,
  resolver: RuleGraphCompilationResolver,
  sourceBase: Path,
): Compiled<RuleGraphTypedValue> => {
  const entry = source as {
    type: string;
    value: unknown;
    columns?: readonly RuleTableColumn[];
  };
  const columns = compileColumns(entry.columns, [...sourceBase, "columns"]);
  let canonicalValue: unknown = entry.value;
  if (entry.type === "decimal_number") canonicalValue = normaliseExact(entry.value as string);
  else if (entry.type === "money") {
    const money = entry.value as { amount: string; currency: string };
    canonicalValue = { ...money, amount: normaliseExact(money.amount) };
  } else if (entry.type === "link" || entry.type === "link_to_one_of_several") {
    const link = entry.value as { record_type: string; record_id: string };
    canonicalValue = {
      recordTypeId: resolver.qualifiedRecordTypeId(link.record_type),
      recordId: link.record_id,
    };
  } else if (entry.type === "link_to_person") {
    const link = entry.value as { organization_account_id: string };
    canonicalValue = { organizationAccountId: link.organization_account_id };
  } else if (entry.type === "table" && columns)
    canonicalValue = compileTableRows(entry.value, columns.value);
  const canonical = ruleGraphTypedValueSchema.parse({
    type: entry.type,
    value: canonicalValue,
    ...(columns ? { columns: columns.value } : {}),
  });

  return {
    value: canonical,
    trace: (canonicalBase, provenance) => {
      provenance.push(
        sourceEntry(
          [...canonicalBase, "type"],
          [...sourceBase, "type"],
          entry.type,
          canonical.type,
        ),
      );
      columns?.trace([...canonicalBase, "columns"], provenance);
      if (entry.type === "link" || entry.type === "link_to_one_of_several") {
        provenance.push(
          resolvedEntry(
            [...canonicalBase, "value", "recordTypeId"],
            [...sourceBase, "value", "record_type"],
          ),
          sourceEntry(
            [...canonicalBase, "value", "recordId"],
            [...sourceBase, "value", "record_id"],
            (entry.value as { record_id: string }).record_id,
            (canonical.value as { recordId: string }).recordId,
          ),
        );
        return;
      }
      if (entry.type === "link_to_person") {
        provenance.push(
          sourceEntry(
            [...canonicalBase, "value", "organizationAccountId"],
            [...sourceBase, "value", "organization_account_id"],
            (entry.value as { organization_account_id: string }).organization_account_id,
            (canonical.value as { organizationAccountId: string }).organizationAccountId,
          ),
        );
        return;
      }
      traceSameShape(
        entry.value,
        canonical.value,
        [...sourceBase, "value"],
        [...canonicalBase, "value"],
        provenance,
      );
    },
  };
};

const compileOperand = (
  source: SourceRuleGraphOperand,
  resolver: RuleGraphCompilationResolver,
  ruleAlias: string,
  recordAlias: string,
  sourceBase: Path,
): Compiled<RuleGraphOperand> => {
  if (source.source === "literal") {
    const compiled = compileTypedValue(source.value, resolver, [...sourceBase, "value"]);
    return {
      value: { source: "literal", value: compiled.value },
      trace: (canonicalBase, provenance) => {
        provenance.push(
          sourceEntry(
            [...canonicalBase, "source"],
            [...sourceBase, "source"],
            source.source,
            "literal",
          ),
        );
        compiled.trace([...canonicalBase, "value"], provenance);
      },
    };
  }
  if (source.source === "input") {
    const inputId = resolver.inputId(ruleAlias, source.input);
    return {
      value: { source: "input", inputId },
      trace: (canonicalBase, provenance) => {
        provenance.push(
          sourceEntry(
            [...canonicalBase, "source"],
            [...sourceBase, "source"],
            source.source,
            "input",
          ),
          resolvedEntry([...canonicalBase, "inputId"], [...sourceBase, "input"]),
        );
      },
    };
  }
  if (source.source === "variable") {
    const variableId = resolver.variableId(ruleAlias, source.variable);
    return {
      value: { source: "variable", variableId },
      trace: (canonicalBase, provenance) => {
        provenance.push(
          sourceEntry(
            [...canonicalBase, "source"],
            [...sourceBase, "source"],
            source.source,
            "variable",
          ),
          resolvedEntry([...canonicalBase, "variableId"], [...sourceBase, "variable"]),
        );
      },
    };
  }
  const fieldId = resolver.localFieldId(recordAlias, source.field);
  const canonicalSource = source.source;
  return {
    value: { source: canonicalSource, fieldId },
    trace: (canonicalBase, provenance) => {
      provenance.push(
        sourceEntry(
          [...canonicalBase, "source"],
          [...sourceBase, "source"],
          source.source,
          canonicalSource,
        ),
        resolvedEntry([...canonicalBase, "fieldId"], [...sourceBase, "field"]),
      );
    },
  };
};

const compileCondition = (
  source: SourceRuleGraphCondition,
  resolver: RuleGraphCompilationResolver,
  ruleAlias: string,
  recordAlias: string,
  sourceBase: Path,
): Compiled<RuleGraphCondition> => {
  if (source.kind === "comparison") {
    const left = compileOperand(source.left, resolver, ruleAlias, recordAlias, [
      ...sourceBase,
      "left",
    ]);
    const right =
      "right" in source
        ? compileOperand(source.right, resolver, ruleAlias, recordAlias, [...sourceBase, "right"])
        : undefined;
    const value = {
      kind: "comparison" as const,
      operator: source.operator,
      left: left.value,
      ...(right ? { right: right.value } : {}),
    } as RuleGraphCondition;
    return {
      value,
      trace: (canonicalBase, provenance) => {
        provenance.push(
          sourceEntry(
            [...canonicalBase, "kind"],
            [...sourceBase, "kind"],
            source.kind,
            "comparison",
          ),
          sourceEntry(
            [...canonicalBase, "operator"],
            [...sourceBase, "operator"],
            source.operator,
            source.operator,
          ),
        );
        left.trace([...canonicalBase, "left"], provenance);
        right?.trace([...canonicalBase, "right"], provenance);
      },
    };
  }
  if (source.kind === "not") {
    const child = compileCondition(source.condition, resolver, ruleAlias, recordAlias, [
      ...sourceBase,
      "condition",
    ]);
    return {
      value: { kind: "not", condition: child.value },
      trace: (canonicalBase, provenance) => {
        provenance.push(
          sourceEntry(
            [...canonicalBase, "kind"],
            [...sourceBase, "kind"],
            source.kind,
            source.kind,
          ),
        );
        child.trace([...canonicalBase, "condition"], provenance);
      },
    };
  }
  const children = source.conditions.map((condition, index) =>
    compileCondition(condition, resolver, ruleAlias, recordAlias, [
      ...sourceBase,
      "conditions",
      index,
    ]),
  );
  return {
    value: { kind: source.kind, conditions: children.map((child) => child.value) },
    trace: (canonicalBase, provenance) => {
      provenance.push(
        sourceEntry([...canonicalBase, "kind"], [...sourceBase, "kind"], source.kind, source.kind),
      );
      children.forEach((child, index) =>
        child.trace([...canonicalBase, "conditions", index], provenance),
      );
    },
  };
};

export const compileRuleGraph = (
  candidate: SourceRuleGraph,
  resolver: RuleGraphCompilationResolver,
): CompiledRuleGraph => {
  const source = sourceRuleGraphSchema.parse(candidate);
  const provenance: Provenance = [];
  const ruleId = resolver.ruleId(source.id);
  const subjectRecordTypeId = resolver.localRecordTypeId(source.record_type);

  const inputs = source.inputs
    .map((input, sourceIndex) => {
      const targets = (input.record_types ?? [])
        .map((reference, targetSourceIndex) => ({
          reference,
          sourceIndex: targetSourceIndex,
          recordTypeId: resolver.qualifiedRecordTypeId(reference),
        }))
        .sort((left, right) => compareCanonicalStrings(left.recordTypeId, right.recordTypeId));
      const columns = compileColumns(input.columns, ["inputs", sourceIndex, "columns"]);
      const value = {
        inputId: resolver.inputId(source.id, input.id),
        key: input.key,
        type: input.type,
        required: input.required,
        ...(targets.length > 0
          ? { recordTypeIds: targets.map((target) => target.recordTypeId) }
          : {}),
        ...(columns ? { columns: columns.value } : {}),
      };
      return {
        sourceIndex,
        value,
        trace: (canonicalIndex: number) => {
          const sourceBase: Path = ["inputs", sourceIndex];
          const canonicalBase: Path = ["inputs", canonicalIndex];
          provenance.push(
            resolvedEntry([...canonicalBase, "inputId"], [...sourceBase, "id"]),
            sourceEntry([...canonicalBase, "key"], [...sourceBase, "key"], input.key, input.key),
            sourceEntry(
              [...canonicalBase, "type"],
              [...sourceBase, "type"],
              input.type,
              input.type,
            ),
            sourceEntry(
              [...canonicalBase, "required"],
              [...sourceBase, "required"],
              input.required,
              input.required,
            ),
          );
          targets.forEach((target, targetIndex) =>
            provenance.push(
              resolvedEntry(
                [...canonicalBase, "recordTypeIds", targetIndex],
                [...sourceBase, "record_types", target.sourceIndex],
              ),
            ),
          );
          columns?.trace([...canonicalBase, "columns"], provenance);
        },
      };
    })
    .sort((left, right) => compareCanonicalStrings(left.value.inputId, right.value.inputId));

  const variables = source.variables
    .map((variable, sourceIndex) => {
      const targets = (variable.record_types ?? [])
        .map((reference, targetSourceIndex) => ({
          reference,
          sourceIndex: targetSourceIndex,
          recordTypeId: resolver.qualifiedRecordTypeId(reference),
        }))
        .sort((left, right) => compareCanonicalStrings(left.recordTypeId, right.recordTypeId));
      const columns = compileColumns(variable.columns, ["variables", sourceIndex, "columns"]);
      const defaultValue = variable.default_value
        ? compileTypedValue(variable.default_value, resolver, [
            "variables",
            sourceIndex,
            "default_value",
          ])
        : undefined;
      const value = {
        variableId: resolver.variableId(source.id, variable.id),
        key: variable.key,
        type: variable.type,
        ...(targets.length > 0
          ? { recordTypeIds: targets.map((target) => target.recordTypeId) }
          : {}),
        ...(columns ? { columns: columns.value } : {}),
        ...(defaultValue ? { defaultValue: defaultValue.value } : {}),
      };
      return {
        sourceIndex,
        value,
        trace: (canonicalIndex: number) => {
          const sourceBase: Path = ["variables", sourceIndex];
          const canonicalBase: Path = ["variables", canonicalIndex];
          provenance.push(
            resolvedEntry([...canonicalBase, "variableId"], [...sourceBase, "id"]),
            sourceEntry(
              [...canonicalBase, "key"],
              [...sourceBase, "key"],
              variable.key,
              variable.key,
            ),
            sourceEntry(
              [...canonicalBase, "type"],
              [...sourceBase, "type"],
              variable.type,
              variable.type,
            ),
          );
          targets.forEach((target, targetIndex) =>
            provenance.push(
              resolvedEntry(
                [...canonicalBase, "recordTypeIds", targetIndex],
                [...sourceBase, "record_types", target.sourceIndex],
              ),
            ),
          );
          columns?.trace([...canonicalBase, "columns"], provenance);
          defaultValue?.trace([...canonicalBase, "defaultValue"], provenance);
        },
      };
    })
    .sort((left, right) => compareCanonicalStrings(left.value.variableId, right.value.variableId));

  const nodes = source.nodes
    .map((node, sourceIndex) => {
      const sourceBase: Path = ["nodes", sourceIndex];
      const common = {
        nodeId: resolver.nodeId(source.id, node.id),
        nodeVersion: node.node_version,
        type: node.type,
      };
      let specific: Record<string, unknown> = {};
      let traceSpecific: (canonicalBase: Path) => void = () => {};
      if (node.type === "start") {
        const operations = [...node.operations].sort();
        specific = { operations };
        traceSpecific = (canonicalBase) =>
          operations.forEach((operation, index) => {
            const sourceIndexForOperation = node.operations.indexOf(operation);
            provenance.push(
              sourceEntry(
                [...canonicalBase, "operations", index],
                [...sourceBase, "operations", sourceIndexForOperation],
                operation,
                operation,
              ),
            );
          });
      } else if (node.type === "condition") {
        const condition = compileCondition(
          node.condition,
          resolver,
          source.id,
          source.record_type,
          [...sourceBase, "condition"],
        );
        specific = { condition: condition.value };
        traceSpecific = (canonicalBase) =>
          condition.trace([...canonicalBase, "condition"], provenance);
      } else if (node.type === "set_variable") {
        const value = compileOperand(node.value, resolver, source.id, source.record_type, [
          ...sourceBase,
          "value",
        ]);
        specific = {
          variableId: resolver.variableId(source.id, node.variable),
          value: value.value,
        };
        traceSpecific = (canonicalBase) => {
          provenance.push(
            resolvedEntry([...canonicalBase, "variableId"], [...sourceBase, "variable"]),
          );
          value.trace([...canonicalBase, "value"], provenance);
        };
      } else if (node.type === "set_field") {
        const fieldId = resolver.localFieldId(source.record_type, node.field);
        const value =
          node.assignment.kind === "set"
            ? compileOperand(node.assignment.value, resolver, source.id, source.record_type, [
                ...sourceBase,
                "assignment",
                "value",
              ])
            : undefined;
        specific = {
          fieldId,
          assignment:
            node.assignment.kind === "clear"
              ? { kind: "clear" }
              : { kind: "set", value: value!.value },
        };
        traceSpecific = (canonicalBase) => {
          provenance.push(
            resolvedEntry([...canonicalBase, "fieldId"], [...sourceBase, "field"]),
            sourceEntry(
              [...canonicalBase, "assignment", "kind"],
              [...sourceBase, "assignment", "kind"],
              node.assignment.kind,
              node.assignment.kind,
            ),
          );
          value?.trace([...canonicalBase, "assignment", "value"], provenance);
        };
      } else if (node.type === "require_field") {
        specific = {
          fieldId: resolver.localFieldId(source.record_type, node.field),
          code: node.code,
          message: node.message,
        };
        traceSpecific = (canonicalBase) => {
          provenance.push(
            resolvedEntry([...canonicalBase, "fieldId"], [...sourceBase, "field"]),
            sourceEntry([...canonicalBase, "code"], [...sourceBase, "code"], node.code, node.code),
            sourceEntry(
              [...canonicalBase, "message"],
              [...sourceBase, "message"],
              node.message,
              node.message,
            ),
          );
        };
      } else if (node.type === "warn") {
        specific = { code: node.code, message: node.message };
        traceSpecific = (canonicalBase) => {
          provenance.push(
            sourceEntry([...canonicalBase, "code"], [...sourceBase, "code"], node.code, node.code),
            sourceEntry(
              [...canonicalBase, "message"],
              [...sourceBase, "message"],
              node.message,
              node.message,
            ),
          );
        };
      } else if (node.type === "refuse") {
        specific = {
          code: node.code,
          message: node.message,
          ...(node.field ? { fieldId: resolver.localFieldId(source.record_type, node.field) } : {}),
        };
        traceSpecific = (canonicalBase) => {
          provenance.push(
            sourceEntry([...canonicalBase, "code"], [...sourceBase, "code"], node.code, node.code),
            sourceEntry(
              [...canonicalBase, "message"],
              [...sourceBase, "message"],
              node.message,
              node.message,
            ),
          );
          if (node.field)
            provenance.push(resolvedEntry([...canonicalBase, "fieldId"], [...sourceBase, "field"]));
        };
      }
      const value = { ...common, ...specific };
      return {
        sourceIndex,
        value,
        trace: (canonicalIndex: number) => {
          const canonicalBase: Path = ["nodes", canonicalIndex];
          provenance.push(
            resolvedEntry([...canonicalBase, "nodeId"], [...sourceBase, "id"]),
            sourceEntry(
              [...canonicalBase, "nodeVersion"],
              [...sourceBase, "node_version"],
              node.node_version,
              node.node_version,
            ),
            sourceEntry([...canonicalBase, "type"], [...sourceBase, "type"], node.type, node.type),
          );
          traceSpecific(canonicalBase);
        },
      };
    })
    .sort((left, right) =>
      compareCanonicalStrings(String(left.value.nodeId), String(right.value.nodeId)),
    );

  const edges = source.edges
    .map((edge, sourceIndex) => {
      const value = {
        fromNodeId: resolver.nodeId(source.id, edge.from),
        port: edge.port,
        toNodeId: resolver.nodeId(source.id, edge.to),
      };
      return { sourceIndex, value };
    })
    .sort((left, right) => {
      const leftKey = `${left.value.fromNodeId}:${left.value.port}:${left.value.toNodeId}`;
      const rightKey = `${right.value.fromNodeId}:${right.value.port}:${right.value.toNodeId}`;
      return compareCanonicalStrings(leftKey, rightKey);
    });

  const graph = ruleGraphSchema.parse({
    ruleId,
    key: source.key,
    subjectRecordTypeId,
    profile: source.profile,
    graphVersion: source.graph_version,
    priority: source.priority,
    inputs: inputs.map((input) => input.value),
    variables: variables.map((variable) => variable.value),
    nodes: nodes.map((node) => node.value),
    edges: edges.map((edge) => edge.value),
  });

  provenance.push(
    resolvedEntry(["ruleId"], ["id"]),
    sourceEntry(["key"], ["key"], source.key, graph.key),
    resolvedEntry(["subjectRecordTypeId"], ["record_type"]),
    sourceEntry(["profile"], ["profile"], source.profile, graph.profile),
    sourceEntry(["graphVersion"], ["graph_version"], source.graph_version, graph.graphVersion),
    sourceEntry(["priority"], ["priority"], source.priority, graph.priority),
  );
  inputs.forEach((input, index) => input.trace(index));
  variables.forEach((variable, index) => variable.trace(index));
  nodes.forEach((node, index) => node.trace(index));
  edges.forEach((edge, index) => {
    const sourceBase: Path = ["edges", edge.sourceIndex];
    const canonicalBase: Path = ["edges", index];
    provenance.push(
      resolvedEntry([...canonicalBase, "fromNodeId"], [...sourceBase, "from"]),
      sourceEntry(
        [...canonicalBase, "port"],
        [...sourceBase, "port"],
        source.edges[edge.sourceIndex]!.port,
        edge.value.port,
      ),
      resolvedEntry([...canonicalBase, "toNodeId"], [...sourceBase, "to"]),
    );
  });

  return { graph, provenance };
};
