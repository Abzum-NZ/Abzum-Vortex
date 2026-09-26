import {
  recordTypeDefinitionV3Schema,
  type JsonValue,
  type ModuleFieldV3,
  type RecordTypeDefinitionV3,
  type SaveRecordCommandV2,
} from "@vortex/contracts";
import { evaluateRecordCalculationsV2 } from "./calculations";
import {
  finalizeRecordFieldCandidateV2,
  prepareInitialRecordFieldCandidateV2,
  type RecordFieldValuePendingCheck,
  type PrepareRecordFieldValuesV2Result,
} from "./field-values";
import { evaluateRecordTotalsV2 } from "./totals";

export type LockedRelationshipTotalRecord = Readonly<{
  recordKey: string;
  recordId?: string;
  recordType: RecordTypeDefinitionV3;
  concurrencyNumber?: number;
  existingValues: Readonly<Record<string, unknown>>;
  relationshipSources: readonly Readonly<{
    relationshipId: string;
    sourceRecordType: RecordTypeDefinitionV3;
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

export type RelationshipTotalCalculationIssue = Readonly<{
  code: string;
  recordKey: string;
  fieldId?: string;
  path: readonly (string | number)[];
}>;

export type RelationshipTotalParentMutation = Readonly<{
  recordTypeId: string;
  recordId: string;
  expectedConcurrencyNumber: number;
  finalValues: Readonly<Record<string, JsonValue | null>>;
}>;

/** One composed creation evaluated as its own root inside the merged closure. */
export type RelationshipTotalCreationRoot = Readonly<{
  ordinal: number;
  values: Readonly<Record<string, JsonValue | null>>;
}>;

export type CalculateRelationshipTotalSaveResult =
  | Readonly<{
      success: true;
      sourceFinalValues: Readonly<Record<string, JsonValue | null>>;
      creationFinalValues: Readonly<Record<number, Readonly<Record<string, JsonValue | null>>>>;
      creationPendingChecks: Readonly<Record<number, readonly RecordFieldValuePendingCheck[]>>;
      parentMutations: readonly RelationshipTotalParentMutation[];
      pendingChecks: PrepareRecordFieldValuesV2Result extends infer Result
        ? Result extends { success: true; pendingChecks: infer Checks }
          ? Checks
          : never
        : never;
    }>
  | Readonly<{ success: false; issues: readonly RelationshipTotalCalculationIssue[] }>;

/** Record key of creation `ordinal` inside one merged command closure. */
export const creationRecordKey = (ordinal: number) => `create:${ordinal}`;

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

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

const totalDependencies = (field: Extract<ModuleFieldV3, { type: "total" }>) => [
  ...(field.settings.fieldId === undefined ? [] : [field.settings.fieldId]),
  ...dependencyFieldIds(field.settings.filter),
];

const nodeKey = (recordKey: string, fieldId: string) => `${recordKey}:${fieldId}`;

type DerivedField =
  Extract<ModuleFieldV3, { type: "calculation" }> | Extract<ModuleFieldV3, { type: "total" }>;

const derivedFields = (recordType: RecordTypeDefinitionV3) =>
  recordType.fields.filter(
    (field): field is DerivedField => field.type === "calculation" || field.type === "total",
  );

const calculationRecordType = (
  recordType: RecordTypeDefinitionV3,
  targetFieldId: string,
): RecordTypeDefinitionV3 => {
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
  return recordTypeDefinitionV3Schema.parse({
    ...recordType,
    fields: recordType.fields.filter(
      (field) => field.type !== "calculation" || included.has(field.fieldId),
    ),
  });
};

const totalRecordType = (
  recordType: RecordTypeDefinitionV3,
  targetFieldId: string,
): RecordTypeDefinitionV3 =>
  recordTypeDefinitionV3Schema.parse({
    ...recordType,
    fields: recordType.fields.filter(
      (field) => field.type !== "total" || field.fieldId === targetFieldId,
    ),
  });

const issue = (
  recordKey: string,
  value: Readonly<{ code: string; fieldId?: string; path: readonly (string | number)[] }>,
): RelationshipTotalCalculationIssue => ({
  recordKey,
  code: value.code,
  ...(value.fieldId === undefined ? {} : { fieldId: value.fieldId }),
  path: value.path,
});

/**
 * Evaluates one locked concrete dependency graph. The database owns selection,
 * scope and locks; this helper only applies the delivered pure evaluators and
 * final field validation to those authoritative inputs.
 */
export const calculateLockedRelationshipTotalSave = (
  input: Readonly<{
    command: Pick<SaveRecordCommandV2, "operation" | "submittedValues">;
    preparation: LockedRelationshipTotalPreparation;
    creations?: readonly RelationshipTotalCreationRoot[];
    organizationCurrency?: string;
    clock: Readonly<{ instant: string; organizationLocalDate: string }>;
  }>,
): CalculateRelationshipTotalSaveResult => {
  const records = new Map(input.preparation.records.map((record) => [record.recordKey, record]));
  const root = records.get("root");
  if (root === undefined)
    return { success: false, issues: [{ code: "invalid_input", recordKey: "root", path: [] }] };
  // Each composed creation is its own `create` root inside the one merged
  // closure. Locking and evaluating every root together is what keeps a shared
  // total parent authoritative; a second preparation would read the subject's
  // pre-mutation values.
  const creationRoots = new Map(
    (input.creations ?? []).map((creation) => [creationRecordKey(creation.ordinal), creation]),
  );
  if ([...creationRoots.keys()].some((recordKey) => !records.has(recordKey)))
    return { success: false, issues: [{ code: "invalid_input", recordKey: "root", path: [] }] };

  const initialByRecord = new Map<
    string,
    Extract<ReturnType<typeof prepareInitialRecordFieldCandidateV2>, { success: true }>["candidate"]
  >();
  const valuesByRecord = new Map<string, Record<string, JsonValue>>();
  for (const record of records.values()) {
    const creationRoot = creationRoots.get(record.recordKey);
    const operation =
      record.recordKey === "root"
        ? input.command.operation
        : creationRoot !== undefined
          ? ("create" as const)
          : ("update" as const);
    const initial = prepareInitialRecordFieldCandidateV2({
      operation,
      recordType: record.recordType,
      submittedValues:
        record.recordKey === "root" ? input.command.submittedValues : (creationRoot?.values ?? {}),
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
    const values = { ...initial.candidate.candidateValues };
    for (const field of derivedFields(record.recordType)) delete values[field.fieldId];
    valuesByRecord.set(record.recordKey, values);
  }

  const nodes = new Map<string, Readonly<{ recordKey: string; field: DerivedField }>>();
  for (const record of records.values())
    for (const field of derivedFields(record.recordType))
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
      const evaluated = evaluateRecordTotalsV2({
        recordType: totalRecordType(record.recordType, node.field.fieldId),
        relationshipSources: record.relationshipSources.map((source) => ({
          relationshipId: source.relationshipId,
          sourceRecordType: source.sourceRecordType,
          records: source.records.map((related) => ({
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
      if (hasOwn(evaluated.setValues, node.field.fieldId))
        values[node.field.fieldId] = evaluated.setValues[node.field.fieldId]!;
      else delete values[node.field.fieldId];
    } else {
      const evaluationRecordType = calculationRecordType(record.recordType, node.field.fieldId);
      const evaluationFieldIds: ReadonlySet<string> = new Set(
        evaluationRecordType.fields.map((field) => field.fieldId),
      );
      const evaluated = evaluateRecordCalculationsV2({
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
      if (hasOwn(evaluated.setValues, node.field.fieldId))
        values[node.field.fieldId] = evaluated.setValues[node.field.fieldId]!;
      else delete values[node.field.fieldId];
    }
  }

  const finalized = new Map<string, Extract<PrepareRecordFieldValuesV2Result, { success: true }>>();
  for (const record of records.values()) {
    const result = finalizeRecordFieldCandidateV2({
      recordType: record.recordType,
      initialCandidate: initialByRecord.get(record.recordKey)!,
      candidateValues: valuesByRecord.get(record.recordKey)!,
      requiredGeneratedFieldIds: derivedFields(record.recordType).map((field) => field.fieldId),
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

  const source = finalized.get("root")!;
  const sourceFinalValues: Record<string, JsonValue | null> = { ...source.setValues };
  for (const fieldId of source.clearFieldIds) sourceFinalValues[fieldId] = null;
  const creationFinalValues: Record<number, Record<string, JsonValue | null>> = {};
  const creationPendingChecks: Record<number, readonly RecordFieldValuePendingCheck[]> = {};
  for (const [recordKey, creation] of creationRoots) {
    const created = finalized.get(recordKey)!;
    const values: Record<string, JsonValue | null> = { ...created.setValues };
    for (const fieldId of created.clearFieldIds) values[fieldId] = null;
    creationFinalValues[creation.ordinal] = values;
    creationPendingChecks[creation.ordinal] = created.pendingChecks;
  }
  const parentMutations: RelationshipTotalParentMutation[] = [];
  for (const record of records.values()) {
    if (record.recordKey === "root" || creationRoots.has(record.recordKey)) continue;
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
      finalValues[field.fieldId] = hasOwn(result.setValues, field.fieldId)
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
    sourceFinalValues,
    creationFinalValues,
    creationPendingChecks,
    parentMutations,
    pendingChecks: source.pendingChecks,
  };
};
