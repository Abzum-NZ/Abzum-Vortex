import "server-only";

import { randomUUID } from "node:crypto";
import {
  activityIdSchema,
  correlationIdSchema,
  eventOccurrenceIdSchema,
  platformIdSchema,
  recordIdSchema,
  recordRecoveryEligibilityReasonSchema,
  recordTypeIdSchema,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
  type RecordRecoveryEligibilityReason,
  type SaveRecordCommandV2,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  calculateLockedRelationshipTotalSave,
  type CalculateRelationshipTotalSaveResult,
  type LockedRelationshipTotalPreparation,
  type RelationshipTotalParentMutation,
} from "./relationship-total-save";
import {
  operationClock,
  parseRelationshipTotalPreparation,
  readOrganizationRuntimeSettings,
  revision,
} from "./save-record";

type Row = DatabaseRow & { readonly result: unknown };

/**
 * Closed recoverable-delete command. `activityId` and `occurrenceId` are the
 * command's Activity and `deleted` Event identities; the server issues them
 * when the caller does not.
 */
export type RecordDeleteCommand = Readonly<{
  commandId: string;
  recordTypeId: string;
  recordId: string;
  expectedConcurrencyNumber: number;
  activityId?: string;
  occurrenceId?: string;
}>;

/**
 * Closed restore command. Restore appends an Activity but no standard Event,
 * because the installed Event contract has no restore kind.
 */
export type RecordRestoreCommand = Readonly<{
  commandId: string;
  recordTypeId: string;
  recordId: string;
  expectedConcurrencyNumber: number;
  activityId?: string;
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

export type RecordRecoveryRefusal = Readonly<{
  outcome: "refused";
  recordId: string;
  correlationId: string;
  reason: "recovery_ineligible";
  recoveryReason: RecordRecoveryEligibilityReason;
  governingPolicyRevision: number | null;
}>;

export type RecordRestoreResult =
  | Readonly<{
      outcome: "restored";
      recordId: string;
      concurrencyNumber: number;
      correlationId: string;
      replayed: boolean;
    }>
  | RecordLifecycleConflict
  | RecordLifecycleRefusal
  | RecordRecoveryRefusal;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

// The database reports the next revision, so the expected one leaves room for it.
const expectedRevision = (value: unknown): number | undefined =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value < Number.MAX_SAFE_INTEGER
    ? value
    : undefined;

const parseCommandIdentity = (candidate: unknown, allowedKeys: readonly string[]) => {
  if (!isPlainObject(candidate) || Object.keys(candidate).some((key) => !allowedKeys.includes(key)))
    return undefined;
  const commandId = platformIdSchema.safeParse(candidate.commandId);
  const recordTypeId = recordTypeIdSchema.safeParse(candidate.recordTypeId);
  const recordId = recordIdSchema.safeParse(candidate.recordId);
  const expectedConcurrencyNumber = expectedRevision(candidate.expectedConcurrencyNumber);
  const activityId =
    candidate.activityId === undefined ? undefined : activityIdSchema.safeParse(candidate.activityId);
  if (
    !commandId.success ||
    !recordTypeId.success ||
    !recordId.success ||
    expectedConcurrencyNumber === undefined ||
    (activityId !== undefined && !activityId.success)
  )
    return undefined;
  return {
    candidate,
    command: {
      commandId: commandId.data as string,
      recordTypeId: recordTypeId.data as string,
      recordId: recordId.data as string,
      expectedConcurrencyNumber,
      ...(activityId === undefined || !activityId.success
        ? {}
        : { activityId: activityId.data as string }),
    },
  };
};

export const parseRecordDeleteCommand = (candidate: unknown): RecordDeleteCommand | undefined => {
  const parsed = parseCommandIdentity(candidate, [
    "commandId",
    "recordTypeId",
    "recordId",
    "expectedConcurrencyNumber",
    "activityId",
    "occurrenceId",
  ]);
  if (parsed === undefined) return undefined;
  if (parsed.candidate.occurrenceId === undefined) return parsed.command;
  const occurrenceId = eventOccurrenceIdSchema.safeParse(parsed.candidate.occurrenceId);
  return occurrenceId.success
    ? { ...parsed.command, occurrenceId: occurrenceId.data as string }
    : undefined;
};

export const parseRecordRestoreCommand = (candidate: unknown): RecordRestoreCommand | undefined =>
  parseCommandIdentity(candidate, [
    "commandId",
    "recordTypeId",
    "recordId",
    "expectedConcurrencyNumber",
    "activityId",
  ])?.command;

type CompletedLifecycle = Readonly<{
  outcome: "deleted" | "restored";
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
  | Readonly<{
      outcome: "recovery_refused";
      correlationId: string;
      recoveryReason: RecordRecoveryEligibilityReason;
      governingPolicyRevision: number | null;
    }>
  | Readonly<{ outcome: "invalid" }>;

const refusalReasons: ReadonlySet<string> = new Set<RecordLifecycleRefusalReason>([
  "command_invalid",
  "command_identity_conflict",
  "record_unavailable",
  "relationship_refused",
  "calculation_refused",
  "unsupported_relationship_totals",
]);

const parseDatabaseOutcome = (
  candidate: unknown,
  completedOutcome: CompletedLifecycle["outcome"],
): DatabaseOutcome => {
  if (!isPlainObject(candidate)) return { outcome: "invalid" };
  const correlation = correlationIdSchema.safeParse(candidate.correlationId);
  const correlationId = correlation.success ? (correlation.data as string) : undefined;
  if (candidate.outcome === completedOutcome) {
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
        outcome: completedOutcome,
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
  if (candidate.reasonCode === "recovery_ineligible") {
    const recoveryReason = recordRecoveryEligibilityReasonSchema.safeParse(candidate.recoveryReason);
    const governingPolicyRevision =
      candidate.governingPolicyRevision === null || candidate.governingPolicyRevision === undefined
        ? null
        : revision(candidate.governingPolicyRevision);
    return recoveryReason.success && governingPolicyRevision !== undefined
      ? {
          outcome: "recovery_refused",
          correlationId,
          recoveryReason: recoveryReason.data,
          governingPolicyRevision,
        }
      : { outcome: "invalid" };
  }
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
 * back: a preflight has already deleted or restored rows behind a pending
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
    case "recovery_refused":
      throw new RecordLifecycleRollback({
        kind: "result",
        value: {
          outcome: "refused",
          recordId,
          correlationId: outcome.correlationId,
          reason: "recovery_ineligible",
          recoveryReason: outcome.recoveryReason,
          governingPolicyRevision: outcome.governingPolicyRevision,
        } satisfies RecordRecoveryRefusal,
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
const unchangedSubmission: Pick<SaveRecordCommandV2, "operation" | "submittedValues"> = {
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

/** The restored record's complete generated-value mutation at its locked revision. */
const restoredRootMutation = (
  preparation: LockedRelationshipTotalPreparation,
  sourceFinalValues: Readonly<Record<string, JsonValue | null>>,
): RelationshipTotalParentMutation => {
  const root = preparation.records.find((record) => record.recordKey === "root");
  if (root === undefined || root.recordId === undefined || root.concurrencyNumber === undefined)
    throw new Error("RECORD_LIFECYCLE_RESULT_INVALID");
  const finalValues: Record<string, JsonValue | null> = {};
  for (const field of root.recordType.fields) {
    if (field.type !== "calculation" && field.type !== "total") continue;
    const existingValue = root.existingValues[field.fieldId];
    finalValues[field.fieldId] = hasOwn(sourceFinalValues, field.fieldId)
      ? sourceFinalValues[field.fieldId]!
      : existingValue === undefined
        ? null
        : (existingValue as JsonValue);
  }
  return {
    recordTypeId: root.recordType.recordTypeId,
    recordId: root.recordId,
    expectedConcurrencyNumber: root.concurrencyNumber,
    finalValues,
  };
};

/**
 * The protected recoverable delete inside a request transaction the caller
 * already owns: database preflight, runtime total recalculation and terminal
 * writer. Every non-final outcome throws `RecordLifecycleRollback` so the whole
 * transaction is discarded, because the preflight has already deleted rows
 * behind a pending receipt. The named-action `soft_delete_subject` effect runs
 * this same function, so there is no second delete path.
 */
export const performProtectedRecordDelete = async (
  transaction: RequestDatabaseTransaction,
  issuedAt: string,
  command: Required<RecordDeleteCommand>,
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
    "deleted",
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
        select vortex_record.finalize_protected_record_delete(
          ${command.commandId}::uuid,
          ${command.recordTypeId}::uuid,
          ${command.recordId}::uuid,
          ${command.expectedConcurrencyNumber}::bigint,
          ${JSON.stringify(parentMutations)}::text::jsonb
        ) as result
      `,
    ).result,
    "deleted",
  );
  if (finalized.outcome !== "completed" || finalized.value.replayed)
    throw new Error("RECORD_LIFECYCLE_RESULT_INVALID");
  return { ...finalized.value, outcome: "deleted" };
};

export type RecordDeleteServiceDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    activityId?: () => string;
    occurrenceId?: () => string;
  }>;

/**
 * Protected recoverable delete and policy-bound restore. Each command runs as
 * one request transaction: the database preflight mutates and locks behind a
 * pending receipt, the Record runtime recalculates the affected totals, and
 * the terminal writer commits generated values, due metadata, effects and the
 * receipt together. Scope, actor and installation always come from the server.
 */
export const createRecordDeleteService = (dependencies: RecordDeleteServiceDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const newActivityId = dependencies.activityId ?? randomUUID;
  const newOccurrenceId = dependencies.occurrenceId ?? randomUUID;

  const runCommand = async <Result>(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    operation: (transaction: RequestDatabaseTransaction, issuedAt: string) => Promise<Result>,
  ): Promise<HumanOrganizationRequestResult<Result>> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let settled: Settled<Result> | undefined;
      const response = await requests.runChange(
        session,
        selection,
        async (transaction, _scope, issuedAt) => {
          try {
            return await operation(transaction, issuedAt);
          } catch (error) {
            settled = settleRecordLifecycleError(error) as Settled<Result> | undefined;
            throw error;
          }
        },
      );
      if (settled?.kind === "restart") continue;
      if (settled?.kind === "result") return { kind: "available", value: settled.value };
      return response;
    }
    return { kind: "temporarily_unavailable" };
  };

  const deleteRecord = async (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    commandCandidate: unknown,
  ): Promise<HumanOrganizationRequestResult<RecordDeleteResult>> => {
    const command = parseRecordDeleteCommand(commandCandidate);
    if (command === undefined || selection.applicationRootId === undefined)
      return { kind: "unavailable" };
    let activityId: string;
    let occurrenceId: string;
    try {
      activityId = activityIdSchema.parse(command.activityId ?? newActivityId());
      occurrenceId = eventOccurrenceIdSchema.parse(command.occurrenceId ?? newOccurrenceId());
    } catch {
      return { kind: "temporarily_unavailable" };
    }

    return runCommand<RecordDeleteResult>(session, selection, (transaction, issuedAt) =>
      performProtectedRecordDelete(transaction, issuedAt, { ...command, activityId, occurrenceId }),
    );
  };

  /**
   * The recovery decision is made in the database from the locked deleted
   * record: its own deletion time, the stored recoverable-delete policy of its
   * exact target and that policy's recovery window. No caller-supplied
   * decision is accepted, so nothing can be replayed for another record or
   * after the window has closed. A record whose policy has no recovery window
   * is refused rather than treated as recoverable without limit.
   */
  const restoreRecord = async (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    commandCandidate: unknown,
  ): Promise<HumanOrganizationRequestResult<RecordRestoreResult>> => {
    const command = parseRecordRestoreCommand(commandCandidate);
    if (command === undefined || selection.applicationRootId === undefined)
      return { kind: "unavailable" };
    let activityId: string;
    try {
      activityId = activityIdSchema.parse(command.activityId ?? newActivityId());
    } catch {
      return { kind: "temporarily_unavailable" };
    }

    return runCommand<RecordRestoreResult>(session, selection, async (transaction, issuedAt) => {
      await transaction.query`set local role vortex_runtime`;
      const prepared = parseDatabaseOutcome(
        one(
          await transaction.query<Row>`
            select vortex_record.prepare_protected_record_restore(
              ${command.commandId}::uuid,
              ${command.recordTypeId}::uuid,
              ${command.recordId}::uuid,
              ${command.expectedConcurrencyNumber}::bigint,
              ${activityId}::uuid
            ) as result
          `,
        ).result,
        "restored",
      );
      if (prepared.outcome === "completed") {
        if (!prepared.value.replayed) throw new Error("RECORD_LIFECYCLE_RESULT_INVALID");
        return { ...prepared.value, outcome: "restored" };
      }
      if (prepared.outcome !== "prepared") return rollBack(prepared, command.recordId);

      const { preparation } = prepared;
      const settings = await readOrganizationRuntimeSettings(transaction);
      const calculated = calculateGeneratedValues(preparation, issuedAt, settings);
      // Retained links were revalidated by the restore primitive; any other
      // pending check would need a value the restore does not supply.
      if (
        calculated === undefined ||
        calculated.pendingChecks.some((check) => check.kind !== "record_reference")
      )
        return refuseCalculation(command.recordId, preparation.correlationId);
      const mutations = [
        restoredRootMutation(preparation, calculated.sourceFinalValues),
        ...calculated.parentMutations,
      ];
      const mutations = [
        restoredRootMutation(preparation, calculated.sourceFinalValues),
        ...calculated.parentMutations,
      ];

      const finalized = parseDatabaseOutcome(
        one(
          await transaction.query<Row>`
            select vortex_record.finalize_protected_record_restore(
              ${command.commandId}::uuid,
              ${command.recordTypeId}::uuid,
              ${command.recordId}::uuid,
              ${command.expectedConcurrencyNumber}::bigint,
              ${JSON.stringify(mutations)}::text::jsonb
            ) as result
          `,
        ).result,
        "restored",
      );
      if (finalized.outcome !== "completed" || finalized.value.replayed)
        throw new Error("RECORD_LIFECYCLE_RESULT_INVALID");
      return { ...finalized.value, outcome: "restored" };
    });
  };

  return Object.freeze({ deleteRecord, restoreRecord });
};
