import "server-only";

import { randomUUID } from "node:crypto";
import {
  activityIdSchema,
  eventOccurrenceIdSchema,
  transferRecordOwnershipCommandV2Schema,
  transferRecordOwnershipResultV2Schema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type TransferRecordOwnershipResultV2,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

type TransferRow = DatabaseRow & { readonly result: unknown };

const one = <Row>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error("RECORD_OWNERSHIP_TRANSFER_RESULT_INVALID");
  return rows[0];
};

const safeRefusal = (
  correlationId: string,
  code: "operation_refused" | "conflict" = "operation_refused",
): TransferRecordOwnershipResultV2 =>
  transferRecordOwnershipResultV2Schema.parse({
    contractVersion: "2.0.0",
    outcome: "refused",
    error: { code, messageKey: `errors.${code}`, correlationId },
  });

const transfer = async (
  transaction: RequestDatabaseTransaction,
  command: ReturnType<typeof transferRecordOwnershipCommandV2Schema.parse>,
  activityId: string,
  occurrenceId: string,
): Promise<
  TransferRecordOwnershipResultV2 | "recorded_refusal" | "undisclosed_refusal"
> => {
  await transaction.query`set local role vortex_runtime`;
  const targetId =
    command.targetKind === "organization_account"
      ? command.targetOrganizationAccountId
      : command.targetGroupId;
  const rows = await transaction.query<TransferRow>`
    select vortex_record.transfer_record_ownership(
      ${command.commandId}::uuid,
      ${command.recordTypeId}::uuid,
      ${command.recordId}::uuid,
      ${command.expectedConcurrencyNumber}::bigint,
      ${command.targetKind}::text,
      ${targetId}::uuid,
      ${activityId}::uuid,
      ${occurrenceId}::uuid
    ) as result
  `;
  const value = one(rows).result;
  if (typeof value !== "object" || value === null)
    throw new Error("RECORD_OWNERSHIP_TRANSFER_RESULT_INVALID");
  const candidate = value as Record<string, unknown>;
  if (candidate.outcome === "refused_recorded") return "recorded_refusal";
  if (candidate.outcome === "transferred") {
    return transferRecordOwnershipResultV2Schema.parse({
      contractVersion: "2.0.0",
      outcome: "transferred",
      recordId: candidate.recordId,
      concurrencyNumber: candidate.concurrencyNumber,
      correlationId: candidate.correlationId,
      replayed: candidate.replayed,
    });
  }
  if (candidate.outcome === "conflict") {
    const correlationId =
      typeof candidate.correlationId === "string" ? candidate.correlationId : undefined;
    // SQL has a correlation ID for every post-context outcome.  Keep this
    // defensive fallback fail-closed: a direct/adversarial SQL response that
    // omits it must be a safe unavailable result, never a transient error.
    if (correlationId === undefined) return "undisclosed_refusal";
    return safeRefusal(correlationId, "conflict");
  }
  if (candidate.outcome !== "refused")
    throw new Error("RECORD_OWNERSHIP_TRANSFER_RESULT_INVALID");
  const correlationId =
    typeof candidate.correlationId === "string" ? candidate.correlationId : undefined;
  if (correlationId === undefined) return "undisclosed_refusal";
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
    ): Promise<HumanOrganizationRequestResult<TransferRecordOwnershipResultV2>> {
      const command = transferRecordOwnershipCommandV2Schema.safeParse(commandCandidate);
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
      return result.value === "recorded_refusal" || result.value === "undisclosed_refusal"
        ? { kind: "unavailable" }
        : { kind: "available", value: result.value };
    },
  });
};
