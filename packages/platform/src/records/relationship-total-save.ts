import type { JsonValue } from "../catalogue/common";
import {
  recordTypeDefinitionSchema,
  type ModuleField,
  type RecordTypeDefinition,
} from "../definition/module-contracts";
import { evaluateRecordCalculations } from "./calculations";
import {
  finalizeRecordFieldCandidate,
  prepareInitialRecordFieldCandidate,
  type RecordFieldValuePendingCheck,
  type PrepareRecordFieldValuesResult,
} from "./field-values";
import { emptyRecordTotals, evaluateRecordTotals } from "./totals";
import {
  applyBeforeSaveRules,
  applyBeforeSaveLifecycleRules,
  beforeSaveRuleRefusedIssueCode,
  beforeSaveRuleUnavailableIssueCode,
  type BeforeSaveRuleExecution,
} from "./before-save-rules";
import type { RecordFieldValueRequirement } from "./field-values";

type LockedRelationshipTotalRecord = Readonly<{
  recordKey: string;
  recordId?: string;
  recordType: RecordTypeDefinition;
  concurrencyNumber?: number;
  existingValues: Readonly<Record<string, unknown>>;
  canRead: boolean;
  beforeSaveFlows?: unknown;
  relationshipSources: readonly Readonly<{
    relationshipId: string;
    sourceRecordType: RecordTypeDefinition;
    records: readonly Readonly<{
      recordKey?: string;
      fieldValues: Readonly<Record<string, unknown>>;
    }>[];
  }>[];
}>;

export type LockedRelationshipTotalPreparation = Readonly<{
  outcome: "prepared";
  correlationId: string;
  readableFieldIds: readonly string[];
  records: readonly LockedRelationshipTotalRecord[];
}>;

type RelationshipTotalCalculationIssue = Readonly<{
  code: string;
  recordKey: string;
  ruleKey?: string;
  fieldId?: string;
  path: readonly (string | number)[];
  requirement?: Readonly<{ code: string; message: string; ruleKey?: string }>;
}>;

type RelationshipTotalParentMutation = Readonly<{
  recordTypeId: string;
  recordId: string;
  expectedConcurrencyNumber: number;
  finalValues: Readonly<Record<string, JsonValue | null>>;
}>;

/** Explicit operations in the locked graph; other records are generated-value parents. */
export type RecordCalculationChange =
  | Readonly<{
      operation: "create" | "update";
      submittedValues: Readonly<Record<string, JsonValue | null>>;
      /** A closure change persists its generated values with the lifecycle set. */
      generatedParent?: boolean;
    }>
  | Readonly<{
      operation: "delete" | "restore";
      storedValues: Readonly<Record<string, unknown>>;
    }>;

export type CalculateRelationshipTotalSaveResult =
  | Readonly<{
      success: true;
      records: ReadonlyMap<
        string,
        Readonly<{
          finalValues: Readonly<Record<string, JsonValue | null>>;
          pendingChecks: readonly RecordFieldValuePendingCheck[];
        }>
      >;
      parentMutations: readonly RelationshipTotalParentMutation[];
    }>
  | Readonly<{ success: false; issues: readonly RelationshipTotalCalculationIssue[] }>;

const dependencyFieldIds = (candidate: unknown): readonly string[] => {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const object = value as Record<string, unknown>;
    if (object.source === "field" && typeof object.fieldId === "string") found.add(object.fieldId);
    Object.values(object).forEach(visit);
  };
  visit(candidate);
  return [...found];
};

const totalDependencies = (field: Extract<ModuleField, { type: "total" }>) => [
  ...(field.settings.fieldId === undefined ? [] : [field.settings.fieldId]),
  ...dependencyFieldIds(field.settings.filter),
];

const nodeKey = (recordKey: string, fieldId: string) => `${recordKey}:${fieldId}`;

type DerivedField =
  Extract<ModuleField, { type: "calculation" }> | Extract<ModuleField, { type: "total" }>;

const derivedFields = (recordType: RecordTypeDefinition) =>
  recordType.fields.filter(
    (field): field is DerivedField => field.type === "calculation" || field.type === "total",
  );

const calculationRecordType = (
  recordType: RecordTypeDefinition,
  targetFieldId: string,
): RecordTypeDefinition => {
  const included = new Set<string>([targetFieldId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const field of recordType.fields) {
      if (field.type !== "calculation" || !included.has(field.fieldId)) continue;
      for (const dependency of field.settings.dependencyFieldIds) {
        const dependencyField = recordType.fields.find(
          (candidate) => candidate.fieldId === dependency,
        );
        if (dependencyField?.type === "calculation" && !included.has(dependency)) {
          included.add(dependency);
          changed = true;
        }
      }
    }
  }
  return recordTypeDefinitionSchema.parse({
    ...recordType,
    fields: recordType.fields.filter(
      (field) => field.type !== "calculation" || included.has(field.fieldId),
    ),
  });
};

const totalRecordType = (
  recordType: RecordTypeDefinition,
  targetFieldId: string,
): RecordTypeDefinition =>
  recordTypeDefinitionSchema.parse({
    ...recordType,
    fields: recordType.fields.filter(
      (field) => field.type !== "total" || field.fieldId === targetFieldId,
    ),
  });

const issue = (
  recordKey: string,
  value: Readonly<{
    code: string;
    fieldId?: string;
    path: readonly (string | number)[];
    requirement?: Readonly<{ code: string; message: string; ruleKey?: string }>;
  }>,
): RelationshipTotalCalculationIssue => ({
  recordKey,
  code: value.code,
  ...(value.fieldId === undefined ? {} : { fieldId: value.fieldId }),
  path: value.path,
  ...(value.requirement === undefined ? {} : { requirement: value.requirement }),
});

/**
 * Evaluates one locked concrete dependency graph. The database owns selection,
 * scope and locks; this helper only applies the delivered pure evaluators and
 * final field validation to those authoritative inputs.
 */
export const calculateLockedRelationshipTotalSave = (
  input: Readonly<{
    changes: ReadonlyMap<string, RecordCalculationChange>;
    preparation: LockedRelationshipTotalPreparation;
    organizationCurrency?: string;
    clock: Readonly<{ instant: string; organizationLocalDate: string }>;
    rules?: ReadonlyMap<string, BeforeSaveRuleExecution>;
    /** Preview saves keep their stored totals; they never discover live related records. */
    preserveStoredTotals?: boolean;
  }>,
): CalculateRelationshipTotalSaveResult => {
  const records = new Map(input.preparation.records.map((record) => [record.recordKey, record]));
  const calculatedFields = (recordType: RecordTypeDefinition) =>
    derivedFields(recordType).filter(
      (field) => !input.preserveStoredTotals || field.type !== "total",
    );
  const missing = [...input.changes.keys()].find((recordKey) => !records.has(recordKey));
  if (missing !== undefined || records.size === 0)
    return {
      success: false,
      issues: [{ code: "invalid_input", recordKey: missing ?? "", path: [] }],
    };

  const initialByRecord = new Map<
    string,
    Extract<ReturnType<typeof prepareInitialRecordFieldCandidate>, { success: true }>["candidate"]
  >();
  const valuesByRecord = new Map<string, Record<string, JsonValue>>();
  const requirementsByRecord = new Map<string, readonly RecordFieldValueRequirement[]>();
  for (const record of records.values()) {
    const change = input.changes.get(record.recordKey);
    const lifecycle = change?.operation === "delete" || change?.operation === "restore";
    const operation = change?.operation === "create" ? "create" : "update";
    const submittedValues =
      change !== undefined && "submittedValues" in change ? change.submittedValues : {};
    const execution = input.rules?.get(record.recordKey);
    if (
      input.rules !== undefined &&
      execution === undefined &&
      !(change?.operation === "update" && Object.keys(change.submittedValues).length === 0)
    )
      return {
        success: false,
        issues: [
          {
            code: beforeSaveRuleUnavailableIssueCode,
            recordKey: record.recordKey,
            path: ["rules"],
          },
        ],
      };
    if (lifecycle && execution !== undefined) {
      const applied = applyBeforeSaveLifecycleRules({
        execution,
        recordType: record.recordType,
        operation: change.operation,
        existingValues: change.storedValues,
        ...(input.organizationCurrency === undefined
          ? {}
          : { organizationCurrency: input.organizationCurrency }),
      });
      if (!applied.success)
        return {
          success: false,
          issues: [
            {
              code:
                applied.reason === "refused"
                  ? beforeSaveRuleRefusedIssueCode
                  : beforeSaveRuleUnavailableIssueCode,
              recordKey: record.recordKey,
              ...(applied.reason === "refused"
                ? {
                    ruleKey: applied.ruleKey,
                    requirement: { code: applied.code, message: applied.message },
                  }
                : {}),
              ...(applied.reason === "refused" && applied.fieldId !== undefined
                ? { fieldId: applied.fieldId }
                : {}),
              path: ["rules"],
            },
          ],
        };
    }
    if (change?.operation === "delete") continue;
    const initial = prepareInitialRecordFieldCandidate({
      operation,
      recordType: record.recordType,
      submittedValues,
      ...(operation === "create" ? {} : { existingValues: record.existingValues }),
      ...(input.organizationCurrency === undefined
        ? {}
        : { organizationCurrency: input.organizationCurrency }),
    });
    if (!initial.success)
      return {
        success: false,
        issues: initial.issues.map((value) => issue(record.recordKey, value)),
      };
    initialByRecord.set(record.recordKey, initial.candidate);
    let candidateValues = initial.candidate.candidateValues;
    if (execution !== undefined && change !== undefined && !lifecycle) {
      const applied = applyBeforeSaveRules({
        execution,
        recordType: record.recordType,
        initialCandidate: initial.candidate,
        ...(input.organizationCurrency === undefined
          ? {}
          : { organizationCurrency: input.organizationCurrency }),
      });
      if (!applied.success)
        return {
          success: false,
          issues: [
            {
              code:
                applied.reason === "refused"
                  ? beforeSaveRuleRefusedIssueCode
                  : beforeSaveRuleUnavailableIssueCode,
              recordKey: record.recordKey,
              ...(applied.reason === "refused" ? { ruleKey: applied.ruleKey } : {}),
              ...(applied.reason === "refused" && applied.fieldId !== undefined
                ? { fieldId: applied.fieldId }
                : {}),
              ...(applied.reason === "refused"
                ? { requirement: { code: applied.code, message: applied.message } }
                : {}),
              path: ["rules"],
            },
          ],
        };
      // The database selected and locked the closure from the authored links.
      // A rule cannot redirect one after that selection.
      if (
        !input.preserveStoredTotals &&
        record.recordType.fields.some(
          (field) =>
            (field.type === "link" || field.type === "link_to_one_of_several") &&
            JSON.stringify(applied.candidateValues[field.fieldId] ?? null) !==
              JSON.stringify(initial.candidate.candidateValues[field.fieldId] ?? null),
        )
      )
        return {
          success: false,
          issues: [
            {
              code: beforeSaveRuleUnavailableIssueCode,
              recordKey: record.recordKey,
              path: ["rules"],
            },
          ],
        };
      candidateValues = applied.candidateValues;
      requirementsByRecord.set(record.recordKey, applied.requirements);
    }
    const values = {
      ...candidateValues,
      ...(input.preserveStoredTotals && operation === "create"
        ? emptyRecordTotals(record.recordType)
        : {}),
    };
    for (const field of calculatedFields(record.recordType)) delete values[field.fieldId];
    valuesByRecord.set(record.recordKey, values);
  }

  const nodes = new Map<string, Readonly<{ recordKey: string; field: DerivedField }>>();
  for (const record of records.values())
    if (input.changes.get(record.recordKey)?.operation !== "delete")
      for (const field of calculatedFields(record.recordType))
        nodes.set(nodeKey(record.recordKey, field.fieldId), { recordKey: record.recordKey, field });

  const dependencies = new Map<string, Set<string>>();
  for (const [key, node] of nodes) {
    const required = new Set<string>();
    if (node.field.type === "calculation") {
      for (const fieldId of node.field.settings.dependencyFieldIds) {
        const dependency = nodeKey(node.recordKey, fieldId);
        if (nodes.has(dependency)) required.add(dependency);
      }
    } else {
      const record = records.get(node.recordKey)!;
      const totalField = node.field;
      const source = record.relationshipSources.find(
        (candidate) => candidate.relationshipId === totalField.settings.relationshipId,
      );
      for (const related of source?.records ?? []) {
        if (related.recordKey === undefined || !records.has(related.recordKey)) continue;
        for (const fieldId of totalDependencies(totalField)) {
          const dependency = nodeKey(related.recordKey, fieldId);
          if (nodes.has(dependency)) required.add(dependency);
        }
      }
    }
    dependencies.set(key, required);
  }

  const ready: string[] = [...nodes.keys()].filter(
    (key) => (dependencies.get(key)?.size ?? 0) === 0,
  );
  ready.sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    order.push(next);
    for (const [candidate, required] of dependencies) {
      if (!required.delete(next) || required.size !== 0 || order.includes(candidate)) continue;
      if (!ready.includes(candidate)) ready.push(candidate);
    }
    ready.sort();
  }
  if (order.length !== nodes.size) {
    const cyclic = [...nodes.keys()].filter((key) => !order.includes(key)).sort()[0]!;
    const node = nodes.get(cyclic)!;
    return {
      success: false,
      issues: [
        {
          code: "relationship_total_cycle",
          recordKey: node.recordKey,
          fieldId: node.field.fieldId,
          path: ["recordType", "fields", node.field.fieldId],
        },
      ],
    };
  }

  for (const key of order) {
    const node = nodes.get(key)!;
    const record = records.get(node.recordKey)!;
    const values = valuesByRecord.get(node.recordKey)!;
    if (node.field.type === "total") {
      const evaluated = evaluateRecordTotals({
        recordType: totalRecordType(record.recordType, node.field.fieldId),
        relationshipSources: record.relationshipSources.map((source) => ({
          relationshipId: source.relationshipId,
          sourceRecordType: source.sourceRecordType,
          records: source.records
            .filter(
              (related) =>
                related.recordKey === undefined ||
                input.changes.get(related.recordKey)?.operation !== "delete",
            )
            .map((related) => ({
              fieldValues:
                related.recordKey === undefined
                  ? related.fieldValues
                  : (valuesByRecord.get(related.recordKey) ?? related.fieldValues),
            })),
        })),
      });
      if (!evaluated.success)
        return {
          success: false,
          issues: evaluated.issues.map((value) => issue(node.recordKey, value)),
        };
      if (Object.hasOwn(evaluated.setValues, node.field.fieldId))
        values[node.field.fieldId] = evaluated.setValues[node.field.fieldId]!;
      else delete values[node.field.fieldId];
    } else {
      const evaluationRecordType = calculationRecordType(record.recordType, node.field.fieldId);
      const evaluationFieldIds: ReadonlySet<string> = new Set(
        evaluationRecordType.fields.map((field) => field.fieldId),
      );
      const evaluated = evaluateRecordCalculations({
        recordType: evaluationRecordType,
        authoritativeFieldValues: Object.fromEntries(
          Object.entries(values).filter(([fieldId]) => evaluationFieldIds.has(fieldId)),
        ),
        clock: input.clock,
      });
      if (!evaluated.success)
        return {
          success: false,
          issues: evaluated.issues.map((value) => issue(node.recordKey, value)),
        };
      if (Object.hasOwn(evaluated.setValues, node.field.fieldId))
        values[node.field.fieldId] = evaluated.setValues[node.field.fieldId]!;
      else delete values[node.field.fieldId];
    }
  }

  // Parent rules see the newly calculated totals. Their requirements are then
  // checked by the same field finalizer as root requirements.
  for (const record of records.values()) {
    if (input.changes.has(record.recordKey)) continue;
    const execution = input.rules?.get(record.recordKey);
    if (execution === undefined) continue;
    const proposedValues = valuesByRecord.get(record.recordKey)!;
    const applied = applyBeforeSaveRules({
      execution,
      recordType: record.recordType,
      initialCandidate: {
        ...initialByRecord.get(record.recordKey)!,
        candidateValues: proposedValues,
      },
      ...(input.organizationCurrency === undefined
        ? {}
        : { organizationCurrency: input.organizationCurrency }),
    });
    if (!applied.success)
      return {
        success: false,
        issues: [
          {
            code:
              applied.reason === "refused"
                ? beforeSaveRuleRefusedIssueCode
                : beforeSaveRuleUnavailableIssueCode,
            recordKey: record.recordKey,
            ...(applied.reason === "refused" ? { ruleKey: applied.ruleKey } : {}),
            ...(applied.reason === "refused" && applied.fieldId !== undefined
              ? { fieldId: applied.fieldId }
              : {}),
            ...(applied.reason === "refused"
              ? { requirement: { code: applied.code, message: applied.message } }
              : {}),
            path: ["rules"],
          },
        ],
      };
    if (
      [...new Set([...Object.keys(proposedValues), ...Object.keys(applied.candidateValues)])].some(
        (fieldId) =>
          JSON.stringify(applied.candidateValues[fieldId] ?? null) !==
          JSON.stringify(proposedValues[fieldId] ?? null),
      )
    )
      return {
        success: false,
        issues: [
          {
            code: beforeSaveRuleUnavailableIssueCode,
            recordKey: record.recordKey,
            path: ["rules"],
          },
        ],
      };
    requirementsByRecord.set(record.recordKey, applied.requirements);
  }

  const finalized = new Map<string, Extract<PrepareRecordFieldValuesResult, { success: true }>>();
  for (const record of records.values()) {
    if (input.changes.get(record.recordKey)?.operation === "delete") continue;
    const result = finalizeRecordFieldCandidate({
      recordType: record.recordType,
      initialCandidate: initialByRecord.get(record.recordKey)!,
      candidateValues: valuesByRecord.get(record.recordKey)!,
      requirements: requirementsByRecord.get(record.recordKey) ?? [],
      requiredGeneratedFieldIds: calculatedFields(record.recordType).map((field) => field.fieldId),
      ...(input.organizationCurrency === undefined
        ? {}
        : { organizationCurrency: input.organizationCurrency }),
    });
    if (!result.success)
      return {
        success: false,
        issues: result.issues.map((value) => issue(record.recordKey, value)),
      };
    finalized.set(record.recordKey, result);
  }

  const calculatedRecords = new Map<
    string,
    Readonly<{
      finalValues: Readonly<Record<string, JsonValue | null>>;
      pendingChecks: readonly RecordFieldValuePendingCheck[];
    }>
  >();
  for (const [recordKey, result] of finalized) {
    const finalValues: Record<string, JsonValue | null> = { ...result.setValues };
    for (const fieldId of result.clearFieldIds) finalValues[fieldId] = null;
    calculatedRecords.set(recordKey, { finalValues, pendingChecks: result.pendingChecks });
  }
  const parentMutations: RelationshipTotalParentMutation[] = [];
  for (const record of records.values()) {
    const change = input.changes.get(record.recordKey);
    if (
      change !== undefined &&
      change.operation !== "restore" &&
      !("generatedParent" in change && change.generatedParent)
    )
      continue;
    if (
      record.recordId === undefined ||
      record.concurrencyNumber === undefined ||
      !Number.isSafeInteger(record.concurrencyNumber)
    )
      return {
        success: false,
        issues: [{ code: "invalid_input", recordKey: record.recordKey, path: [] }],
      };
    const result = finalized.get(record.recordKey)!;
    const finalValues: Record<string, JsonValue | null> = {};
    for (const field of derivedFields(record.recordType)) {
      const existingValue = record.existingValues[field.fieldId];
      finalValues[field.fieldId] = Object.hasOwn(result.setValues, field.fieldId)
        ? result.setValues[field.fieldId]!
        : result.clearFieldIds.includes(field.fieldId)
          ? null
          : existingValue === undefined
            ? null
            : (existingValue as JsonValue);
    }
    parentMutations.push({
      recordTypeId: record.recordType.recordTypeId,
      recordId: record.recordId,
      expectedConcurrencyNumber: record.concurrencyNumber,
      finalValues,
    });
  }
  return {
    success: true,
    records: calculatedRecords,
    parentMutations,
  };
};
