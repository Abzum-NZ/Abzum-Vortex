import "server-only";

import { z } from "zod";
import {
  recoverableRecordCandidateSchema,
  recordIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type RecoverableRecordCandidate,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

export { recoverableRecordCandidateSchema };

const recoverableRecordsSchema = z
  .object({
    outcome: z.literal("available"),
    records: z.array(recoverableRecordCandidateSchema).max(100),
  })
  .strict();
const selectedRecoverableRecordSchema = z.object({
  outcome: z.literal("available"),
  record: recoverableRecordCandidateSchema,
});

export type RecoverableRecordsRead =
  | Readonly<{ outcome: "available"; records: readonly RecoverableRecordCandidate[] }>
  | Readonly<{ outcome: "unavailable" }>;
export type RecoverableRecordRead =
  | Readonly<{ outcome: "available"; record: RecoverableRecordCandidate }>
  | Readonly<{ outcome: "unavailable" }>;

type RecoveryRow = DatabaseRow & { readonly result: unknown };

const readRecoveryResult = async (
  transaction: RequestDatabaseTransaction,
  recordTypeId: string,
  recordId: string | null,
  expectedRevision: number | null,
): Promise<unknown> => {
  await transaction.query`set local role vortex_runtime`;
  const rows = await transaction.query<RecoveryRow>`
    select vortex_record.read_recoverable_record_for_restore(
      ${recordTypeId}::uuid,
      ${recordId}::uuid,
      ${expectedRevision}::bigint
    ) as result
  `;
  return rows.length === 1 ? rows[0]?.result : undefined;
};

/** Current HUMAN read of the exact installed Record restore surface's safe row identities. */
export const createRecordRecoveryService = (
  dependencies: HumanOrganizationRequestDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);

  return Object.freeze({
    async listRecoverableRecords(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      recordTypeCandidate: string,
    ): Promise<HumanOrganizationRequestResult<RecoverableRecordsRead>> {
      const recordTypeId = recordTypeIdSchema.safeParse(recordTypeCandidate);
      if (!recordTypeId.success || selection.applicationRootId === undefined)
        return { kind: "unavailable" };
      const result = await requests.run(session, selection, (transaction) =>
        readRecoveryResult(transaction, recordTypeId.data, null, null),
      );
      if (result.kind !== "available") return result;
      const parsed = recoverableRecordsSchema.safeParse(result.value);
      return parsed.success
        ? { kind: "available", value: { outcome: "available", records: parsed.data.records } }
        : { kind: "available", value: { outcome: "unavailable" } };
    },

    async readRecoverableRecord(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      target: Readonly<{ recordTypeId: string; recordId: string; revision: number }>,
    ): Promise<HumanOrganizationRequestResult<RecoverableRecordRead>> {
      const recordTypeId = recordTypeIdSchema.safeParse(target.recordTypeId);
      const recordId = recordIdSchema.safeParse(target.recordId);
      const revision = revisionSchema.safeParse(target.revision);
      if (
        !recordTypeId.success ||
        !recordId.success ||
        !revision.success ||
        selection.applicationRootId === undefined
      )
        return { kind: "unavailable" };
      const result = await requests.run(session, selection, (transaction) =>
        readRecoveryResult(transaction, recordTypeId.data, recordId.data, revision.data),
      );
      if (result.kind !== "available") return result;
      const parsed = selectedRecoverableRecordSchema.safeParse(result.value);
      return parsed.success
        ? { kind: "available", value: { outcome: "available", record: parsed.data.record } }
        : { kind: "available", value: { outcome: "unavailable" } };
    },
  });
};

export type RecordRecoveryService = ReturnType<typeof createRecordRecoveryService>;
