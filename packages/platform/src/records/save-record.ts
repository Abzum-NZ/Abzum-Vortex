import "server-only";

import {
  createHumanOrganizationRequestService,
  HumanOrganizationRequestRestart,
} from "../access/human-organization-request";
import type { IdentitySession, OrganizationSelectionCandidate } from "../access/identity-access";
import { describeFailure } from "../catalogue/runtime-primitives";
import {
  requireRequestSavepoint,
  type RequestDatabaseTransaction,
} from "../db/request-transaction";
import {
  applyRecordChanges,
  type RecordChangesResult,
  type RecordChangeIntent,
} from "./apply-record-changes";
import { saveRecordCommandSchema, type SaveRecordCommand } from "./records";
import {
  contractError,
  recordBatchSaveMaximum,
  type RecordBatchSaveProblem,
  type RecordBatchSaveResult,
  type RecordBatchSaveSubject,
  type RecordSaveServiceDependencies,
  type RecordSaveServiceResult,
} from "./record-save-preparation";

export { calculateAndFinalize, operationClock } from "./field-candidate";
export {
  parseRelationshipTotalPreparation,
  readOrganizationRuntimeSettings,
  recordBatchSaveMaximum,
  revision,
  type PreparedSave,
  type RecordBatchSaveProblem,
  type RecordBatchSaveResult,
  type RecordBatchSaveSubject,
  type RecordSaveServiceDependencies,
  type RecordSaveServiceResult,
  type RelationshipTotalPreparationOutcome,
} from "./record-save-preparation";

const intentOf = (command: SaveRecordCommand): RecordChangeIntent =>
  command.operation === "create"
    ? {
        operation: "create",
        recordTypeId: command.recordTypeId,
        values: command.submittedValues,
        ...(command.selectedOwnerGroupId === undefined
          ? {}
          : { selectedOwnerGroupId: command.selectedOwnerGroupId }),
      }
    : {
        operation: "update",
        recordTypeId: command.recordTypeId,
        recordId: command.recordId,
        expectedConcurrencyNumber: command.expectedConcurrencyNumber,
        values: command.submittedValues,
      };

/** Forms, admitted flow segments and grid gestures compile into the same record intents. */
export const createRecordSaveService = (dependencies: RecordSaveServiceDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);

  const saveWithinTransaction = async (
    transaction: RequestDatabaseTransaction,
    issuedAt: string,
    command: SaveRecordCommand,
  ): Promise<RecordSaveServiceResult> => {
    const rollback = contractError("RECORD_SAVE_ROLLED_BACK", undefined);
    let settled: RecordChangesResult | undefined;
    try {
      await requireRequestSavepoint(transaction).withSavepoint(async (child) => {
        settled = await applyRecordChanges(child, issuedAt, command.commandId, [intentOf(command)]);
        if (settled.kind !== "completed") throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    if (settled === undefined) throw contractError("RECORD_SAVE_RESULT_MISSING", undefined);
    if (settled.kind === "restart") throw new HumanOrganizationRequestRestart();
    if (settled.kind === "refused") {
      if (settled.result !== undefined) return { kind: "available", value: settled.result };
      console.error(`[record] save refused: ${settled.reasonCode ?? "record_unavailable"}`);
      return { kind: "unavailable" };
    }
    if (settled.results.length !== 1)
      throw contractError("RECORD_SAVE_RESULT_COUNT_INVALID", undefined);
    return {
      kind: "available",
      value: settled.results[0]!,
      ...(settled.warnings.length === 0 ? {} : { warnings: settled.warnings }),
    };
  };

  return Object.freeze({
    async saveInTransaction(
      transaction: RequestDatabaseTransaction,
      issuedAt: string,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<RecordSaveServiceResult> {
      const command = saveRecordCommandSchema.safeParse(commandCandidate);
      if (!command.success || selection.applicationRootId === undefined) {
        console.error(
          `[record] save refused RECORD_SAVE_COMMAND_INVALID: ${command.success ? "no application selected" : describeFailure(command.error)}`,
        );
        return { kind: "unavailable" };
      }
      return saveWithinTransaction(transaction, issuedAt, command.data);
    },

    async save(
      caller: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<RecordSaveServiceResult> {
      const command = saveRecordCommandSchema.safeParse(commandCandidate);
      if (!command.success || selection.applicationRootId === undefined) {
        console.error(
          `[record] save refused RECORD_SAVE_COMMAND_INVALID: ${command.success ? "no application selected" : describeFailure(command.error)}`,
        );
        return { kind: "unavailable" };
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const result = await requests.runChange(
            caller,
            selection,
            (transaction, _scope, issuedAt) =>
              saveWithinTransaction(transaction, issuedAt, command.data),
          );
          return result.kind === "available" ? result.value : result;
        } catch (error) {
          if (!(error instanceof HumanOrganizationRequestRestart)) throw error;
        }
      }
      return { kind: "temporarily_unavailable" };
    },
    /** One grid gesture prepares, calculates and writes its entire set under one receipt. */
    async saveBatch(
      caller: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandId: string,
      recordTypeId: string,
      subjects: readonly RecordBatchSaveSubject[],
    ): Promise<RecordBatchSaveResult> {
      if (
        selection.applicationRootId === undefined ||
        selection.previewInstallationId !== undefined ||
        subjects.length === 0 ||
        subjects.length > recordBatchSaveMaximum
      )
        return { kind: "unavailable" };
      const rollback = new Error("RECORD_BATCH_SAVE_ROLLED_BACK");
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let settled: RecordBatchSaveResult | Readonly<{ kind: "restart" }> | undefined;
        const result = await requests.runChange(
          caller,
          selection,
          async (transaction, _scope, issuedAt) => {
            const changed = await applyRecordChanges(
              transaction,
              issuedAt,
              commandId,
              subjects.map((subject) => ({
                operation: "update",
                recordTypeId,
                recordId: subject.recordId,
                expectedConcurrencyNumber: subject.expectedConcurrencyNumber,
                values: subject.submittedValues,
              })),
            );
            if (changed.kind === "completed")
              return changed.results.map((saved, index) => ({
                recordId: saved.recordId,
                concurrencyNumber: saved.concurrencyNumber,
                previous: changed.previous[index] ?? {},
              }));
            if (changed.kind === "restart") settled = changed;
            else {
              const recordId = subjects[changed.index]?.recordId ?? subjects[0]!.recordId;
              const failure = changed.result;
              const problems: RecordBatchSaveProblem[] =
                failure?.outcome === "correction_required"
                  ? failure.corrections.map((correction) => ({
                      recordId,
                      fieldId: correction.fieldId,
                      reason: correction.code,
                      ...(correction.message === undefined ? {} : { message: correction.message }),
                    }))
                  : [
                      {
                        recordId,
                        reason:
                          failure?.outcome === "refused" && failure.error.code === "conflict"
                            ? "changed"
                            : "refused",
                        ...(failure?.outcome === "refused" &&
                        "reason" in failure.error &&
                        failure.error.reason !== undefined
                          ? { message: failure.error.reason.message }
                          : {}),
                      },
                    ];
              console.error(
                `[record] batch change refused: ${changed.reasonCode ?? failure?.outcome ?? "unknown"}`,
              );
              settled = { kind: "refused", problems };
            }
            throw rollback;
          },
        );
        if (settled?.kind === "restart") continue;
        if (settled !== undefined) return settled;
        if (result.kind !== "available") return result;
        return { kind: "saved", rows: result.value };
      }
      return { kind: "temporarily_unavailable" };
    },
  });
};
