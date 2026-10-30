import "server-only";

import { randomUUID } from "node:crypto";
import type { JsonValue } from "../catalogue/common";
import { platformIdSchema } from "../catalogue/identifiers";
import { isRecord } from "../catalogue/runtime-primitives";
import {
  requireRequestSavepoint,
  type RequestDatabaseTransaction,
} from "../db/request-transaction";
import { optionsSourceNarrowing } from "../definition/field-options-source";
import type { OptionMembershipCheck } from "./option-membership";
import type { BeforeSaveRuleWarning } from "../rules/before-save-flow-run";
import {
  beforeSaveFlowSetOf,
  beginBeforeSaveRuleExecution,
  type BeforeSaveRuleExecution,
} from "./before-save-rules";
import { operationClock } from "./field-candidate";
import {
  contractError,
  constraintCorrection,
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

/**
 * One named action over up to 200 subjects of one record type. Each subject lists the intents
 * its action composed (subject write or delete, declared creates, relationship copies); the
 * writer verifies every intent is one of them under the action's current authority.
 */
export type NamedRecordCommand = Readonly<{
  action: Readonly<{
    ownerKind: "application" | "module";
    ownerId: string;
    releaseRevision: number;
    actionId: string;
  }>;
  recordTypeId: string;
  subjects: readonly Readonly<{
    recordId: string;
    expectedConcurrencyNumber: number;
    inputs: Readonly<Record<string, JsonValue>>;
    intentIndexes: readonly number[];
    activityId: string;
    declaredOccurrenceIds: readonly string[];
  }>[];
}>;

type Saved = Extract<SaveRecordResult, { outcome: "saved" }>;
type CompletedRecordLifecycle = Readonly<{
  outcome: "deleted" | "restored";
  recordId: string;
  concurrencyNumber: number;
  correlationId: string;
  replayed: boolean;
  unrestoredLinkCount: number;
}>;
type ChangeCommand =
  SaveRecordCommand | Extract<RecordChangeIntent, { operation: "delete" | "restore" }>;
export type RecordChangesResult =
  | Readonly<{
      kind: "completed";
      results: readonly (Saved | CompletedRecordLifecycle)[];
      previous: readonly Readonly<Record<string, unknown>>[];
      warnings: readonly BeforeSaveRuleWarning[];
      recordCount?: number;
      /** Each named subject's result in the order given, through its action's projection. */
      namedResults?: readonly Readonly<Record<string, unknown>>[];
    }>
  | Readonly<{ kind: "restart" }>
  | Readonly<{
      kind: "refused";
      index: number;
      result?: SaveRecordResult;
      reasonCode?: string;
      /** The named subject the refusal names, when the writer refused it as a whole. */
      namedIndex?: number;
    }>;

const completed = (
  value: Record<string, unknown>,
): readonly (Saved | CompletedRecordLifecycle)[] => {
  if (
    !Array.isArray(value.results) ||
    (value.results.length === 0 && !Array.isArray(value.namedResults))
  )
    throw contractError("RECORD_CHANGES_RESULT_INVALID", undefined);
  return value.results.map((entry) => {
    if (!isRecord(entry)) throw contractError("RECORD_CHANGES_RESULT_INVALID", undefined);
    if (entry.outcome === "deleted" || entry.outcome === "restored") {
      const concurrencyNumber = revision(entry.concurrencyNumber);
      if (
        !platformIdSchema.safeParse(entry.recordId).success ||
        !platformIdSchema.safeParse(entry.correlationId).success ||
        concurrencyNumber === undefined ||
        typeof entry.replayed !== "boolean" ||
        typeof entry.unrestoredLinkCount !== "number" ||
        !Number.isSafeInteger(entry.unrestoredLinkCount) ||
        entry.unrestoredLinkCount < 0
      )
        throw contractError("RECORD_CHANGES_LIFECYCLE_RESULT_INVALID", undefined);
      return {
        outcome: entry.outcome,
        recordId: entry.recordId as string,
        concurrencyNumber,
        correlationId: entry.correlationId as string,
        replayed: entry.replayed,
        unrestoredLinkCount: entry.unrestoredLinkCount,
      };
    }
    const result = saveRecordResultSchema.parse({
      contractVersion: "2.0.0",
      outcome: entry.outcome,
      recordId: entry.recordId,
      concurrencyNumber: revision(entry.concurrencyNumber),
      readableValues: entry.values,
      correlationId: entry.correlationId,
      backgroundDelivery: entry.backgroundDelivery,
    });
    if (result.outcome !== "saved") throw contractError("RECORD_CHANGES_RESULT_INVALID", undefined);
    return result;
  });
};

const namedResults = (value: Record<string, unknown>) => {
  if (value.namedResults === undefined) return {};
  if (!Array.isArray(value.namedResults) || !value.namedResults.every(isRecord))
    throw contractError("RECORD_CHANGES_NAMED_RESULT_INVALID", undefined);
  return { namedResults: value.namedResults as readonly Readonly<Record<string, unknown>>[] };
};

const refusal = (value: Record<string, unknown>): RecordChangesResult => ({
  kind: "refused",
  index: typeof value.index === "number" ? value.index : 0,
  ...(typeof value.namedIndex === "number" ? { namedIndex: value.namedIndex } : {}),
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
  named?: NamedRecordCommand,
  optionMember?: OptionMembershipCheck,
): Promise<RecordChangesResult> => {
  if (
    !platformIdSchema.safeParse(commandId).success ||
    intents.length < (named === undefined ? 1 : 0) ||
    intents.length > 200
  )
    return { kind: "refused", index: 0, reasonCode: "command_invalid" };
  const namedArgument = named === undefined ? null : JSON.stringify(named);
  const commands: ChangeCommand[] = [];
  for (const [index, intent] of intents.entries()) {
    if (!("values" in intent)) {
      if (
        !platformIdSchema.safeParse(intent.recordTypeId).success ||
        !platformIdSchema.safeParse(intent.recordId).success ||
        revision(intent.expectedConcurrencyNumber) === undefined
      )
        return { kind: "refused", index, reasonCode: "command_invalid" };
      commands.push(intent);
      continue;
    }
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
    if (!command.success) {
      console.error(
        `[record] change intent ${index} is invalid: ${command.error.issues.map((issue) => `${issue.code}:${issue.path.join(".")}`).join(", ")}`,
      );
      return { kind: "refused", index, reasonCode: "command_invalid" };
    }
    commands.push(command.data);
  }
  const subjects = commands.map((command) => ({
    operation: command.operation,
    recordTypeId: command.recordTypeId,
    recordId: command.operation !== "create" ? command.recordId : null,
    expectedConcurrencyNumber:
      command.operation !== "create" ? command.expectedConcurrencyNumber : null,
    selectedGroupId: command.operation === "create" ? (command.selectedOwnerGroupId ?? null) : null,
    submittedValues: "submittedValues" in command ? command.submittedValues : {},
    finalValues: {} as Readonly<Record<string, unknown>>,
    activityId: randomUUID(),
    occurrenceId: randomUUID(),
  }));
  const preparedRow = one(
    await transaction.query<{ preparation: unknown }>`
    select vortex_record.prepare_record_changes(${commandId}::uuid, ${JSON.stringify(subjects)}::text::jsonb,
      ${namedArgument}::text::jsonb) as preparation
  `,
  ).preparation;
  if (!isRecord(preparedRow)) throw contractError("RECORD_CHANGES_PREPARATION_INVALID", undefined);
  if (preparedRow.outcome === "completed") {
    const results = completed(preparedRow);
    return {
      kind: "completed",
      results,
      previous: results.map(() => ({})),
      warnings: [],
      ...namedResults(preparedRow),
    };
  }
  if (preparedRow.outcome === "restart") return { kind: "restart" };
  if (preparedRow.outcome !== "prepared") {
    console.error(
      `[record] change preparation refused: ${preparedRow.reasonCode ?? preparedRow.outcome}`,
    );
    return refusal(preparedRow);
  }
  if (typeof preparedRow.preview !== "boolean")
    throw contractError("RECORD_CHANGES_PREVIEW_SCOPE_INVALID", undefined);
  // A named action that only announces writes no record: nothing to calculate.
  if (commands.length === 0) return persist(transaction, commandId, [], [], namedArgument, []);
  const preview = preparedRow.preview;
  const parsedGraph = parseRelationshipTotalPreparation(
    preparedRow,
    commands.map((_command, index) => `intent:${index}`),
  );
  if (
    parsedGraph.outcome !== "prepared" ||
    !Array.isArray(preparedRow.subjects) ||
    preparedRow.subjects.length !== commands.length
  )
    throw contractError("RECORD_CHANGES_PREPARATION_INVALID", undefined);
  const preparations = new Map<string, PreparedSave>();
  for (const [index, candidate] of preparedRow.subjects.entries()) {
    if (!isRecord(candidate) || candidate.recordKey !== `intent:${index}`)
      throw contractError("RECORD_CHANGES_SUBJECT_INVALID", undefined);
    const parsed = parsePreparation(candidate);
    if (parsed.outcome !== "prepared")
      throw contractError("RECORD_CHANGES_SUBJECT_INVALID", undefined);
    preparations.set(candidate.recordKey, parsed);
  }
  const graph = {
    ...parsedGraph,
    records: parsedGraph.records.map((record) => ({
      ...record,
      existingValues:
        preparedRow.lifecycleChanges instanceof Array &&
        preparedRow.lifecycleChanges.some(
          (change) => isRecord(change) && change.recordKey === record.recordKey,
        )
          ? record.existingValues
          : (preparations.get(record.recordKey)?.existingValues ?? record.existingValues),
    })),
  };
  const rules = new Map<string, BeforeSaveRuleExecution>();
  for (const record of graph.records) {
    const ruleSet = beforeSaveFlowSetOf(record.beforeSaveFlows, record.recordType.recordTypeId);
    if (ruleSet === undefined) throw contractError("RECORD_CHANGES_RULE_SET_INVALID", undefined);
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
    commands.flatMap((command, index) =>
      "submittedValues" in command ? [[`intent:${index}`, command] as const] : [],
    ),
  );
  if (!Array.isArray(preparedRow.lifecycleChanges))
    throw contractError("RECORD_CHANGES_LIFECYCLE_PREPARATION_INVALID", undefined);
  for (const change of preparedRow.lifecycleChanges) {
    if (
      !isRecord(change) ||
      typeof change.recordKey !== "string" ||
      !isRecord(change.storedValues) ||
      !isRecord(change.submittedValues) ||
      !["update", "delete", "restore"].includes(String(change.operation))
    )
      throw contractError("RECORD_CHANGES_LIFECYCLE_PREPARATION_INVALID", undefined);
    changes.set(
      change.recordKey,
      change.operation === "update"
        ? {
            operation: "update",
            submittedValues: change.submittedValues as Record<string, JsonValue>,
            generatedParent: true,
          }
        : {
            operation: change.operation as "delete" | "restore",
            storedValues: change.storedValues,
          },
    );
  }
  const calculated = calculateLockedRelationshipTotalSave({
    preparation: graph,
    changes,
    rules,
    clock,
    preserveStoredTotals: preview,
    ...(settings?.currency === undefined ? {} : { organizationCurrency: settings.currency }),
  });
  // Permission decisions and dependent link reads use the existing protected
  // readers, composed in one statement for the whole set rather than per row.
  const requests = new Map<string, Readonly<Record<string, unknown>>>();
  if (calculated.success)
    for (const [index, command] of commands.entries()) {
      if (!("submittedValues" in command)) continue;
      const key = `intent:${index}`;
      const values = calculated.records.get(key);
      const prepared = preparations.get(key)!;
      if (values === undefined)
        throw contractError("RECORD_CHANGES_CALCULATED_SUBJECT_MISSING", undefined);
      for (const check of values.pendingChecks)
        if (!preview && check.kind === "choice_permission") {
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
      from pg_catalog.jsonb_array_elements(${JSON.stringify([...requests.values()])}::text::jsonb) as item(value)
    `;
    for (const row of rows) decisions.set(row.key, row.decision);
    if (decisions.size !== requests.size)
      throw contractError("RECORD_CHANGES_CHECKS_INCOMPLETE", undefined);
  }
  const previous = [];
  for (const [index, command] of commands.entries()) {
    const key = `intent:${index}`;
    const prepared = preparations.get(key)!;
    if (!("submittedValues" in command)) {
      if (!calculated.success) {
        console.error(
          `[record] lifecycle calculation refused: ${calculated.issues
            .map((issue) => `${issue.recordKey}:${issue.code}`)
            .join(",")}`,
        );
        const issue = calculated.issues.find((value) => value.requirement !== undefined);
        const affected = graph.records.find((record) => record.recordKey === issue?.recordKey);
        return {
          kind: "refused",
          index,
          reasonCode: "calculation_refused",
          result: safeRefusal(
            prepared.correlationId,
            "operation_refused",
            issue === undefined
              ? undefined
              : affected?.canRead
                ? issue.requirement
                : {
                    code: "related_record_rule_conflict",
                    message: "This change conflicts with a rule on a related record",
                  },
          ),
        };
      }
      previous.push({});
      continue;
    }
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
      preview,
      {
        ...(optionMember === undefined ? {} : { optionMember }),
        choicePermission: async (permissionId) => {
          const decision = decisions.get(`${key}:permission:${permissionId.toLowerCase()}`);
          if (typeof decision !== "boolean")
            throw contractError("RECORD_CHANGES_PERMISSION_INVALID", undefined);
          return decision;
        },
        readRecord: async (recordTypeId, recordId) => {
          const decision = decisions.get(
            `record:${recordTypeId.toLowerCase()}:${recordId.toLowerCase()}`,
          );
          if (!isRecord(decision))
            throw contractError("RECORD_CHANGES_DEPENDENCY_READ_INVALID", undefined);
          if (decision.outcome !== "allowed") return undefined;
          if (!isRecord(decision.values))
            throw contractError("RECORD_CHANGES_DEPENDENCY_VALUES_INVALID", undefined);
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
  if (!calculated.success)
    throw contractError("RECORD_CHANGES_INVALID_CALCULATION_ACCEPTED", undefined);
  const stored = await persist(
    transaction,
    commandId,
    subjects,
    calculated.parentMutations,
    namedArgument,
    commands.map((command, index) =>
      "submittedValues" in command
        ? { command, prepared: preparations.get(`intent:${index}`) }
        : undefined,
    ),
  );
  if (stored.kind !== "completed") return stored;
  const results = stored.results;
  const warnings = graph.records.flatMap((record) => {
    const recordId =
      record.recordId ??
      results[commands.findIndex((_command, index) => record.recordKey === `intent:${index}`)]
        ?.recordId;
    if (recordId === undefined)
      throw contractError("RECORD_CHANGE_WARNING_TARGET_INVALID", undefined);
    return rules.get(record.recordKey)!.warnings.map((warning) =>
      record.canRead
        ? { ...warning, record: { recordTypeId: record.recordType.recordTypeId, recordId } }
        : {
            ...warning,
            code: "related_record_rule_warning",
            message: "This change raised a warning on a related record",
            messageIsLiteral: true,
          },
    );
  });
  return {
    ...stored,
    previous: stored.previous.length === 0 ? previous : stored.previous,
    warnings,
  };
};

/** The one writer call: stores the whole set, or refuses it with the intent it names. */
const persist = async (
  transaction: RequestDatabaseTransaction,
  commandId: string,
  subjects: readonly Readonly<Record<string, unknown>>[],
  parentMutations: readonly unknown[],
  namedArgument: string | null,
  corrections: readonly (
    Readonly<{ command: SaveRecordCommand; prepared: PreparedSave | undefined }> | undefined
  )[],
): Promise<RecordChangesResult> => {
  let stored: unknown;
  try {
    stored = await requireRequestSavepoint(transaction).withSavepoint(
      async (child) =>
        one(
          await child.query<{ result: unknown }>`
    select vortex_record.apply_record_changes(${commandId}::uuid, ${JSON.stringify(subjects)}::text::jsonb,
      ${JSON.stringify(parentMutations)}::text::jsonb, ${namedArgument}::text::jsonb) as result
  `,
        ).result,
    );
  } catch (error) {
    for (const [index, entry] of corrections.entries()) {
      if (entry === undefined) continue;
      const correction = constraintCorrection(error, entry.prepared, entry.command);
      if (correction !== undefined) return { kind: "refused", index, result: correction };
    }
    throw error;
  }
  if (!isRecord(stored)) throw contractError("RECORD_CHANGES_RESULT_INVALID", undefined);
  if (stored.outcome === "restart") return { kind: "restart" };
  if (stored.outcome !== "completed") {
    console.error(`[record] change persistence refused: ${stored.reasonCode ?? stored.outcome}`);
    return refusal(stored);
  }
  const results = completed(stored);
  if (results.length !== subjects.length)
    throw contractError("RECORD_CHANGES_RESULT_COUNT_INVALID", undefined);
  return {
    kind: "completed",
    results,
    // A replay restores nothing for undo: the caller's own changes are already stored.
    previous: stored.replayed === true ? results.map(() => ({})) : [],
    warnings: [],
    ...(typeof stored.recordCount === "number" ? { recordCount: stored.recordCount } : {}),
    ...namedResults(stored),
  };
};
