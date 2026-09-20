import "server-only";

import { randomUUID } from "node:crypto";
import {
  activityIdSchema,
  eventOccurrenceIdSchema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
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
  type RelationshipTotalParentMutation,
} from "./relationship-total-save";
import {
  operationClock,
  parseRelationshipTotalPreparation,
  readOrganizationRuntimeSettings,
  type RelationshipTotalPreparationOutcome,
} from "./save-record";

type Row = DatabaseRow & { readonly result: unknown };

export type ProtectedParentDeleteCommand = Readonly<{
  commandId: string;
  recordTypeId: string;
  recordId: string;
  expectedConcurrencyNumber: number;
}>;

export type ProtectedParentDeleteResult = Readonly<{
  outcome: "deleted";
  recordId: string;
  concurrencyNumber: number;
  correlationId: string;
  replayed: boolean;
}>;

type PreparedDelete = Extract<RelationshipTotalPreparationOutcome, { outcome: "prepared" }>;
type DeletePreparation =
  | Readonly<{ outcome: "prepared"; preparation: PreparedDelete }>
  | Readonly<{ outcome: "completed"; result: ProtectedParentDeleteResult }>
  | Readonly<{ outcome: "conflict" | "refused"; correlationId?: string }>;

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const positiveRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const parseCommand = (value: unknown): ProtectedParentDeleteCommand | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (
    keys.length !== 4 ||
    keys.some((key, index) =>
      key !== ["commandId", "expectedConcurrencyNumber", "recordId", "recordTypeId"][index],
    )
  )
    return undefined;
  return uuid(candidate.commandId) && uuid(candidate.recordTypeId) && uuid(candidate.recordId) &&
    positiveRevision(candidate.expectedConcurrencyNumber)
    ? {
        commandId: candidate.commandId,
        recordTypeId: candidate.recordTypeId,
        recordId: candidate.recordId,
        expectedConcurrencyNumber: candidate.expectedConcurrencyNumber,
      }
    : undefined;
};

const one = <Value>(rows: readonly Value[]): Value => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("RECORD_DELETE_RESULT_INVALID");
  return rows[0];
};

const parseCompleted = (candidate: unknown): ProtectedParentDeleteResult | undefined => {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const value = candidate as Record<string, unknown>;
  return value.outcome === "completed" && uuid(value.recordId) && positiveRevision(value.concurrencyNumber) &&
    uuid(value.correlationId)
    ? {
        outcome: "deleted",
        recordId: value.recordId,
        concurrencyNumber: value.concurrencyNumber,
        correlationId: value.correlationId,
        replayed: true,
      }
    : undefined;
};

const parsePreparation = (candidate: unknown): DeletePreparation => {
  const completed = parseCompleted(candidate);
  if (completed !== undefined) return { outcome: "completed", result: completed };
  const totals = parseRelationshipTotalPreparation(candidate);
  if (totals.outcome === "prepared") return { outcome: "prepared", preparation: totals };
  return {
    outcome: totals.outcome === "conflict" ? "conflict" : "refused",
    ...(totals.correlationId === undefined ? {} : { correlationId: totals.correlationId }),
  };
};

class DeleteRollback extends Error {
  constructor(readonly correlationId: string | undefined, readonly reason: "conflict" | "refused") {
    super("PROTECTED_PARENT_DELETE_ROLLBACK");
  }
}

const prepare = async (
  transaction: RequestDatabaseTransaction,
  command: ProtectedParentDeleteCommand,
  activityId: string,
): Promise<DeletePreparation> => {
  await transaction.query`set local role vortex_runtime`;
  const rows = await transaction.query<Row>`
    select vortex_record.prepare_protected_parent_delete(
      ${command.commandId}::uuid,
      ${command.recordTypeId}::uuid,
      ${command.recordId}::uuid,
      ${command.expectedConcurrencyNumber}::bigint,
      ${activityId}::uuid
    ) as result
  `;
  return parsePreparation(one(rows).result);
};

const finalize = async (
  transaction: RequestDatabaseTransaction,
  command: ProtectedParentDeleteCommand,
  activityId: string,
  occurrenceId: string,
  parentMutations: readonly RelationshipTotalParentMutation[],
): Promise<ProtectedParentDeleteResult> => {
  const rows = await transaction.query<Row>`
    select vortex_record.finalize_protected_parent_delete(
      ${command.commandId}::uuid,
      ${command.recordTypeId}::uuid,
      ${command.recordId}::uuid,
      ${command.expectedConcurrencyNumber}::bigint,
      ${activityId}::uuid,
      ${occurrenceId}::uuid,
      ${JSON.stringify(parentMutations)}::text::jsonb
    ) as result
  `;
  const result = parseCompleted(one(rows).result);
  if (result === undefined) throw new DeleteRollback(undefined, "refused");
  return { ...result, replayed: false };
};

const evaluatorCommand = (command: ProtectedParentDeleteCommand): SaveRecordCommandV2 =>
  ({
    contractVersion: "2.0.0",
    commandId: command.commandId,
    operation: "update",
    recordTypeId: command.recordTypeId,
    recordId: command.recordId,
    expectedConcurrencyNumber: command.expectedConcurrencyNumber,
    submittedValues: {},
  }) as SaveRecordCommandV2;

export type ProtectedParentDeleteServiceDependencies = HumanOrganizationRequestDependencies &
  Readonly<{ activityId?: () => string; occurrenceId?: () => string }>;

/**
 * The delete preparation is deliberately mutating: the journal's deferred
 * completion invariant makes every result after it transactional. Do not turn
 * a post-prepare outcome into a normal callback return; that would commit a
 * pending journal and is rejected by the database at commit.
 */
export const createProtectedParentDeleteService = (
  dependencies: ProtectedParentDeleteServiceDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const newActivityId = dependencies.activityId ?? randomUUID;
  const newOccurrenceId = dependencies.occurrenceId ?? randomUUID;

  return Object.freeze({
    async delete(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<ProtectedParentDeleteResult>> {
      const command = parseCommand(commandCandidate);
      if (command === undefined || selection.applicationRootId === undefined)
        return { kind: "unavailable" };
      let activityId: string;
      let occurrenceId: string | undefined;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch {
        return { kind: "temporarily_unavailable" };
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await requests.runChange(session, selection, async (transaction, _scope, issuedAt) => {
            const prepared = await prepare(transaction, command, activityId);
            if (prepared.outcome === "completed") return prepared.result;
            if (prepared.outcome === "conflict")
              return { outcome: "conflict" as const, correlationId: prepared.correlationId };
            if (prepared.outcome === "refused")
              return { outcome: "refused" as const, correlationId: prepared.correlationId };

            const settings = await readOrganizationRuntimeSettings(transaction);
            const clock = operationClock(
              prepared.preparation.records.map((record) => record.recordType),
              issuedAt,
              settings?.timeZone,
            );
            if (clock === undefined) throw new DeleteRollback(prepared.preparation.correlationId, "refused");
            const calculated = calculateLockedRelationshipTotalSave({
              command: evaluatorCommand(command),
              preparation: prepared.preparation,
              ...(settings?.currency === undefined ? {} : { organizationCurrency: settings.currency }),
              clock,
            });
            if (!calculated.success || calculated.pendingChecks.length !== 0)
              throw new DeleteRollback(prepared.preparation.correlationId, "refused");
            occurrenceId ??= eventOccurrenceIdSchema.parse(newOccurrenceId());
            return finalize(
              transaction,
              command,
              activityId,
              occurrenceId,
              calculated.parentMutations,
            );
          });
          if (response.kind !== "available") return response;
          if (response.value.outcome === "conflict") continue;
          if (response.value.outcome === "refused") return { kind: "unavailable" };
          return { kind: "available", value: response.value };
        } catch (error) {
          if (error instanceof DeleteRollback) {
            if (error.reason === "conflict") continue;
            return { kind: "unavailable" };
          }
          return { kind: "temporarily_unavailable" };
        }
      }
      return { kind: "temporarily_unavailable" };
    },
  });
};
