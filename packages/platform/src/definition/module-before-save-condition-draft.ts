import "server-only";

import {
  moduleRootIdSchema,
  conditionNodeSchema,
  fingerprintSchema,
  revisionSchema,
  platformIdSchema,
  recordTypeIdSchema,
  type ConditionNode,
  type ModuleSourceDocument,
  type ModuleField,
  type DefinitionValidationResult,
  type DefinitionRuleFailure,
  type RecordTypeId,
  type Fingerprint,
  type FlowFormula,
  type RuleGraphCondition,
  flowLiteralSchema,
  type ModuleRootId,
  type OrganizationId,
  type Revision,
} from "../schema";
import { z } from "zod";
import { fingerprintCanonicalValue } from "./canonical-json-definition";
import type { PlatformPermissionSource } from "../access/platform-permissions";
import { definitionSemanticRules } from "./validation";
import { refuse } from "./definition-publication-contracts";
import {
  currentOwnedIdentity,
  type CurrentModuleQueryFilterState,
  moduleValidationFromFailures,
  compileCurrentModuleQueryFilterState,
} from "./module-query-filter-draft";
import type { CompiledModuleCandidate } from "./definition-publication-compilation";

type BeforeSaveReason =
  "flow_target_unsupported" | "operand_context_unsupported" | "retained_condition_unsupported";
export type ModuleBeforeSaveConditionDraftContext = Readonly<{
  organizationId: OrganizationId;
  rootId: ModuleRootId;
  definitionKey: string;
  draftRevision: Revision;
  savedSourceFingerprint: Fingerprint;
  resolutionFingerprint: Fingerprint;
  operandBindingFingerprint: Fingerprint;
  flow: Readonly<{ alias: string; key: string; flowId: string }>;
  trigger: Readonly<{
    id: string;
    recordAlias: string;
    recordKey: string;
    recordTypeId: RecordTypeId;
    operations: readonly Readonly<{ kind: "create" | "update" }>[];
    priority: number;
  }>;
  task: Readonly<{ id: string; path: readonly ["tasks", number]; nodeId: string }>;
  fields: readonly Readonly<{ sourceAlias: string; sourceKey: string; field: ModuleField }>[];
  condition: ConditionNode;
}>;
export type ModuleBeforeSaveConditionFlowChoice = Readonly<{
  alias: string;
  key: string;
  taskId: string;
  eligible: boolean;
  reason?: BeforeSaveReason;
}>;
export type ModuleBeforeSaveConditionDraftResult =
  | Readonly<{
      kind: "available";
      flowChoices: readonly ModuleBeforeSaveConditionFlowChoice[];
      selected?: ModuleBeforeSaveConditionDraftContext;
    }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
  | Readonly<{ kind: "unsupported_context"; reason: BeforeSaveReason }>;
export type ModuleBeforeSaveConditionValidationResult =
  | Readonly<{
      kind: "validated";
      source: ModuleSourceDocument;
      sourceFingerprint: Fingerprint;
      context: ModuleBeforeSaveConditionDraftContext;
      noChange: boolean;
    }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
  | Readonly<{ kind: "unsupported_context"; reason: BeforeSaveReason }>;

export const fingerprintModuleBeforeSaveConditionOperandBinding = (
  binding: Omit<ModuleBeforeSaveConditionDraftContext, "condition" | "operandBindingFingerprint">,
): Fingerprint =>
  fingerprintCanonicalValue({
    domain: "vortex.module_before_save_condition_operand_binding.v1",
    organizationId: binding.organizationId,
    rootId: binding.rootId,
    definitionKey: binding.definitionKey,
    draftRevision: binding.draftRevision,
    savedSourceFingerprint: binding.savedSourceFingerprint,
    resolutionFingerprint: binding.resolutionFingerprint,
    flow: binding.flow,
    trigger: binding.trigger,
    task: binding.task,
    fields: binding.fields,
  });

const beforeSaveReadShape = {
  rootId: platformIdSchema,
  expectedDraftRevision: revisionSchema,
  expectedSavedSourceFingerprint: fingerprintSchema,
};
export const beforeSaveReadSchema = z
  .object({
    ...beforeSaveReadShape,
    flowAlias: z.string().min(1).max(240).optional(),
    taskId: z.string().min(1).max(160).optional(),
  })
  .strict()
  .refine((value) => (value.flowAlias === undefined) === (value.taskId === undefined));
export const beforeSaveValidationSchema = z
  .object({
    ...beforeSaveReadShape,
    flowAlias: z.string().min(1).max(240),
    taskId: z.string().min(1).max(160),
    expectedResolutionFingerprint: fingerprintSchema,
    expectedOperandBindingFingerprint: fingerprintSchema,
    condition: conditionNodeSchema,
  })
  .strict();
const beforeSaveFieldTypes = new Set<ModuleField["type"]>([
  "text",
  "long_text",
  "whole_number",
  "decimal_number",
  "yes_no",
  "date",
  "date_time",
]);
const beforeSaveOperators = {
  equals: "eq",
  not_equals: "neq",
  less_than: "lt",
  less_than_or_equal: "lte",
  greater_than: "gt",
  greater_than_or_equal: "gte",
  contains: "contains",
} as const;
type BeforeSaveOperand = Extract<ConditionNode, { kind: "comparison" }>["left"];
type BeforeSaveFields = ModuleBeforeSaveConditionDraftContext["fields"];

/** Convert only the current, typed field subset; never accept a client source alias. */
export const encodeBeforeSaveCondition = (
  node: ConditionNode,
  fields: BeforeSaveFields,
): FlowFormula | undefined => {
  if (node.kind === "not") {
    const child = encodeBeforeSaveCondition(node.condition, fields);
    return child === undefined ? undefined : { op: "not", arg: child };
  }
  if (node.kind === "all" || node.kind === "any") {
    const children = node.conditions.map((child) => encodeBeforeSaveCondition(child, fields));
    if (children.some((child) => child === undefined)) return undefined;
    return { op: node.kind === "all" ? "and" : "or", args: children as FlowFormula[] };
  }
  if (node.kind !== "comparison") return undefined;
  const fieldFor = (operand: BeforeSaveOperand) =>
    operand.source === "field"
      ? fields.find((entry) => entry.field.fieldId === operand.fieldId)
      : undefined;
  const leftField = fieldFor(node.left);
  const rightField = node.right === undefined ? undefined : fieldFor(node.right);
  if (leftField === undefined && rightField === undefined) return undefined;
  const operand = (
    value: BeforeSaveOperand,
    comparedField: BeforeSaveFields[number] | undefined,
  ): FlowFormula | undefined => {
    if (value.source === "field") {
      const matches = fields.filter((entry) => entry.field.fieldId === value.fieldId);
      return matches.length === 1
        ? { op: "reference", reference: { source: "trigger_record", field: matches[0]!.sourceKey } }
        : undefined;
    }
    if (value.source !== "value" || comparedField === undefined || value.value === null)
      return undefined;
    const type = comparedField.field.type === "long_text" ? "text" : comparedField.field.type;
    if (
      type === "whole_number" &&
      (typeof value.value !== "number" || !Number.isSafeInteger(value.value))
    )
      return undefined;
    if (type === "decimal_number" && typeof value.value !== "string") return undefined;
    const literal = flowLiteralSchema.safeParse({ type, value: value.value });
    return literal.success ? { op: "literal", ...literal.data } : undefined;
  };
  const left = operand(node.left, rightField);
  if (left === undefined) return undefined;
  if (node.operator === "is_empty" || node.operator === "is_not_empty")
    return leftField === undefined ? undefined : { op: node.operator, arg: left };
  const op = beforeSaveOperators[node.operator as keyof typeof beforeSaveOperators];
  if (op === undefined || node.right === undefined) return undefined;
  const right = operand(node.right, leftField);
  return right === undefined ? undefined : { op, left, right };
};

/** A shared-controls view of a compiled predicate, with no evaluator or new stored grammar. */
const beforeSaveCommonCondition = (
  node: RuleGraphCondition,
  fields: BeforeSaveFields,
): ConditionNode | undefined => {
  if (node.kind === "not") {
    const child = beforeSaveCommonCondition(node.condition, fields);
    return child === undefined ? undefined : { kind: "not", condition: child };
  }
  if (node.kind === "all" || node.kind === "any") {
    const children = node.conditions.map((child) => beforeSaveCommonCondition(child, fields));
    return children.some((child) => child === undefined)
      ? undefined
      : { kind: node.kind, conditions: children as ConditionNode[] };
  }
  if (node.kind !== "comparison") return undefined;
  const operand = (value: typeof node.left): BeforeSaveOperand | undefined => {
    if (value.source === "current_field") {
      const matches = fields.filter((entry) => entry.field.fieldId === value.fieldId);
      return matches.length === 1
        ? { source: "field", fieldId: matches[0]!.field.fieldId }
        : undefined;
    }
    return value.source === "literal" &&
      beforeSaveFieldTypes.has(value.value.type as ModuleField["type"])
      ? { source: "value", value: value.value.value }
      : undefined;
  };
  const left = operand(node.left);
  if (left === undefined) return undefined;
  if (node.operator === "is_empty" || node.operator === "is_not_empty")
    return { kind: "comparison", operator: node.operator, left };
  if (!(node.operator in beforeSaveOperators) || !("right" in node)) return undefined;
  const right = operand(node.right);
  return right === undefined
    ? undefined
    : { kind: "comparison", operator: node.operator, left, right };
};

type EligibleBeforeSaveCondition = Readonly<{
  choice: ModuleBeforeSaveConditionFlowChoice;
  context?: ModuleBeforeSaveConditionDraftContext;
}>;
export const beforeSaveChoices = (
  state: CurrentModuleQueryFilterState,
): readonly EligibleBeforeSaveCondition[] => {
  const { candidate, resolution, compiled } = state;
  if (candidate.draft.kind !== "module" || candidate.draft.source.kind !== "module")
    return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  const source = candidate.draft.source;
  const rootId = moduleRootIdSchema.parse(candidate.draft.rootId);
  const result: EligibleBeforeSaveCondition[] = [];
  for (const flow of source.body.flows) {
    const trigger = flow.triggers[0];
    if (trigger?.type !== "BeforeSave") continue;
    for (const [index, task] of flow.tasks.entries()) {
      if (task.type !== "if" || !("condition" in task)) continue;
      const base = { alias: flow.id, key: flow.key, taskId: task.id };
      const unsupported = (reason: BeforeSaveReason): void => {
        result.push({ choice: { ...base, eligible: false, reason } });
      };
      const flowId = currentOwnedIdentity(
        resolution.identities,
        source.key,
        "flow",
        "content",
        flow.id,
        [flow.id, flow.key],
      );
      const recordMatches = source.body.record_types.filter(
        (entry) => entry.id === trigger.recordTypeId || entry.key === trigger.recordTypeId,
      );
      const record = recordMatches[0];
      const compiledFlows = compiled.output.canonical.content.flows.filter(
        (entry) => String(entry.id) === flowId && entry.key === flow.key,
      );
      const rules = compiled.output.canonical.content.rules.filter(
        (entry) => String(entry.ruleId) === flowId && entry.key === flow.key,
      );
      if (
        flow.execution !== "transaction" ||
        flow.triggers.length !== 1 ||
        trigger.operations.some((entry) => entry.kind !== "create" && entry.kind !== "update") ||
        flowId === undefined ||
        compiledFlows.length !== 1 ||
        rules.length !== 1 ||
        recordMatches.length !== 1 ||
        record === undefined
      ) {
        unsupported("flow_target_unsupported");
        continue;
      }
      const recordId = currentOwnedIdentity(
        resolution.identities,
        source.key,
        "record_type",
        "content",
        record.id,
        [record.id, record.key],
      );
      const recordType = recordTypeIdSchema.safeParse(recordId);
      const compiledRecords = compiled.output.canonical.content.recordTypes.filter(
        (entry) => entry.recordTypeId === recordId,
      );
      const rule = rules[0]!;
      if (
        !recordType.success ||
        compiledRecords.length !== 1 ||
        rule.subjectRecordTypeId !== recordType.data ||
        rule.priority !== trigger.priority
      ) {
        unsupported("flow_target_unsupported");
        continue;
      }
      const fields: BeforeSaveFields[number][] = [];
      let validFields = true;
      for (const declaration of record.fields) {
        const id = currentOwnedIdentity(
          resolution.identities,
          source.key,
          "field",
          `record:${record.key}`,
          declaration.id,
          [declaration.id, declaration.key],
        );
        const matches = compiledRecords[0]!.fields.filter(
          (entry) => entry.fieldId === id && entry.key === declaration.key,
        );
        if (id === undefined || matches.length !== 1) {
          validFields = false;
          break;
        }
        if (beforeSaveFieldTypes.has(matches[0]!.type))
          fields.push({
            sourceAlias: declaration.id,
            sourceKey: declaration.key,
            field: matches[0]!,
          });
      }
      const nodeId = currentOwnedIdentity(
        resolution.identities,
        source.key,
        "rule_node",
        `rule:${flow.key}`,
        `task_${task.id}`,
        [`task_${task.id}`],
      );
      const nodes = rule.nodes.filter((entry) => entry.nodeId === nodeId);
      const node = nodes[0];
      if (
        !validFields ||
        fields.length === 0 ||
        new Set(fields.map((entry) => entry.field.fieldId)).size !== fields.length ||
        nodeId === undefined ||
        nodes.length !== 1 ||
        node?.type !== "condition"
      ) {
        unsupported("operand_context_unsupported");
        continue;
      }
      const condition = beforeSaveCommonCondition(node.condition, fields);
      const encoded =
        condition === undefined ? undefined : encodeBeforeSaveCondition(condition, fields);
      if (
        condition === undefined ||
        encoded === undefined ||
        fingerprintCanonicalValue(encoded) !== fingerprintCanonicalValue(task.condition)
      ) {
        unsupported("retained_condition_unsupported");
        continue;
      }
      const binding: Omit<
        ModuleBeforeSaveConditionDraftContext,
        "condition" | "operandBindingFingerprint"
      > = {
        organizationId: candidate.draft.organizationId,
        rootId,
        definitionKey: source.key,
        draftRevision: candidate.draft.draftRevision,
        savedSourceFingerprint: candidate.draft.sourceFingerprint,
        resolutionFingerprint: compiled.output.resolutionFingerprint,
        flow: { alias: flow.id, key: flow.key, flowId },
        trigger: {
          id: trigger.id,
          recordAlias: record.id,
          recordKey: record.key,
          recordTypeId: recordType.data,
          operations: trigger.operations.map((entry) => ({
            kind: entry.kind as "create" | "update",
          })),
          priority: trigger.priority,
        },
        task: { id: task.id, path: ["tasks", index], nodeId },
        fields,
      };
      result.push({
        choice: { ...base, eligible: true },
        context: {
          ...binding,
          condition,
          operandBindingFingerprint: fingerprintModuleBeforeSaveConditionOperandBinding(binding),
        },
      });
    }
  }
  return result;
};
export const beforeSaveSemanticFailures = (
  compiled: CompiledModuleCandidate,
  permissions: PlatformPermissionSource,
): readonly DefinitionRuleFailure[] =>
  ["vortex.definition.module_references", "vortex.definition.module_rule_graphs"].flatMap((id) => {
    const rule = definitionSemanticRules.find((entry) => entry.ruleId === id);
    if (rule === undefined) return refuse("DEFINITION_COMPILATION_REFUSED");
    return rule.run({
      permissions,
      requests: [compiled.request],
      outputs: [compiled.output],
      dependencyOutputs: compiled.dependencyOutputs,
    });
  });
export const compileBeforeSaveState = async (
  ...args: Parameters<typeof compileCurrentModuleQueryFilterState>
) => {
  const state = await compileCurrentModuleQueryFilterState(...args);
  if (state.kind !== "available") return state;
  const failures = beforeSaveSemanticFailures(state.state.compiled, args[2].permissions);
  return failures.length === 0
    ? state
    : {
        kind: "validation_failed" as const,
        validation: moduleValidationFromFailures(
          failures,
          state.state.candidate.draft.source as ModuleSourceDocument,
          args[0].correlationId,
        ),
      };
};
