import "server-only";
import { databaseCode } from "../catalogue/runtime-primitives";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import type { BeforeSaveRuleWarning } from "../rules/before-save-flow-run";
import { applyRecordChanges } from "./apply-record-changes";

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

/** Lifecycle callers compile into the same command and calculation graph as saves. */
const performRecordLifecycle = async (
  transaction: RequestDatabaseTransaction,
  issuedAt: string,
  command: ProtectedRecordLifecycleCommand,
  operation: "delete" | "restore",
): Promise<RecordDeleteResult | RecordRestoreResult> => {
  const result = await applyRecordChanges(transaction, issuedAt, command.commandId, [
    {
      operation,
      recordTypeId: command.recordTypeId,
      recordId: command.recordId,
      expectedConcurrencyNumber: command.expectedConcurrencyNumber,
    },
  ]);
  if (result.kind === "restart") throw new RecordLifecycleRollback({ kind: "restart" });
  if (result.kind === "refused") {
    const failure = result.result;
    if (failure === undefined) throw new Error("RECORD_LIFECYCLE_RESULT_INVALID");
    const correlationId =
      failure.outcome === "refused" ? failure.error.correlationId : failure.correlationId;
    const ruleReason =
      failure.outcome === "refused" && "reason" in failure.error ? failure.error.reason : undefined;
    const value: RecordDeleteResult =
      failure.outcome === "refused" && failure.error.code === "conflict"
        ? { outcome: "conflict", recordId: command.recordId, correlationId }
        : {
            outcome: "refused",
            recordId: command.recordId,
            correlationId,
            reason:
              result.reasonCode === "calculation_refused"
                ? "calculation_refused"
                : "record_unavailable",
            ...(ruleReason === undefined ? {} : { ruleReason }),
          };
    throw new RecordLifecycleRollback({ kind: "result", value });
  }
  const changed = result.results[0];
  if (
    result.results.length !== 1 ||
    changed === undefined ||
    changed.outcome !== (operation === "delete" ? "deleted" : "restored")
  )
    throw new Error("RECORD_LIFECYCLE_RESULT_INVALID");
  return { ...changed, ...(result.warnings.length === 0 ? {} : { warnings: result.warnings }) };
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
