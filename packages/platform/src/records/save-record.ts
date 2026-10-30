import "server-only";
import { applyRecordChanges } from "./apply-record-changes";

import { randomUUID } from "node:crypto";
import {
  createHumanOrganizationRequestService,
  HumanOrganizationRequestRestart,
} from "../access/human-organization-request";
import type { IdentitySession, OrganizationSelectionCandidate } from "../access/identity-access";
import { activityIdSchema, eventOccurrenceIdSchema } from "../catalogue/identifiers";
import { describeFailure } from "../catalogue/runtime-primitives";
import {
  requireRequestSavepoint,
  type RequestDatabaseTransaction,
} from "../db/request-transaction";
import {
  beforeSaveFlowSetOf,
  beginBeforeSaveRuleExecution,
  type BeforeSaveRuleExecution,
} from "./before-save-rules";
import { calculateAndFinalize, operationClock } from "./field-candidate";
import {
  saveRecordCommandSchema,
  saveRecordResultSchema,
  type SaveRecordCommand,
  type SaveRecordResult,
} from "./records";
import { calculateLockedRelationshipTotalSave } from "./relationship-total-save";
export { calculateAndFinalize, operationClock };

import {
  constraintCorrection,
  contractError,
  finalizeCalculatedValues,
  persist,
  prepare,
  prepareRelationshipTotals,
  readOrganizationRuntimeSettings,
  recordBatchSaveMaximum,
  recordedRefusal,
  restartRelationshipTotalSave,
  revision,
  safeRefusal,
  type PreparationOutcome,
  type PreparedSave,
  type RecordBatchSaveProblem,
  type RecordBatchSaveResult,
  type RecordBatchSaveSubject,
  type RecordSaveServiceDependencies,
  type RecordSaveServiceResult,
} from "./record-save-preparation";
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

/**
 * The ordinary-human base save. Every caller supplies the same closed command;
 * all scope, actor, installation and generated facts come from the server.
 */
export const createRecordSaveService = (dependencies: RecordSaveServiceDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const newActivityId = dependencies.activityId ?? randomUUID;
  const newOccurrenceId = dependencies.occurrenceId ?? randomUUID;

  const saveWithinTransaction = async (
    transaction: RequestDatabaseTransaction,
    issuedAt: string,
    command: SaveRecordCommand,
    preview: boolean,
    activityId: string,
    identity: { occurrenceId: string | undefined },
    attempted: { rules?: BeforeSaveRuleExecution; prepared?: PreparedSave },
  ) => {
    // A preview request's own selection addresses its isolated storage.
    const totalPreparation = !preview
      ? await prepareRelationshipTotals(transaction, command, activityId)
      : { outcome: "not_required" as const };
    if (totalPreparation.outcome === "restart") return restartRelationshipTotalSave;
    if (totalPreparation.outcome === "refused_recorded") return recordedRefusal;
    if (totalPreparation.outcome === "conflict")
      return totalPreparation.correlationId === undefined
        ? recordedRefusal
        : safeRefusal(totalPreparation.correlationId, "conflict");
    if (totalPreparation.outcome === "refused")
      return totalPreparation.correlationId === undefined
        ? recordedRefusal
        : safeRefusal(totalPreparation.correlationId, "operation_refused");
    const prepared: PreparationOutcome =
      totalPreparation.outcome === "prepared"
        ? {
            outcome: "prepared",
            recordType: totalPreparation.records.find((record) => record.recordKey === "root")!
              .recordType,
            existingValues: totalPreparation.records.find((record) => record.recordKey === "root")!
              .existingValues,
            readableFieldIds: new Set(totalPreparation.readableFieldIds),
            correlationId: totalPreparation.correlationId,
          }
        : await prepare(transaction, command, activityId);
    if (prepared.outcome === "replayed") return prepared.result;
    if (prepared.outcome === "refused_recorded") return recordedRefusal;
    if (prepared.outcome === "conflict")
      return prepared.correlationId === undefined
        ? recordedRefusal
        : safeRefusal(prepared.correlationId, "conflict");
    if (prepared.outcome === "unavailable")
      return prepared.correlationId === undefined
        ? recordedRefusal
        : safeRefusal(prepared.correlationId, "operation_refused");

    let closureRules: Map<string, BeforeSaveRuleExecution> | undefined;
    if (totalPreparation.outcome === "prepared") {
      closureRules = new Map();
      for (const record of totalPreparation.records) {
        const ruleSet = beforeSaveFlowSetOf(record.beforeSaveFlows, record.recordType.recordTypeId);
        if (ruleSet === undefined) {
          console.error(
            `[record] save refused BEFORE_SAVE_RULE_SET_UNAVAILABLE: ${record.recordKey}`,
          );
          return safeRefusal(prepared.correlationId, "operation_refused");
        }
        const execution = beginBeforeSaveRuleExecution(ruleSet);
        closureRules.set(record.recordKey, execution);
      }
      attempted.rules = closureRules.get("root")!;
    } else {
      const ruleSet = beforeSaveFlowSetOf(
        prepared.beforeSaveFlows,
        prepared.recordType.recordTypeId,
      );
      if (ruleSet === undefined) {
        console.error("[record] save refused BEFORE_SAVE_RULE_SET_UNAVAILABLE");
        return safeRefusal(prepared.correlationId, "operation_refused");
      }
      attempted.rules = beginBeforeSaveRuleExecution(ruleSet);
    }
    attempted.prepared = prepared;

    const settings = await readOrganizationRuntimeSettings(transaction);
    const totalClock =
      totalPreparation.outcome === "prepared"
        ? operationClock(
            totalPreparation.records.map((record) => record.recordType),
            issuedAt,
            settings?.timeZone,
          )
        : undefined;
    const values =
      totalPreparation.outcome === "prepared" && totalClock !== undefined
        ? calculateLockedRelationshipTotalSave({
            changes: new Map([["root", command]]),
            preparation: totalPreparation,
            ...(settings?.currency === undefined
              ? {}
              : { organizationCurrency: settings.currency }),
            clock: totalClock,
            rules: closureRules!,
          })
        : totalPreparation.outcome === "prepared"
          ? {
              success: false as const,
              issues: [{ code: "invalid_input", recordKey: "root", path: ["clock"] }],
            }
          : calculateAndFinalize({
              operation: command.operation,
              submittedValues: command.submittedValues,
              recordType: prepared.recordType,
              existingValues: prepared.existingValues,
              issuedAt,
              organizationCurrency: settings?.currency,
              timeZone: settings?.timeZone,
              rules: attempted.rules,
            });
    const finalized = await finalizeCalculatedValues(
      transaction,
      command,
      prepared,
      totalPreparation,
      values,
      preview,
    );
    if (!("finalValues" in finalized)) return finalized;
    const finalValues = finalized.finalValues;
    identity.occurrenceId ??= eventOccurrenceIdSchema.parse(newOccurrenceId());
    const stored = await persist(
      transaction,
      command,
      prepared.recordType,
      finalValues,
      activityId,
      identity.occurrenceId,
      "parentMutations" in values ? values.parentMutations : [],
      preview,
    );
    if (stored.outcome === "restart") return restartRelationshipTotalSave;
    if (stored.outcome === "refused_recorded") return recordedRefusal;
    if (stored.outcome === "conflict") {
      console.error(`[record] protected save persistence conflicted (${stored.reasonCode})`);
      return safeRefusal(prepared.correlationId, "conflict");
    }
    if (stored.outcome === "refused")
      console.error(
        "[record] protected save persistence refused",
        contractError(stored.reasonCode ?? "RECORD_SAVE_REFUSED", stored.reasonCode),
      );
    if (stored.outcome === "refused")
      return safeRefusal(
        prepared.correlationId,
        stored.reasonCode === "command_invalid" ? "invalid_request" : "operation_refused",
      );
    const concurrencyNumber = revision(stored.concurrencyNumber);
    if (concurrencyNumber === undefined) throw new Error("RECORD_SAVE_RESULT_INVALID");
    return saveRecordResultSchema.parse({
      contractVersion: "2.0.0",
      outcome: "saved",
      recordId: stored.recordId,
      concurrencyNumber,
      readableValues: stored.values,
      correlationId: stored.correlationId,
      backgroundDelivery: stored.backgroundDelivery,
    });
  };

  return Object.freeze({
    /** Runs the same save core in a request transaction already owned by the caller. */
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
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch (error) {
        console.error(`[record] save identity generation failed: ${describeFailure(error)}`);
        return { kind: "temporarily_unavailable" };
      }
      const attempted: { rules?: BeforeSaveRuleExecution; prepared?: PreparedSave } = {};
      const value = await requireRequestSavepoint(transaction)
        .withSavepoint((child) =>
          saveWithinTransaction(
            child,
            issuedAt,
            command.data,
            selection.previewInstallationId !== undefined,
            activityId,
            { occurrenceId: undefined },
            attempted,
          ),
        )
        .catch((error: unknown) => {
          const correction = constraintCorrection(error, attempted.prepared, command.data);
          if (correction !== undefined) return correction;
          throw error;
        });
      if (value === restartRelationshipTotalSave) throw new HumanOrganizationRequestRestart();
      if (value === recordedRefusal) {
        console.error("[record] save refused RECORD_SAVE_REFUSAL_RECORDED");
        return { kind: "unavailable" };
      }
      const warnings = attempted.rules?.warnings ?? [];
      return value.outcome === "saved" && warnings.length > 0
        ? { kind: "available", value, warnings }
        : { kind: "available", value };
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

      const preview = selection.previewInstallationId !== undefined;
      let activityId: string;
      const identity: { occurrenceId: string | undefined } = { occurrenceId: undefined };
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch (error) {
        console.error(`[record] save identity generation failed: ${describeFailure(error)}`);
        return { kind: "temporarily_unavailable" };
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const attempted: {
          rules?: BeforeSaveRuleExecution;
          prepared?: PreparedSave;
        } = {};
        const result = await requests.runChangeWithRefusal(
          caller,
          selection,
          (transaction, _scope, issuedAt) =>
            saveWithinTransaction(
              transaction,
              issuedAt,
              command.data,
              preview,
              activityId,
              identity,
              attempted,
            ),
          (_code, error) => constraintCorrection(error, attempted.prepared, command.data),
        );

        if (result.kind !== "available") return result;
        if (result.value === restartRelationshipTotalSave) continue;
        if (result.value === recordedRefusal) {
          console.error("[record] save refused RECORD_SAVE_REFUSAL_RECORDED");
          return { kind: "unavailable" };
        }
        const value = result.value as SaveRecordResult;
        const warnings = attempted.rules?.warnings ?? [];
        return value.outcome === "saved" && warnings.length > 0
          ? { kind: "available", value, warnings }
          : { kind: "available", value };
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
