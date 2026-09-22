import "server-only";

import { randomUUID } from "node:crypto";
import {
  activityIdSchema,
  eventOccurrenceIdSchema,
  recordRecoveryEligibilityDecisionSchema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type RecordRecoveryEligibilityDecision,
  type SaveRecordCommandV2,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { deriveEarliestPendingDeadlineTransitionV2 } from "./deadline-transitions";
import {
  calculateLockedRelationshipTotalSave,
  type RelationshipTotalParentMutation,
} from "./relationship-total-save";
import {
  operationClock,
  parseRelationshipTotalPreparation,
  readOrganizationRuntimeSettings,
  type RelationshipTotalPreparationOutcome,
} from "./save-record";

type Row = DatabaseRow & { readonly result: unknown };

export type RecordDeleteCommand = Readonly<{
  commandId: string;
  recordTypeId: string;
  recordId: string;
  expectedConcurrencyNumber: number;
  occurrenceId?: string;
  effectId?: string;
  activityId?: string;
}>;

export type ProtectedParentDeleteCommand = RecordDeleteCommand;

export type RecordRestoreCommand = Readonly<{
  commandId: string;
  recordTypeId: string;
  recordId: string;
  expectedConcurrencyNumber: number;
  recoveryDecision: RecordRecoveryEligibilityDecision;
  occurrenceId?: string;
  effectId?: string;
  activityId?: string;
}>;

export type RecordDeleteResult =
  | Readonly<{
      outcome: "deleted";
      recordId: string;
      concurrencyNumber: number;
      correlationId: string;
      replayed: boolean;
    }>
  | Readonly<{
      outcome: "conflict";
      recordId: string;
      concurrencyNumber: number;
      correlationId?: string;
    }>
  | Readonly<{
      outcome: "refused";
      recordId: string;
      concurrencyNumber: number;
      reason?: string;
      correlationId?: string;
    }>;

export type ProtectedParentDeleteResult = RecordDeleteResult;

export type RecordRestoreResult =
  | Readonly<{
      outcome: "restored";
      recordId: string;
      concurrencyNumber: number;
      correlationId: string;
      replayed: boolean;
    }>
  | Readonly<{
      outcome: "conflict";
      recordId: string;
      concurrencyNumber: number;
      correlationId?: string;
    }>
  | Readonly<{
      outcome: "refused";
      recordId: string;
      concurrencyNumber: number;
      reason?: string;
      governingPolicyRevision?: number | null;
      correlationId?: string;
    }>;

export type PreparedDelete = Extract<
  RelationshipTotalPreparationOutcome,
  { outcome: "prepared" }
>;

export type DeletePreparation =
  | Readonly<{ outcome: "prepared"; preparation: PreparedDelete }>
  | Readonly<{
      outcome: "completed";
      result: Extract<RecordDeleteResult, { outcome: "deleted" }>;
    }>
  | Readonly<{
      outcome: "conflict";
      correlationId?: string;
      concurrencyNumber?: number;
    }>
  | Readonly<{
      outcome: "refused";
      correlationId?: string;
      reasonCode?: string;
      concurrencyNumber?: number;
    }>;

export type RestorePreparation =
  | Readonly<{ outcome: "prepared"; preparation: PreparedDelete }>
  | Readonly<{
      outcome: "completed";
      result: Extract<RecordRestoreResult, { outcome: "restored" }>;
    }>
  | Readonly<{
      outcome: "conflict";
      correlationId?: string;
      concurrencyNumber?: number;
    }>
  | Readonly<{
      outcome: "refused";
      correlationId?: string;
      reasonCode?: string;
      concurrencyNumber?: number;
    }>;

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

const positiveRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const deleteAllowedKeys = new Set([
  "commandId",
  "recordTypeId",
  "recordId",
  "expectedConcurrencyNumber",
  "expectedRevision",
  "occurrenceId",
  "effectId",
  "activityId",
]);

export const parseDeleteCommand = (
  value: unknown,
): RecordDeleteCommand | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.some((key) => !deleteAllowedKeys.has(key))) return undefined;

  const rev =
    candidate.expectedConcurrencyNumber ?? candidate.expectedRevision;
  if (
    !uuid(candidate.commandId) ||
    !uuid(candidate.recordTypeId) ||
    !uuid(candidate.recordId) ||
    !positiveRevision(rev)
  )
    return undefined;

  if (candidate.occurrenceId !== undefined && !uuid(candidate.occurrenceId))
    return undefined;
  if (candidate.effectId !== undefined && !uuid(candidate.effectId))
    return undefined;
  if (candidate.activityId !== undefined && !uuid(candidate.activityId))
    return undefined;

  return {
    commandId: candidate.commandId,
    recordTypeId: candidate.recordTypeId,
    recordId: candidate.recordId,
    expectedConcurrencyNumber: rev,
    ...(candidate.occurrenceId
      ? { occurrenceId: candidate.occurrenceId as string }
      : {}),
    ...(candidate.effectId ? { effectId: candidate.effectId as string } : {}),
    ...(candidate.activityId
      ? { activityId: candidate.activityId as string }
      : {}),
  };
};

const restoreAllowedKeys = new Set([
  "commandId",
  "recordTypeId",
  "recordId",
  "expectedConcurrencyNumber",
  "expectedRevision",
  "occurrenceId",
  "effectId",
  "activityId",
  "recoveryDecision",
]);

export const parseRestoreCommand = (
  value: unknown,
): RecordRestoreCommand | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.some((key) => !restoreAllowedKeys.has(key))) return undefined;

  const rev =
    candidate.expectedConcurrencyNumber ?? candidate.expectedRevision;
  if (
    !uuid(candidate.commandId) ||
    !uuid(candidate.recordTypeId) ||
    !uuid(candidate.recordId) ||
    !positiveRevision(rev)
  )
    return undefined;

  if (candidate.occurrenceId !== undefined && !uuid(candidate.occurrenceId))
    return undefined;
  if (candidate.effectId !== undefined && !uuid(candidate.effectId))
    return undefined;
  if (candidate.activityId !== undefined && !uuid(candidate.activityId))
    return undefined;

  const decision = recordRecoveryEligibilityDecisionSchema.safeParse(
    candidate.recoveryDecision,
  );
  if (!decision.success) return undefined;

  return {
    commandId: candidate.commandId,
    recordTypeId: candidate.recordTypeId,
    recordId: candidate.recordId,
    expectedConcurrencyNumber: rev,
    recoveryDecision: decision.data,
    ...(candidate.occurrenceId
      ? { occurrenceId: candidate.occurrenceId as string }
      : {}),
    ...(candidate.effectId ? { effectId: candidate.effectId as string } : {}),
    ...(candidate.activityId
      ? { activityId: candidate.activityId as string }
      : {}),
  };
};

const one = <Value>(rows: readonly Value[]): Value => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error("RECORD_DELETE_RESULT_INVALID");
  return rows[0];
};

const parseCompletedDelete = (
  candidate: unknown,
): Extract<RecordDeleteResult, { outcome: "deleted" }> | undefined => {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const value = candidate as Record<string, unknown>;
  return value.outcome === "completed" &&
    uuid(value.recordId) &&
    positiveRevision(value.concurrencyNumber) &&
    uuid(value.correlationId)
    ? {
        outcome: "deleted",
        recordId: value.recordId,
        concurrencyNumber: value.concurrencyNumber,
        correlationId: value.correlationId,
        replayed: value.replayed === true,
      }
    : undefined;
};

const parseCompletedRestore = (
  candidate: unknown,
): Extract<RecordRestoreResult, { outcome: "restored" }> | undefined => {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const value = candidate as Record<string, unknown>;
  return value.outcome === "completed" &&
    uuid(value.recordId) &&
    positiveRevision(value.concurrencyNumber) &&
    uuid(value.correlationId)
    ? {
        outcome: "restored",
        recordId: value.recordId,
        concurrencyNumber: value.concurrencyNumber,
        correlationId: value.correlationId,
        replayed: value.replayed === true,
      }
    : undefined;
};

const parseDeletePreparation = (candidate: unknown): DeletePreparation => {
  const completed = parseCompletedDelete(candidate);
  if (completed !== undefined) return { outcome: "completed", result: completed };
  if (typeof candidate === "object" && candidate !== null) {
    const value = candidate as Record<string, unknown>;
    const correlationId =
      typeof value.correlationId === "string" ? value.correlationId : undefined;
    const concurrencyNumber = positiveRevision(value.concurrencyNumber)
      ? value.concurrencyNumber
      : undefined;
    const reasonCode =
      typeof value.reasonCode === "string" ? value.reasonCode : undefined;
    if (value.outcome === "conflict") {
      return { outcome: "conflict", correlationId, concurrencyNumber };
    }
    if (value.outcome === "refused") {
      return { outcome: "refused", correlationId, reasonCode, concurrencyNumber };
    }
  }
  const totals = parseRelationshipTotalPreparation(candidate);
  if (totals.outcome === "prepared")
    return { outcome: "prepared", preparation: totals };
  if (totals.outcome === "conflict")
    return {
      outcome: "conflict",
      ...(totals.correlationId === undefined
        ? {}
        : { correlationId: totals.correlationId }),
    };
  return {
    outcome: "refused",
    ...(totals.correlationId === undefined
      ? {}
      : { correlationId: totals.correlationId }),
  };
};

const parseRestorePreparation = (candidate: unknown): RestorePreparation => {
  const completed = parseCompletedRestore(candidate);
  if (completed !== undefined) return { outcome: "completed", result: completed };
  if (typeof candidate === "object" && candidate !== null) {
    const value = candidate as Record<string, unknown>;
    const correlationId =
      typeof value.correlationId === "string" ? value.correlationId : undefined;
    const concurrencyNumber = positiveRevision(value.concurrencyNumber)
      ? value.concurrencyNumber
      : undefined;
    const reasonCode =
      typeof value.reasonCode === "string" ? value.reasonCode : undefined;
    if (value.outcome === "conflict") {
      return { outcome: "conflict", correlationId, concurrencyNumber };
    }
    if (value.outcome === "refused") {
      return { outcome: "refused", correlationId, reasonCode, concurrencyNumber };
    }
  }
  const totals = parseRelationshipTotalPreparation(candidate);
  if (totals.outcome === "prepared")
    return { outcome: "prepared", preparation: totals };
  if (totals.outcome === "conflict")
    return {
      outcome: "conflict",
      ...(totals.correlationId === undefined
        ? {}
        : { correlationId: totals.correlationId }),
    };
  return {
    outcome: "refused",
    ...(totals.correlationId === undefined
      ? {}
      : { correlationId: totals.correlationId }),
  };
};

class DeleteRollback extends Error {
  constructor(
    readonly correlationId: string | undefined,
    readonly reason: "conflict" | "refused" | "terminal",
    readonly concurrencyNumber?: number,
    readonly refusalReason?: string,
    readonly governingPolicyRevision?: number | null,
    readonly retryable: boolean = false,
  ) {
    super("PROTECTED_RECORD_DELETE_ROLLBACK");
  }
}

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const rollbackFor = (
  error: unknown,
  correlationId?: string,
  expectedConcurrencyNumber?: number,
  governingPolicyRevision?: number | null,
): DeleteRollback => {
  if (error instanceof DeleteRollback) return error;
  const code = databaseCode(error);
  if (code === "40001" || code === "40P01") {
    return new DeleteRollback(
      correlationId,
      "conflict",
      expectedConcurrencyNumber,
      undefined,
      governingPolicyRevision,
      true,
    );
  }
  if (code === "42501") {
    return new DeleteRollback(
      correlationId,
      "refused",
      expectedConcurrencyNumber,
      "operation_refused",
      governingPolicyRevision,
      false,
    );
  }
  return new DeleteRollback(
    correlationId,
    "terminal",
    expectedConcurrencyNumber,
    undefined,
    governingPolicyRevision,
    false,
  );
};

export const prepareProtectedRecordDelete = async (
  transaction: RequestDatabaseTransaction,
  command: RecordDeleteCommand,
  activityId: string,
): Promise<DeletePreparation> => {
  await transaction.query`set local role vortex_runtime`;
  const rows = await transaction.query<Row>`
    select vortex_record.prepare_protected_record_delete(
      ${command.commandId}::uuid,
      ${command.recordTypeId}::uuid,
      ${command.recordId}::uuid,
      ${command.expectedConcurrencyNumber}::bigint,
      ${activityId}::uuid
    ) as result
  `;
  return parseDeletePreparation(one(rows).result);
};

export const prepareProtectedParentDelete = prepareProtectedRecordDelete;

export const finalizeProtectedRecordDelete = async (
  transaction: RequestDatabaseTransaction,
  command: RecordDeleteCommand,
  activityId: string,
  occurrenceId: string,
  parentMutations: readonly RelationshipTotalParentMutation[],
): Promise<Extract<RecordDeleteResult, { outcome: "deleted" }>> => {
  const rows = await transaction.query<Row>`
    select vortex_record.finalize_protected_record_delete(
      ${command.commandId}::uuid,
      ${command.recordTypeId}::uuid,
      ${command.recordId}::uuid,
      ${command.expectedConcurrencyNumber}::bigint,
      ${activityId}::uuid,
      ${occurrenceId}::uuid,
      ${JSON.stringify(parentMutations)}::text::jsonb
    ) as result
  `;
  const result = parseCompletedDelete(one(rows).result);
  if (result === undefined) throw new DeleteRollback(undefined, "refused");
  return { ...result, replayed: false };
};

export const finalizeProtectedParentDelete = finalizeProtectedRecordDelete;

export const prepareProtectedRecordRestore = async (
  transaction: RequestDatabaseTransaction,
  command: RecordRestoreCommand,
  activityId: string,
  policyRevision: number,
): Promise<RestorePreparation> => {
  await transaction.query`set local role vortex_runtime`;
  const rows = await transaction.query<Row>`
    select vortex_record.prepare_protected_record_restore(
      ${command.commandId}::uuid,
      ${command.recordTypeId}::uuid,
      ${command.recordId}::uuid,
      ${command.expectedConcurrencyNumber}::bigint,
      ${activityId}::uuid,
      ${policyRevision}::bigint
    ) as result
  `;
  return parseRestorePreparation(one(rows).result);
};

export const finalizeProtectedRecordRestore = async (
  transaction: RequestDatabaseTransaction,
  command: RecordRestoreCommand,
  activityId: string,
  occurrenceId: string,
  parentMutations: readonly RelationshipTotalParentMutation[],
  rootDueTransition?: Readonly<{ calculationFieldId: string; transitionAt: string }>,
): Promise<Extract<RecordRestoreResult, { outcome: "restored" }>> => {
  const rows = await transaction.query<Row>`
    select vortex_record.finalize_protected_record_restore(
      ${command.commandId}::uuid,
      ${command.recordTypeId}::uuid,
      ${command.recordId}::uuid,
      ${command.expectedConcurrencyNumber}::bigint,
      ${activityId}::uuid,
      ${occurrenceId}::uuid,
      ${JSON.stringify(parentMutations)}::text::jsonb,
      ${rootDueTransition === undefined ? null : JSON.stringify(rootDueTransition)}::text::jsonb
    ) as result
  `;
  const result = parseCompletedRestore(one(rows).result);
  if (result === undefined) throw new DeleteRollback(undefined, "refused");
  return { ...result, replayed: false };
};

const evaluatorCommand = (
  command: RecordDeleteCommand | RecordRestoreCommand,
): SaveRecordCommandV2 =>
  ({
    contractVersion: "2.0.0",
    commandId: command.commandId,
    operation: "update",
    recordTypeId: command.recordTypeId,
    recordId: command.recordId,
    expectedConcurrencyNumber: command.expectedConcurrencyNumber,
    submittedValues: {},
  }) as SaveRecordCommandV2;

export type RecordDeleteServiceDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    activityId?: () => string;
    occurrenceId?: () => string;
  }>;

export type ProtectedParentDeleteServiceDependencies = RecordDeleteServiceDependencies;

export const createRecordDeleteService = (
  dependencies: RecordDeleteServiceDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const newActivityId = dependencies.activityId ?? randomUUID;
  const newOccurrenceId = dependencies.occurrenceId ?? randomUUID;

  const deleteRecord = async (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    commandCandidate: unknown,
  ): Promise<HumanOrganizationRequestResult<RecordDeleteResult>> => {
    const command = parseDeleteCommand(commandCandidate);
    if (command === undefined || selection.applicationRootId === undefined)
      return { kind: "unavailable" };

    let activityId: string;
    let occurrenceId: string | undefined = command.occurrenceId;
    try {
      activityId = activityIdSchema.parse(command.activityId ?? newActivityId());
    } catch {
      return { kind: "temporarily_unavailable" };
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let rolledBack: DeleteRollback | undefined;
      const response = await requests.runChange(
        session,
        selection,
        async (transaction, _scope, issuedAt) => {
          let correlationId: string | undefined;
          try {
            const prepared = await prepareProtectedRecordDelete(
              transaction,
              command,
              activityId,
            );
            if (prepared.outcome === "completed") return prepared.result;
            if (prepared.outcome === "conflict") {
              correlationId = prepared.correlationId;
              throw new DeleteRollback(
                prepared.correlationId,
                "conflict",
                prepared.concurrencyNumber,
                undefined,
                undefined,
                true,
              );
            }
            if (prepared.outcome === "refused") {
              correlationId = prepared.correlationId;
              throw new DeleteRollback(
                prepared.correlationId,
                "refused",
                command.expectedConcurrencyNumber,
                prepared.reasonCode,
              );
            }

            correlationId = prepared.preparation.correlationId;
            const settings = await readOrganizationRuntimeSettings(transaction);
            const clock = operationClock(
              prepared.preparation.records.map((record) => record.recordType),
              issuedAt,
              settings?.timeZone,
            );
            if (clock === undefined)
              throw new DeleteRollback(
                prepared.preparation.correlationId,
                "refused",
                command.expectedConcurrencyNumber,
                "clock_unavailable",
              );

            const calculated = calculateLockedRelationshipTotalSave({
              command: evaluatorCommand(command),
              preparation: prepared.preparation,
              ...(settings?.currency === undefined
                ? {}
                : { organizationCurrency: settings.currency }),
              clock,
            });
            if (!calculated.success || calculated.pendingChecks.length !== 0)
              throw new DeleteRollback(
                prepared.preparation.correlationId,
                "refused",
                command.expectedConcurrencyNumber,
                "calculation_refused",
              );

            occurrenceId ??= eventOccurrenceIdSchema.parse(newOccurrenceId());
            return await finalizeProtectedRecordDelete(
              transaction,
              command,
              activityId,
              occurrenceId,
              calculated.parentMutations,
            );
          } catch (error) {
            rolledBack = rollbackFor(
              error,
              correlationId,
              command.expectedConcurrencyNumber,
            );
            throw error;
          }
        },
      );

      if (rolledBack !== undefined) {
        if (rolledBack.reason === "conflict") {
          if (attempt < 2 && rolledBack.retryable) continue;
          return {
            kind: "available",
            value: {
              outcome: "conflict",
              recordId: command.recordId,
              concurrencyNumber:
                rolledBack.concurrencyNumber ?? command.expectedConcurrencyNumber,
              ...(rolledBack.correlationId
                ? { correlationId: rolledBack.correlationId }
                : {}),
            },
          };
        }
        if (rolledBack.reason === "refused") {
          return {
            kind: "available",
            value: {
              outcome: "refused",
              recordId: command.recordId,
              concurrencyNumber:
                rolledBack.concurrencyNumber ?? command.expectedConcurrencyNumber,
              reason: rolledBack.refusalReason ?? "operation_refused",
              ...(rolledBack.correlationId
                ? { correlationId: rolledBack.correlationId }
                : {}),
            },
          };
        }
        return { kind: "temporarily_unavailable" };
      }

      if (response.kind !== "available") return response;
      return { kind: "available", value: response.value };
    }
    return { kind: "temporarily_unavailable" };
  };

  const restoreRecord = async (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    commandCandidate: unknown,
  ): Promise<HumanOrganizationRequestResult<RecordRestoreResult>> => {
    const command = parseRestoreCommand(commandCandidate);
    if (command === undefined || selection.applicationRootId === undefined)
      return { kind: "unavailable" };

    const decision = command.recoveryDecision;
    if (!decision.allowed) {
      return {
        kind: "available",
        value: {
          outcome: "refused",
          recordId: command.recordId,
          concurrencyNumber: command.expectedConcurrencyNumber,
          reason: decision.reason,
          governingPolicyRevision: decision.governingPolicyRevision,
        },
      };
    }

    let activityId: string;
    let occurrenceId: string | undefined = command.occurrenceId;
    try {
      activityId = activityIdSchema.parse(command.activityId ?? newActivityId());
    } catch {
      return { kind: "temporarily_unavailable" };
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let rolledBack: DeleteRollback | undefined;
      const response = await requests.runChange(
        session,
        selection,
        async (transaction, _scope, issuedAt) => {
          let correlationId: string | undefined;
          try {
            const prepared = await prepareProtectedRecordRestore(
              transaction,
              command,
              activityId,
              decision.governingPolicyRevision,
            );
            if (prepared.outcome === "completed") return prepared.result;
            if (prepared.outcome === "conflict") {
              correlationId = prepared.correlationId;
              throw new DeleteRollback(
                prepared.correlationId,
                "conflict",
                prepared.concurrencyNumber,
                undefined,
                undefined,
                true,
              );
            }
            if (prepared.outcome === "refused") {
              correlationId = prepared.correlationId;
              throw new DeleteRollback(
                prepared.correlationId,
                "refused",
                command.expectedConcurrencyNumber,
                prepared.reasonCode,
                decision.governingPolicyRevision,
              );
            }

            correlationId = prepared.preparation.correlationId;
            const settings = await readOrganizationRuntimeSettings(transaction);
            const clock = operationClock(
              prepared.preparation.records.map((record) => record.recordType),
              issuedAt,
              settings?.timeZone,
            );
            if (clock === undefined)
              throw new DeleteRollback(
                prepared.preparation.correlationId,
                "refused",
                command.expectedConcurrencyNumber,
                "clock_unavailable",
                decision.governingPolicyRevision,
              );

            const calculated = calculateLockedRelationshipTotalSave({
              command: evaluatorCommand(command),
              preparation: prepared.preparation,
              ...(settings?.currency === undefined
                ? {}
                : { organizationCurrency: settings.currency }),
              clock,
            });
            if (!calculated.success || calculated.pendingChecks.length !== 0)
              throw new DeleteRollback(
                prepared.preparation.correlationId,
                "refused",
                command.expectedConcurrencyNumber,
                "calculation_refused",
                decision.governingPolicyRevision,
              );

            const rootRecord = prepared.preparation.records.find(
              (record) => record.recordKey === "root",
            );
            const rootDueTransition =
              rootRecord !== undefined
                ? deriveEarliestPendingDeadlineTransitionV2({
                    recordType: rootRecord.recordType,
                    finalAuthoritativeFieldValues: rootRecord.existingValues,
                    organizationTimeZone: settings?.timeZone ?? "UTC",
                  })
                : undefined;

            occurrenceId ??= eventOccurrenceIdSchema.parse(newOccurrenceId());
            return await finalizeProtectedRecordRestore(
              transaction,
              command,
              activityId,
              occurrenceId,
              calculated.parentMutations,
              rootDueTransition,
            );
          } catch (error) {
            rolledBack = rollbackFor(
              error,
              correlationId,
              command.expectedConcurrencyNumber,
              decision.governingPolicyRevision,
            );
            throw error;
          }
        },
      );

      if (rolledBack !== undefined) {
        if (rolledBack.reason === "conflict") {
          if (attempt < 2 && rolledBack.retryable) continue;
          return {
            kind: "available",
            value: {
              outcome: "conflict",
              recordId: command.recordId,
              concurrencyNumber:
                rolledBack.concurrencyNumber ?? command.expectedConcurrencyNumber,
              ...(rolledBack.correlationId
                ? { correlationId: rolledBack.correlationId }
                : {}),
            },
          };
        }
        if (rolledBack.reason === "refused") {
          return {
            kind: "available",
            value: {
              outcome: "refused",
              recordId: command.recordId,
              concurrencyNumber:
                rolledBack.concurrencyNumber ?? command.expectedConcurrencyNumber,
              reason: rolledBack.refusalReason ?? "operation_refused",
              governingPolicyRevision:
                rolledBack.governingPolicyRevision ??
                decision.governingPolicyRevision,
              ...(rolledBack.correlationId
                ? { correlationId: rolledBack.correlationId }
                : {}),
            },
          };
        }
        return { kind: "temporarily_unavailable" };
      }

      if (response.kind !== "available") return response;
      return { kind: "available", value: response.value };
    }
    return { kind: "temporarily_unavailable" };
  };

  return Object.freeze({
    delete: deleteRecord,
    deleteRecord,
    restore: restoreRecord,
    restoreRecord,
  });
};

export const createProtectedParentDeleteService = createRecordDeleteService;

export const deleteRecord = (
  dependencies: RecordDeleteServiceDependencies,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  commandCandidate: unknown,
): Promise<HumanOrganizationRequestResult<RecordDeleteResult>> =>
  createRecordDeleteService(dependencies).deleteRecord(
    session,
    selection,
    commandCandidate,
  );

export const restoreRecord = (
  dependencies: RecordDeleteServiceDependencies,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  commandCandidate: unknown,
): Promise<HumanOrganizationRequestResult<RecordRestoreResult>> =>
  createRecordDeleteService(dependencies).restoreRecord(
    session,
    selection,
    commandCandidate,
  );
