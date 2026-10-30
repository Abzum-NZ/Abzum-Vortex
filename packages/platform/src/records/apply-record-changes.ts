import "server-only";

import { randomUUID } from "node:crypto";
import type { JsonValue } from "../catalogue/common";
import { platformIdSchema } from "../catalogue/identifiers";
import { isRecord } from "../catalogue/runtime-primitives";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import { optionsSourceNarrowing } from "../definition/field-options-source";
import type { BeforeSaveRuleWarning } from "../rules/before-save-flow-run";
import {
  beforeSaveFlowSetOf,
  beginBeforeSaveRuleExecution,
  type BeforeSaveRuleExecution,
} from "./before-save-rules";
import { operationClock } from "./field-candidate";
import {
  finalizeCalculatedValues,
  one,
  parsePreparation,
  parseRelationshipTotalPreparation,
  readOrganizationRuntimeSettings,
  revision,
  safeRefusal,
  type PreparedSave,
} from "./record-save-preparation";
import {
  saveRecordCommandSchema,
  saveRecordResultSchema,
  type SaveRecordCommand,
  type SaveRecordResult,
} from "./records";
import {
  calculateLockedRelationshipTotalSave,
  type RecordCalculationChange,
} from "./relationship-total-save";

/** One internal intent shape, compiled from a form, a flow or a grid gesture. */
export type RecordChangeIntent =
  | Readonly<{
      operation: "create";
      recordTypeId: string;
      values: Readonly<Record<string, JsonValue>>;
      selectedOwnerGroupId?: string;
    }>
  | Readonly<{
      operation: "update";
      recordTypeId: string;
      recordId: string;
      expectedConcurrencyNumber: number;
      values: Readonly<Record<string, JsonValue>>;
    }>
  | Readonly<{
      operation: "delete" | "restore";
      recordTypeId: string;
      recordId: string;
      expectedConcurrencyNumber: number;
    }>;

type Saved = Extract<SaveRecordResult, { outcome: "saved" }>;
export type RecordChangesResult =
  | Readonly<{
      kind: "completed";
      results: readonly Saved[];
      previous: readonly Readonly<Record<string, unknown>>[];
      warnings: readonly BeforeSaveRuleWarning[];
      recordCount?: number;
    }>
  | Readonly<{ kind: "restart" }>
  | Readonly<{ kind: "refused"; index: number; result?: SaveRecordResult; reasonCode?: string }>;

const completed = (value: Record<string, unknown>): readonly Saved[] => {
  if (!Array.isArray(value.results) || value.results.length === 0)
    throw new Error("RECORD_CHANGES_RESULT_INVALID");
  return value.results.map((entry) => {
    if (!isRecord(entry)) throw new Error("RECORD_CHANGES_RESULT_INVALID");
    const result = saveRecordResultSchema.parse({
      contractVersion: "2.0.0",
      outcome: entry.outcome,
      recordId: entry.recordId,
      concurrencyNumber: revision(entry.concurrencyNumber),
      readableValues: entry.values,
      correlationId: entry.correlationId,
      backgroundDelivery: entry.backgroundDelivery,
    });
    if (result.outcome !== "saved") throw new Error("RECORD_CHANGES_RESULT_INVALID");
    return result;
  });
};

const refusal = (value: Record<string, unknown>): RecordChangesResult => ({
  kind: "refused",
  index: typeof value.index === "number" ? value.index : 0,
  ...(typeof value.reasonCode === "string" ? { reasonCode: value.reasonCode } : {}),
  ...(typeof value.correlationId === "string"
    ? {
        result: safeRefusal(
          value.correlationId,
          value.outcome === "conflict" ? "conflict" : "operation_refused",
          value.reasonCode === "record_change_too_large"
            ? {
                code: value.reasonCode,
                message: "This change affects too many related records. Save fewer rows.",
              }
            : undefined,
        ),
      }
    : {}),
});

/** Runs inside the admitted transaction; the caller rolls back every non-completed result. */
export const applyRecordChanges = async (
  transaction: RequestDatabaseTransaction,
  issuedAt: string,
  commandId: string,
  intents: readonly RecordChangeIntent[],
): Promise<RecordChangesResult> => {
  if (!platformIdSchema.safeParse(commandId).success || intents.length < 1 || intents.length > 200)
    return { kind: "refused", index: 0, reasonCode: "command_invalid" };
  const commands: SaveRecordCommand[] = [];
  for (const [index, intent] of intents.entries()) {
    if (intent.operation !== "create" && intent.operation !== "update")
      return { kind: "refused", index, reasonCode: "operation_unavailable" };
    const command = saveRecordCommandSchema.safeParse({
      contractVersion: "2.0.0",
      commandId,
      operation: intent.operation,
      recordTypeId: intent.recordTypeId,
      submittedValues: intent.values,
      ...(intent.operation === "create"
        ? intent.selectedOwnerGroupId === undefined
          ? {}
          : { selectedOwnerGroupId: intent.selectedOwnerGroupId }
        : {
            recordId: intent.recordId,
            expectedConcurrencyNumber: intent.expectedConcurrencyNumber,
          }),
    });
    if (!command.success) return { kind: "refused", index, reasonCode: "command_invalid" };
    commands.push(command.data);
  }
  const subjects = commands.map((command) => ({
    operation: command.operation,
    recordTypeId: command.recordTypeId,
    recordId: command.operation === "update" ? command.recordId : null,
    expectedConcurrencyNumber:
      command.operation === "update" ? command.expectedConcurrencyNumber : null,
    selectedGroupId: command.operation === "create" ? (command.selectedOwnerGroupId ?? null) : null,
    submittedValues: command.submittedValues,
    finalValues: {} as Readonly<Record<string, unknown>>,
    activityId: randomUUID(),
    occurrenceId: randomUUID(),
  }));
  const preparedRow = one(
    await transaction.query<{ preparation: unknown }>`
    select vortex_record.prepare_record_changes(${commandId}::uuid, ${JSON.stringify(subjects)}::jsonb) as preparation
  `,
  ).preparation;
  if (!isRecord(preparedRow)) throw new Error("RECORD_CHANGES_PREPARATION_INVALID");
  if (preparedRow.outcome === "completed") {
    const results = completed(preparedRow);
    return { kind: "completed", results, previous: results.map(() => ({})), warnings: [] };
  }
  if (preparedRow.outcome === "restart") return { kind: "restart" };
  if (preparedRow.outcome !== "prepared") return refusal(preparedRow);
  const graph = parseRelationshipTotalPreparation(preparedRow);
  if (
    graph.outcome !== "prepared" ||
    !Array.isArray(preparedRow.subjects) ||
    preparedRow.subjects.length !== commands.length
  )
    throw new Error("RECORD_CHANGES_PREPARATION_INVALID");
  const preparations = new Map<string, PreparedSave>();
  for (const [index, candidate] of preparedRow.subjects.entries()) {
    if (!isRecord(candidate) || candidate.recordKey !== `intent:${index}`)
      throw new Error("RECORD_CHANGES_SUBJECT_INVALID");
    const parsed = parsePreparation(candidate);
    if (parsed.outcome !== "prepared") throw new Error("RECORD_CHANGES_SUBJECT_INVALID");
    preparations.set(candidate.recordKey, parsed);
  }
  const rules = new Map<string, BeforeSaveRuleExecution>();
  for (const record of graph.records) {
    const ruleSet = beforeSaveFlowSetOf(record.beforeSaveFlows, record.recordType.recordTypeId);
    if (ruleSet === undefined) throw new Error("RECORD_CHANGES_RULE_SET_INVALID");
    rules.set(record.recordKey, beginBeforeSaveRuleExecution(ruleSet));
  }
  const settings = await readOrganizationRuntimeSettings(transaction);
  const clock = operationClock(
    graph.records.map((record) => record.recordType),
    issuedAt,
    settings?.timeZone,
  );
  if (clock === undefined)
    return refusal({ ...preparedRow, reasonCode: "operation_clock_unavailable" });
  const changes = new Map<string, RecordCalculationChange>(
    commands.map((command, index) => [`intent:${index}`, command]),
  );
  const calculated = calculateLockedRelationshipTotalSave({
    preparation: graph,
    changes,
    rules,
    clock,
    ...(settings?.currency === undefined ? {} : { organizationCurrency: settings.currency }),
  });
  // Permission decisions and dependent link reads use the existing protected
  // readers, composed in one statement for the whole set rather than per row.
  const requests = new Map<string, Readonly<Record<string, unknown>>>();
  if (calculated.success)
    for (const [index, command] of commands.entries()) {
      const key = `intent:${index}`;
      const values = calculated.records.get(key);
      const prepared = preparations.get(key)!;
      if (values === undefined) throw new Error("RECORD_CHANGES_CALCULATED_SUBJECT_MISSING");
      for (const check of values.pendingChecks)
        if (check.kind === "choice_permission") {
          const held = prepared.existingValues[check.fieldId];
          if (
            held === check.optionValue ||
            (Array.isArray(held) && held.includes(check.optionValue))
          )
            continue;
          const requestKey = `${key}:permission:${check.permissionId.toLowerCase()}`;
          requests.set(requestKey, {
            key: requestKey,
            kind: "permission",
            recordTypeId: command.recordTypeId,
            recordId: command.operation === "update" ? command.recordId : null,
            permissionId: check.permissionId,
          });
        }
      const effective = { ...prepared.existingValues, ...values.finalValues };
      for (const field of prepared.recordType.fields) {
        if (
          field.type !== "link" ||
          optionsSourceNarrowing(field.settings.optionsSource) === undefined
        )
          continue;
        const child = effective[field.fieldId];
        if (
          !isRecord(child) ||
          typeof child.recordTypeId !== "string" ||
          typeof child.recordId !== "string"
        )
          continue;
        const requestKey = `record:${child.recordTypeId.toLowerCase()}:${child.recordId.toLowerCase()}`;
        requests.set(requestKey, {
          key: requestKey,
          kind: "record",
          recordTypeId: child.recordTypeId,
          recordId: child.recordId,
        });
      }
    }
  const decisions = new Map<string, unknown>();
  if (requests.size > 0) {
    const rows = await transaction.query<{ key: string; decision: unknown }>`
      select item.value ->> 'key' as key,
        case item.value ->> 'kind' when 'permission' then pg_catalog.to_jsonb(
          vortex_record.decide_choice_option_permission((item.value ->> 'recordTypeId')::uuid,
            (item.value ->> 'permissionId')::uuid, (item.value ->> 'recordId')::uuid))
        else vortex_record.read_record((item.value ->> 'recordTypeId')::uuid,
          (item.value ->> 'recordId')::uuid) -> 'record' end as decision
      from pg_catalog.jsonb_array_elements(${JSON.stringify([...requests.values()])}::jsonb) as item(value)
    `;
    for (const row of rows) decisions.set(row.key, row.decision);
    if (decisions.size !== requests.size) throw new Error("RECORD_CHANGES_CHECKS_INCOMPLETE");
  }
  const previous = [];
  for (const [index, command] of commands.entries()) {
    const key = `intent:${index}`;
    const prepared = preparations.get(key)!;
    const localValues = calculated.success
      ? { ...calculated, records: new Map([["root", calculated.records.get(key)!]]) }
      : {
          ...calculated,
          issues: calculated.issues.map((issue) => ({
            ...issue,
            recordKey: issue.recordKey === key ? "root" : issue.recordKey,
          })),
        };
    const localGraph = {
      ...graph,
      records: graph.records.map((record) => ({
        ...record,
        recordKey: record.recordKey === key ? "root" : record.recordKey,
      })),
    };
    const finalized = await finalizeCalculatedValues(
      transaction,
      command,
      prepared,
      localGraph,
      localValues,
      false,
      {
        choicePermission: async (permissionId) => {
          const decision = decisions.get(`${key}:permission:${permissionId.toLowerCase()}`);
          if (typeof decision !== "boolean") throw new Error("RECORD_CHANGES_PERMISSION_INVALID");
          return decision;
        },
        readRecord: async (recordTypeId, recordId) => {
          const decision = decisions.get(
            `record:${recordTypeId.toLowerCase()}:${recordId.toLowerCase()}`,
          );
          if (!isRecord(decision)) throw new Error("RECORD_CHANGES_DEPENDENCY_READ_INVALID");
          if (decision.outcome !== "allowed") return undefined;
          if (!isRecord(decision.values))
            throw new Error("RECORD_CHANGES_DEPENDENCY_VALUES_INVALID");
          const targetIndex = commands.findIndex(
            (candidate) =>
              candidate.operation === "update" &&
              candidate.recordTypeId.toLowerCase() === recordTypeId.toLowerCase() &&
              candidate.recordId.toLowerCase() === recordId.toLowerCase(),
          );
          if (targetIndex < 0 || !calculated.success) return decision.values;
          const targetKey = `intent:${targetIndex}`;
          const target = preparations.get(targetKey)!;
          const targetValues = calculated.records.get(targetKey)!.finalValues;
          return {
            ...decision.values,
            ...Object.fromEntries(
              Object.entries(targetValues).filter(([fieldId]) =>
                target.readableFieldIds.has(fieldId),
              ),
            ),
          };
        },
      },
    );
    if (!("finalValues" in finalized)) return { kind: "refused", index, result: finalized };
    subjects[index]!.finalValues = finalized.finalValues;
    previous.push(
      Object.fromEntries(
        Object.keys(command.submittedValues)
          .filter((fieldId) => prepared.readableFieldIds.has(fieldId))
          .map((fieldId) => [fieldId, prepared.existingValues[fieldId] ?? null]),
      ),
    );
  }
  if (!calculated.success) throw new Error("RECORD_CHANGES_INVALID_CALCULATION_ACCEPTED");
  const stored = one(
    await transaction.query<{ result: unknown }>`
    select vortex_record.apply_record_changes(${commandId}::uuid, ${JSON.stringify(subjects)}::jsonb,
      ${JSON.stringify(calculated.parentMutations)}::jsonb) as result
  `,
  ).result;
  if (!isRecord(stored)) throw new Error("RECORD_CHANGES_RESULT_INVALID");
  if (stored.outcome === "restart") return { kind: "restart" };
  if (stored.outcome !== "completed") return refusal(stored);
  const results = completed(stored);
  if (results.length !== subjects.length) throw new Error("RECORD_CHANGES_RESULT_COUNT_INVALID");
  const warnings = graph.records.flatMap((record) =>
    rules.get(record.recordKey)!.warnings.map((warning) =>
      record.canRead
        ? warning
        : {
            ...warning,
            code: "related_record_rule_warning",
            message: "This change raised a warning on a related record",
            messageIsLiteral: true,
          },
    ),
  );
  return {
    kind: "completed",
    results,
    previous: stored.replayed === true ? results.map(() => ({})) : previous,
    warnings,
    ...(typeof stored.recordCount === "number" ? { recordCount: stored.recordCount } : {}),
  };
};
