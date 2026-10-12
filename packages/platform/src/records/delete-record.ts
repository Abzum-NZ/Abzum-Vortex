import "server-only";

import {
  correlationIdSchema,
  recordIdSchema,
  type SaveRecordCommand,
} from "../schema";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
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

type Row = DatabaseRow & { readonly result: unknown };

type ProtectedRecordDeleteCommand = Readonly<{
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
}>;

export type RecordDeleteResult =
  | Readonly<{
      outcome: "deleted";
      recordId: string;
      concurrencyNumber: number;
      correlationId: string;
      replayed: boolean;
    }>
  | RecordLifecycleConflict
  | RecordLifecycleRefusal;
type CompletedLifecycle = Readonly<{
  outcome: "deleted";
  recordId: string;
  concurrencyNumber: number;
  correlationId: string;
  replayed: boolean;
}>;

type DatabaseOutcome =
  | Readonly<{ outcome: "completed"; value: CompletedLifecycle }>
  | Readonly<{ outcome: "prepared"; preparation: LockedRelationshipTotalPreparation }>
  | Readonly<{ outcome: "restart" }>
  | Readonly<{ outcome: "conflict"; correlationId: string; currentConcurrencyNumber?: number }>
  | Readonly<{ outcome: "refused"; correlationId: string; reason: RecordLifecycleRefusalReason }>
  | Readonly<{ outcome: "invalid" }>;

const refusalReasons: ReadonlySet<string> = new Set<RecordLifecycleRefusalReason>([
  "command_invalid",
  "command_identity_conflict",
  "record_unavailable",
  "relationship_refused",
  "calculation_refused",
  "unsupported_relationship_totals",
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseDatabaseOutcome = (candidate: unknown): DatabaseOutcome => {
  if (!isPlainObject(candidate)) return { outcome: "invalid" };
  const correlation = correlationIdSchema.safeParse(candidate.correlationId);
  const correlationId = correlation.success ? (correlation.data as string) : undefined;
  if (candidate.outcome === "deleted") {
    const recordId = recordIdSchema.safeParse(candidate.recordId);
    const concurrencyNumber = revision(candidate.concurrencyNumber);
    if (
      !recordId.success ||
      concurrencyNumber === undefined ||
      correlationId === undefined ||
      typeof candidate.replayed !== "boolean"
    )
      return { outcome: "invalid" };
    return {
      outcome: "completed",
      value: {
        outcome: "deleted",
        recordId: recordId.data as string,
        concurrencyNumber,
        correlationId,
        replayed: candidate.replayed,
      },
    };
  }
  if (candidate.outcome === "prepared") {
    const preparation = parseRelationshipTotalPreparation(candidate);
    return preparation.outcome === "prepared"
      ? { outcome: "prepared", preparation }
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
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("RECORD_LIFECYCLE_RESULT_INVALID");
  return rows[0];
};

export type Settled<Result> =
  | Readonly<{ kind: "restart" }>
  | Readonly<{ kind: "result"; value: Result }>;

/**
 * Carries the command's settled outcome out of a transaction that must roll
 * back: a preflight has already deleted rows behind a pending
 * receipt, so every non-final outcome discards the whole transaction.
 */
class RecordLifecycleRollback extends Error {
  constructor(readonly settled: Settled<unknown>) {
    super("RECORD_LIFECYCLE_ROLLBACK");
  }
}

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

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

const refuseCalculation = (recordId: string, correlationId: string): never => {
  throw new RecordLifecycleRollback({
    kind: "result",
    value: {
      outcome: "refused",
      recordId,
      correlationId,
      reason: "calculation_refused",
    } satisfies RecordLifecycleRefusal,
  });
};

// Neither lifecycle operation submits values: every closure record is
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
): Extract<CalculateRelationshipTotalSaveResult, { success: true }> | undefined => {
  const clock = operationClock(
    preparation.records.map((record) => record.recordType),
    issuedAt,
    settings?.timeZone,
  );
  if (clock === undefined) return undefined;
  const calculated = calculateLockedRelationshipTotalSave({
    command: unchangedSubmission,
    preparation,
    ...(settings?.currency === undefined ? {} : { organizationCurrency: settings.currency }),
    clock,
  });
  return calculated.success ? calculated : undefined;
};

/**
 * The protected recoverable delete inside a request transaction the caller
 * already owns: database preflight, runtime total recalculation and terminal
 * writer. Every non-final outcome throws `RecordLifecycleRollback` so the whole
 * transaction is discarded, because the preflight has already deleted rows
 * behind a pending receipt. The named-action `record.delete` task runs
 * this same function, so there is no second delete path.
 */
export const performProtectedRecordDelete = async (
  transaction: RequestDatabaseTransaction,
  issuedAt: string,
  command: ProtectedRecordDeleteCommand,
): Promise<RecordDeleteResult> => {
  const { activityId, occurrenceId } = command;
  await transaction.query`set local role vortex_runtime`;
  const prepared = parseDatabaseOutcome(
    one(
      await transaction.query<Row>`
        select vortex_record.prepare_protected_record_delete(
          ${command.commandId}::uuid,
          ${command.recordTypeId}::uuid,
          ${command.recordId}::uuid,
          ${command.expectedConcurrencyNumber}::bigint,
          ${activityId}::uuid,
          ${occurrenceId}::uuid
        ) as result
      `,
    ).result,
  );
  if (prepared.outcome === "completed") {
    if (!prepared.value.replayed) throw new Error("RECORD_LIFECYCLE_RESULT_INVALID");
    return { ...prepared.value, outcome: "deleted" };
  }
  if (prepared.outcome !== "prepared") return rollBack(prepared, command.recordId);

  const { preparation } = prepared;
  let parentMutations: readonly RelationshipTotalParentMutation[] = [];
  // The deleted root is only the evaluator's required anchor; it is never
  // written, so a delete without affected parents needs no calculation.
  if (preparation.records.some((record) => record.recordKey !== "root")) {
    const settings = await readOrganizationRuntimeSettings(transaction);
    const calculated = calculateGeneratedValues(preparation, issuedAt, settings);
    if (calculated === undefined)
      return refuseCalculation(command.recordId, preparation.correlationId);
    parentMutations = calculated.parentMutations;
  }

  const finalized = parseDatabaseOutcome(
    one(
      await transaction.query<Row>`
        select vortex_record.apply_lifecycle_record_changes(
          ${command.commandId}::uuid,
          'delete'::text,
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
  return { ...finalized.value, outcome: "deleted" };
};
