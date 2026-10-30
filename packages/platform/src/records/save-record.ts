import "server-only";

import type { OptionMembershipCheck } from "./option-membership";
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
  type RecordSaveServiceDependencies,
  type RecordSaveServiceResult,
} from "./record-save-preparation";

export { calculateAndFinalize, operationClock } from "./field-candidate";
export {
  parseRelationshipTotalPreparation,
  readOrganizationRuntimeSettings,
  revision,
  type PreparedSave,
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
    optionMember?: OptionMembershipCheck,
  ): Promise<RecordSaveServiceResult> => {
    const rollback = contractError("RECORD_SAVE_ROLLED_BACK", undefined);
    let settled: RecordChangesResult | undefined;
    try {
      await requireRequestSavepoint(transaction).withSavepoint(async (child) => {
        settled = await applyRecordChanges(
          child,
          issuedAt,
          command.commandId,
          [intentOf(command)],
          undefined,
          optionMember,
        );
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
    if (settled.results.length !== 1 || settled.results[0]?.outcome !== "saved")
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
      optionMember?: OptionMembershipCheck,
    ): Promise<RecordSaveServiceResult> {
      const command = saveRecordCommandSchema.safeParse(commandCandidate);
      if (!command.success || selection.applicationRootId === undefined) {
        console.error(
          `[record] save refused RECORD_SAVE_COMMAND_INVALID: ${command.success ? "no application selected" : describeFailure(command.error)}`,
        );
        return { kind: "unavailable" };
      }
      return saveWithinTransaction(transaction, issuedAt, command.data, optionMember);
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
  });
};
