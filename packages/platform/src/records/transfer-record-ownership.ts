import "server-only";

import { randomUUID } from "node:crypto";
import {
  activityIdSchema,
  eventOccurrenceIdSchema,
  transferRecordOwnershipCommandSchema,
  transferRecordOwnershipResultSchema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type TransferRecordOwnershipResult,
} from "../schema";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "../access/index";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";

type TransferRow = DatabaseRow & { readonly result: unknown };
const contractError = (cause: unknown): Error =>
  Object.assign(new Error("RECORD_OWNERSHIP_TRANSFER_RESULT_INVALID", { cause }), {
    code: "RECORD_OWNERSHIP_TRANSFER_RESULT_INVALID",
  });

const one = <Row>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined) throw contractError("missing row");
  return rows[0];
};

const safeRefusal = (
  correlationId: string,
  code: "operation_refused" | "conflict" = "operation_refused",
): TransferRecordOwnershipResult =>
  transferRecordOwnershipResultSchema.parse({
    contractVersion: "2.0.0",
    outcome: "refused",
    error: { code, messageKey: `errors.${code}`, correlationId },
  });

const transfer = async (
  transaction: RequestDatabaseTransaction,
  command: ReturnType<typeof transferRecordOwnershipCommandSchema.parse>,
  activityId: string,
  occurrenceId: string,
): Promise<TransferRecordOwnershipResult | "recorded_refusal"> => {
  await transaction.query`set local role vortex_runtime`;
  const targetId =
    command.targetKind === "organization_account"
      ? command.targetOrganizationAccountId
      : command.targetGroupId;
  const targetMutation = [{ kind: "transfer_ownership", targetKind: command.targetKind, targetId }];
  const rows = await transaction.query<TransferRow>`
    select vortex_record.apply_lifecycle_record_changes(
      ${command.commandId}::uuid,
      'transfer_ownership'::text,
      ${command.recordTypeId}::uuid,
      ${command.recordId}::uuid,
      ${command.expectedConcurrencyNumber}::bigint,
      ${JSON.stringify(targetMutation)}::text::jsonb,
      ${activityId}::uuid,
      ${occurrenceId}::uuid
    ) as result
  `;
  const value = one(rows).result;
  if (typeof value !== "object" || value === null) throw contractError("invalid result");
  const candidate = value as Record<string, unknown>;
  if (candidate.outcome === "refused_recorded") return "recorded_refusal";
  if (candidate.outcome === "transferred") {
    const transferred = transferRecordOwnershipResultSchema.safeParse({
      contractVersion: "2.0.0",
      outcome: "transferred",
      recordId: candidate.recordId,
      concurrencyNumber: candidate.concurrencyNumber,
      correlationId: candidate.correlationId,
      replayed: candidate.replayed,
    });
    if (!transferred.success) throw contractError(transferred.error);
    return transferred.data;
  }
  if (candidate.outcome === "conflict") {
    const correlationId =
      typeof candidate.correlationId === "string" ? candidate.correlationId : undefined;
    if (correlationId === undefined) throw contractError("missing correlationId");
    return safeRefusal(correlationId, "conflict");
  }
  if (candidate.outcome !== "refused") throw contractError(candidate.outcome);
  const correlationId =
    typeof candidate.correlationId === "string" ? candidate.correlationId : undefined;
  if (correlationId === undefined) throw contractError("missing correlationId");
  return safeRefusal(correlationId);
};

export type RecordOwnershipTransferServiceDependencies = HumanOrganizationRequestDependencies &
  Readonly<{ activityId?: () => string; occurrenceId?: () => string }>;

/** A fixed human-request facade for the one protected ownership transfer. */
export const createRecordOwnershipTransferService = (
  dependencies: RecordOwnershipTransferServiceDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const newActivityId = dependencies.activityId ?? randomUUID;
  const newOccurrenceId = dependencies.occurrenceId ?? randomUUID;
  return Object.freeze({
    async transfer(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<TransferRecordOwnershipResult>> {
      const command = transferRecordOwnershipCommandSchema.safeParse(commandCandidate);
      if (!command.success || selection.applicationRootId === undefined)
        return { kind: "unavailable" };
      let activityId: string;
      let occurrenceId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
        occurrenceId = eventOccurrenceIdSchema.parse(newOccurrenceId());
      } catch {
        return { kind: "temporarily_unavailable" };
      }
      const result = await requests.runChange(session, selection, async (transaction) =>
        transfer(transaction, command.data, activityId, occurrenceId),
      );
      if (result.kind !== "available") return result;
      return result.value === "recorded_refusal"
        ? { kind: "unavailable" }
        : { kind: "available", value: result.value };
    },
  });
};
