import "server-only";
import { databaseCode, isRecord } from "../catalogue/runtime-primitives";

import { correlationIdSchema } from "../catalogue/common";
import { recordIdSchema } from "../catalogue/identifiers";
import type { SaveRecordCommand } from "./records";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import {
  calculateLockedRelationshipTotalSave,
  type CalculateRelationshipTotalSaveResult,
  type LockedRelationshipTotalPreparation,
  type RelationshipTotalParentMutation,
} from "./relationship-total-save";
import {
  parseRelationshipTotalPreparation,
  readOrganizationRuntimeSettings,
  revision,
} from "./save-record";
import { operationClock } from "./field-candidate";
import type { JsonValue } from "../catalogue/common";
import type { BeforeSaveRuleWarning } from "../rules/before-save-flow-run";
import {
  beforeSaveRuleRefusedIssueCode,
  beforeSaveRuleUnavailableIssueCode,
  beginBeforeSaveRuleExecution,
  beforeSaveFlowSetOf,
  applyBeforeSaveLifecycleRules,
  type BeforeSaveRuleExecution,
} from "./before-save-rules";

type Row = DatabaseRow & { readonly result: unknown };

type ProtectedRecordLifecycleCommand = Readonly<{
  commandId: string;
  recordTypeId: string;
  recordId: string;
  expectedConcurrencyNumber: number;
  activityId: string;
  occurrenceId: string;
}>;

export type RecordLifecycleRefusalReason =
  | "command_invalid"
  | "command_identity_conflict"
  | "record_unavailable"
  | "restore_closure_changed"
  | "relationship_refused"
  | "calculation_refused"
  | "unsupported_relationship_totals";

type RecordLifecycleConflict = Readonly<{
  outcome: "conflict";
  recordId: string;
  correlationId: string;
  /** Present only when the actor may still act on the record. */
  currentConcurrencyNumber?: number;
}>;

type RecordLifecycleRefusal = Readonly<{
  outcome: "refused";
  recordId: string;
  correlationId: string;
  reason: RecordLifecycleRefusalReason;
  ruleReason?: Readonly<{ code: string; message: string }>;
}>;

export type RecordDeleteResult =
  | Readonly<{
      outcome: "deleted";
      recordId: string;
      concurrencyNumber: number;
      correlationId: string;
      replayed: boolean;
      warnings?: readonly BeforeSaveRuleWarning[];
    }>
  | RecordLifecycleConflict
  | RecordLifecycleRefusal;
export type RecordRestoreResult =
  | Readonly<{
      outcome: "restored";
      recordId: string;
      concurrencyNumber: number;
      correlationId: string;
      replayed: boolean;
      unrestoredLinkCount: number;
      warnings?: readonly BeforeSaveRuleWarning[];
    }>
  | RecordLifecycleConflict
  | RecordLifecycleRefusal;

type CompletedLifecycle = Extract<
  RecordDeleteResult | RecordRestoreResult,
  { outcome: "deleted" | "restored" }
>;

type DatabaseOutcome =
  | Readonly<{ outcome: "completed"; value: CompletedLifecycle }>
  | Readonly<{
      outcome: "prepared";
      preparation: LockedRelationshipTotalPreparation;
      lifecyclePreparation: LockedRelationshipTotalPreparation;
    }>
  | Readonly<{ outcome: "restart" }>
  | Readonly<{ outcome: "conflict"; correlationId: string; currentConcurrencyNumber?: number }>
  | Readonly<{ outcome: "refused"; correlationId: string; reason: RecordLifecycleRefusalReason }>
  | Readonly<{ outcome: "invalid" }>;

const refusalReasons: ReadonlySet<string> = new Set<RecordLifecycleRefusalReason>([
  "command_invalid",
  "command_identity_conflict",
  "record_unavailable",
  "restore_closure_changed",
  "relationship_refused",
  "calculation_refused",
  "unsupported_relationship_totals",
]);

const parseDatabaseOutcome = (candidate: unknown): DatabaseOutcome => {
  if (!isRecord(candidate)) return { outcome: "invalid" };
  const correlation = correlationIdSchema.safeParse(candidate.correlationId);
  const correlationId = correlation.success ? (correlation.data as string) : undefined;
  if (candidate.outcome === "deleted" || candidate.outcome === "restored") {
    const recordId = recordIdSchema.safeParse(candidate.recordId);
    const concurrencyNumber = revision(candidate.concurrencyNumber);
    if (
      !recordId.success ||
      concurrencyNumber === undefined ||
      correlationId === undefined ||
      typeof candidate.replayed !== "boolean" ||
      (candidate.outcome === "restored" &&
        (typeof candidate.unrestoredLinkCount !== "number" ||
          !Number.isSafeInteger(candidate.unrestoredLinkCount) ||
          candidate.unrestoredLinkCount < 0))
    )
      return { outcome: "invalid" };
    return {
      outcome: "completed",
      value: {
        ...(candidate.outcome === "deleted"
          ? { outcome: "deleted" as const }
          : {
              outcome: "restored" as const,
              unrestoredLinkCount: candidate.unrestoredLinkCount as number,
            }),
        recordId: recordId.data as string,
        concurrencyNumber,
        correlationId,
        replayed: candidate.replayed,
      },
    };
  }
  if (candidate.outcome === "prepared") {
    const preparation = parseRelationshipTotalPreparation(candidate);
    const lifecyclePreparation = parseRelationshipTotalPreparation({
      ...candidate,
      records: candidate.lifecycleRecords,
    });
    return preparation.outcome === "prepared" && lifecyclePreparation.outcome === "prepared"
      ? { outcome: "prepared", preparation, lifecyclePreparation }
      : { outcome: "invalid" };
  }
  if (candidate.outcome === "restart") return { outcome: "restart" };
  if (correlationId === undefined) return { outcome: "invalid" };
  if (candidate.outcome === "conflict") {
    const current =
      candidate.concurrencyNumber === undefined ? undefined : revision(candidate.concurrencyNumber);
    return {
      outcome: "conflict",
      correlationId,
      ...(current === undefined ? {} : { currentConcurrencyNumber: current }),
    };
  }
  if (candidate.outcome !== "refused") return { outcome: "invalid" };
  return {
    outcome: "refused",
    correlationId,
    // An unrecognised database refusal never widens into a new public reason.
    reason:
      typeof candidate.reasonCode === "string" && refusalReasons.has(candidate.reasonCode)
        ? (candidate.reasonCode as RecordLifecycleRefusalReason)
        : "record_unavailable",
  };
};

const one = <Value>(rows: readonly Value[]): Value => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error("RECORD_LIFECYCLE_RESULT_INVALID");
  return rows[0];
};

export type Settled<Result> =
  Readonly<{ kind: "restart" }> | Readonly<{ kind: "result"; value: Result }>;

/**
 * Carries the command's settled outcome out of a transaction that must roll
 * back: preparation has claimed a receipt and journaled the locked closure,
 * so every non-final outcome discards the whole transaction.
 */
class RecordLifecycleRollback extends Error {
  constructor(readonly settled: Settled<unknown>) {
    super("RECORD_LIFECYCLE_ROLLBACK");
  }
}

/**
 * How a failed lifecycle step settles its request transaction: a carried
 * outcome, or a restart for a serialization failure or deadlock. Any other
 * error settles nothing and stays unexpected.
 */
export const settleRecordLifecycleError = (error: unknown): Settled<unknown> | undefined => {
  if (error instanceof RecordLifecycleRollback) return error.settled;
  return ["40001", "40P01"].includes(databaseCode(error) ?? "") ? { kind: "restart" } : undefined;
};

/** Rolls back a non-final preflight outcome as its bounded public result. */
const rollBack = (
  outcome: Exclude<DatabaseOutcome, { outcome: "completed" | "prepared" }>,
  recordId: string,
): never => {
  switch (outcome.outcome) {
    case "restart":
      throw new RecordLifecycleRollback({ kind: "restart" });
    case "conflict":
      throw new RecordLifecycleRollback({
        kind: "result",
        value: {
          outcome: "conflict",
          recordId,
          correlationId: outcome.correlationId,
          ...(outcome.currentConcurrencyNumber === undefined
            ? {}
            : { currentConcurrencyNumber: outcome.currentConcurrencyNumber }),
        } satisfies RecordLifecycleConflict,
      });
    case "refused":
      throw new RecordLifecycleRollback({
        kind: "result",
        value: {
          outcome: "refused",
          recordId,
          correlationId: outcome.correlationId,
          reason: outcome.reason,
        } satisfies RecordLifecycleRefusal,
      });
    default:
      throw new Error("RECORD_LIFECYCLE_RESULT_INVALID");
  }
};

const refuseCalculation = (
  recordId: string,
  correlationId: string,
  preparation: LockedRelationshipTotalPreparation,
  issues: readonly Readonly<{
    code: string;
    recordKey: string;
    ruleKey?: string;
    requirement?: Readonly<{ code: string; message: string }>;
  }>[] = [],
): never => {
  console.error(
    `[record] lifecycle totals refused: ${issues.map((issue) => `${issue.recordKey}:${issue.code}${issue.requirement ? `:${issue.requirement.code}` : ""}`).join(",") || "operation_clock_unavailable"}`,
  );
  const ruleIssue = issues.find(
    (issue) => issue.code === beforeSaveRuleRefusedIssueCode || issue.requirement !== undefined,
  );
  const parent = preparation.records.find((record) => record.recordKey === ruleIssue?.recordKey);
  if (ruleIssue !== undefined && parent?.recordId === undefined)
    throw new Error("RELATIONSHIP_TOTAL_PARENT_MISSING");
  if (ruleIssue !== undefined)
    console.error(
      `[record] lifecycle parent rule refused: rule=${ruleIssue.ruleKey ?? (ruleIssue.requirement !== undefined && "ruleKey" in ruleIssue.requirement ? ruleIssue.requirement.ruleKey : "unknown")} parent=${parent?.recordId ?? "unknown"} reason=${ruleIssue.requirement?.code ?? ruleIssue.code}`,
    );
  const ruleReason =
    ruleIssue === undefined
      ? undefined
      : parent?.canRead && ruleIssue.requirement !== undefined
        ? { code: ruleIssue.requirement.code, message: ruleIssue.requirement.message }
        : {
            code: "related_record_rule_conflict",
            message: "This change conflicts with a rule on a related record",
          };
  throw new RecordLifecycleRollback({
    kind: "result",
    value: {
      outcome: "refused",
      recordId,
      correlationId,
      reason: "calculation_refused",
      ...(ruleReason === undefined ? {} : { ruleReason }),
    } satisfies RecordLifecycleRefusal,
  });
};

// A lifecycle change submits no field values: every closure record is
// recalculated from its locked current values and live related records.
const unchangedSubmission: Pick<SaveRecordCommand, "operation" | "submittedValues"> = {
  operation: "update",
  submittedValues: {},
};

type RuntimeSettings = Awaited<ReturnType<typeof readOrganizationRuntimeSettings>>;

const calculateGeneratedValues = (
  preparation: LockedRelationshipTotalPreparation,
  issuedAt: string,
  settings: RuntimeSettings,
  lifecycleRecordKeys: ReadonlySet<string>,
): CalculateRelationshipTotalSaveResult | undefined => {
  const clock = operationClock(
    preparation.records.map((record) => record.recordType),
    issuedAt,
    settings?.timeZone,
  );
  if (clock === undefined) return undefined;
  const rules = new Map<string, BeforeSaveRuleExecution>();
  for (const record of preparation.records) {
    if (lifecycleRecordKeys.has(record.recordKey)) continue;
    const ruleSet = beforeSaveFlowSetOf(record.beforeSaveFlows, record.recordType.recordTypeId);
    if (ruleSet === undefined)
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
    rules.set(record.recordKey, beginBeforeSaveRuleExecution(ruleSet));
  }
  return calculateLockedRelationshipTotalSave({
    command: unchangedSubmission,
    preparation,
    ...(settings?.currency === undefined ? {} : { organizationCurrency: settings.currency }),
    clock,
    rules,
  });
};

/**
 * The protected lifecycle change inside the caller's request transaction:
 * the record writer prepares the proposed closure, the runtime evaluates
 * rules and totals, and the same writer applies its final values. Every
 * non-final outcome throws `RecordLifecycleRollback` so the whole transaction
 * is discarded, including the pending receipt and lifecycle journal.
 * Named actions use the same lifecycle operation.
 */
const performRecordLifecycle = async (
  transaction: RequestDatabaseTransaction,
  issuedAt: string,
  command: ProtectedRecordLifecycleCommand,
  operation: "delete" | "restore",
): Promise<RecordDeleteResult | RecordRestoreResult> => {
  const { activityId, occurrenceId } = command;
  const prepared = parseDatabaseOutcome(
    one(
      await transaction.query<Row>`
        select vortex_record.apply_lifecycle_record_changes(
          ${command.commandId}::uuid,
          ${operation}::text,
          ${command.recordTypeId}::uuid,
          ${command.recordId}::uuid,
          ${command.expectedConcurrencyNumber}::bigint,
          null::jsonb,
          ${activityId}::uuid,
          ${occurrenceId}::uuid
        ) as result
      `,
    ).result,
  );
  if (prepared.outcome === "completed") {
    if (!prepared.value.replayed) throw new Error("RECORD_LIFECYCLE_RESULT_INVALID");
    return prepared.value;
  }
  if (prepared.outcome !== "prepared") return rollBack(prepared, command.recordId);

  const { preparation, lifecyclePreparation } = prepared;
  const root = preparation.records.find((record) => record.recordKey === "root");
  if (root === undefined) throw new Error("RECORD_LIFECYCLE_ROOT_MISSING");
  const settings = await readOrganizationRuntimeSettings(transaction);
  const warnings: BeforeSaveRuleWarning[] = [];
  if (!lifecyclePreparation.records.some((record) => record.recordKey === "root"))
    throw new Error("RECORD_LIFECYCLE_RULE_ROOT_MISSING");
  for (const record of lifecyclePreparation.records) {
    const ruleSet = beforeSaveFlowSetOf(record.beforeSaveFlows, record.recordType.recordTypeId);
    if (ruleSet === undefined)
      return refuseCalculation(command.recordId, preparation.correlationId, lifecyclePreparation, [
        { code: beforeSaveRuleUnavailableIssueCode, recordKey: record.recordKey },
      ]);
    const execution = beginBeforeSaveRuleExecution(ruleSet);
    const rules = applyBeforeSaveLifecycleRules({
      execution,
      recordType: record.recordType,
      operation,
      existingValues: record.existingValues,
      ...(settings?.currency === undefined ? {} : { organizationCurrency: settings.currency }),
    });
    if (!rules.success)
      return refuseCalculation(command.recordId, preparation.correlationId, lifecyclePreparation, [
        rules.reason === "refused"
          ? {
              code: beforeSaveRuleRefusedIssueCode,
              recordKey: record.recordKey,
              ruleKey: rules.ruleKey,
              requirement: { code: rules.code, message: rules.message },
            }
          : { code: beforeSaveRuleUnavailableIssueCode, recordKey: record.recordKey },
      ]);
    warnings.push(
      ...(record.canRead
        ? execution.warnings
        : execution.warnings.map(() => ({
            code: "related_record_rule_warning",
            message: "This change raised a warning on a related record",
          }))),
    );
  }
  let parentMutations: readonly RelationshipTotalParentMutation[] = [];
  // The deleted root is only the evaluator's required anchor; it is never
  // written, so a delete without affected parents needs no calculation.
  if (
    operation === "restore" ||
    preparation.records.some((record) => record.recordKey !== "root")
  ) {
    const calculated = calculateGeneratedValues(
      preparation,
      issuedAt,
      settings,
      new Set(lifecyclePreparation.records.map((record) => record.recordKey)),
    );
    if (calculated === undefined || !calculated.success)
      return refuseCalculation(
        command.recordId,
        preparation.correlationId,
        preparation,
        calculated?.issues,
      );
    parentMutations = calculated.parentMutations;
    if (operation === "restore") {
      if (root.recordId === undefined || root.concurrencyNumber === undefined)
        throw new Error("RECORD_LIFECYCLE_ROOT_MISSING");
      parentMutations = [
        ...parentMutations,
        {
          recordTypeId: root.recordType.recordTypeId,
          recordId: root.recordId,
          expectedConcurrencyNumber: root.concurrencyNumber,
          finalValues: Object.fromEntries(
            root.recordType.fields
              .filter((field) => field.type === "calculation" || field.type === "total")
              .map((field) => [
                field.fieldId,
                Object.hasOwn(calculated.sourceFinalValues, field.fieldId)
                  ? calculated.sourceFinalValues[field.fieldId]!
                  : ((root.existingValues[field.fieldId] ?? null) as JsonValue | null),
              ]),
          ),
        },
      ];
    }
  }

  const finalized = parseDatabaseOutcome(
    one(
      await transaction.query<Row>`
        select vortex_record.apply_lifecycle_record_changes(
          ${command.commandId}::uuid,
          ${operation}::text,
          ${command.recordTypeId}::uuid,
          ${command.recordId}::uuid,
          ${command.expectedConcurrencyNumber}::bigint,
          ${JSON.stringify(parentMutations)}::text::jsonb,
          ${activityId}::uuid,
          ${occurrenceId}::uuid
        ) as result
      `,
    ).result,
  );
  if (finalized.outcome !== "completed" || finalized.value.replayed)
    throw new Error("RECORD_LIFECYCLE_RESULT_INVALID");
  return { ...finalized.value, ...(warnings.length === 0 ? {} : { warnings }) };
};

export const performProtectedRecordDelete = async (
  transaction: RequestDatabaseTransaction,
  issuedAt: string,
  command: ProtectedRecordLifecycleCommand,
): Promise<RecordDeleteResult> => {
  const result = await performRecordLifecycle(transaction, issuedAt, command, "delete");
  if (result.outcome === "restored") throw new Error("RECORD_LIFECYCLE_RESULT_INVALID");
  return result;
};

export const performProtectedRecordRestore = async (
  transaction: RequestDatabaseTransaction,
  issuedAt: string,
  command: ProtectedRecordLifecycleCommand,
): Promise<RecordRestoreResult> => {
  const result = await performRecordLifecycle(transaction, issuedAt, command, "restore");
  if (result.outcome === "deleted") throw new Error("RECORD_LIFECYCLE_RESULT_INVALID");
  return result;
};
