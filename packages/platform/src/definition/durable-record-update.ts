import "server-only";

import { z } from "zod";
import {
  databaseRevision,
  fieldIdSchema,
  jsonValueSchema,
  recordIdSchema,
  recordTypeIdSchema,
  moduleRootIdSchema,
  revisionSchema,
  saveRecordCommandSchema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
} from "../schema";
import type { RequestDatabaseTransaction } from "../db/index";
import type { createRecordSaveService } from "../records/save-record";

/** The exact published Record target and evaluated values of one durable update. */
export const durableRecordUpdateSchema = z
  .object({
    recordTypeId: recordTypeIdSchema,
    recordId: recordIdSchema,
    moduleRootId: moduleRootIdSchema,
    installationRevision: revisionSchema,
    values: z.record(z.string().min(1), jsonValueSchema),
  })
  .strict();
export type DurableRecordUpdate = z.infer<typeof durableRecordUpdateSchema>;
export type DurableRecordSave = Pick<ReturnType<typeof createRecordSaveService>, "save">;

const preparationSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("refused") }).strict(),
  z
    .object({
      outcome: z.literal("prepared"),
      concurrencyNumber: revisionSchema,
      fieldIds: z.record(z.string(), fieldIdSchema),
    })
    .strict(),
]);

/** The actor transaction and callback effect claim surround the ordinary record save. */
export const prepareDurableRecordUpdate = async (
  transaction: RequestDatabaseTransaction,
  commandId: string,
  update: DurableRecordUpdate,
) => {
  await transaction.query`set local role vortex_request`;
  const rows = await transaction.query<{ preparation: unknown }>`
    select vortex_record.prepare_flow_record_update(
      ${update.recordTypeId}::uuid, ${update.recordId}::uuid,
      ${update.moduleRootId}::uuid, ${update.installationRevision}::bigint
    ) as preparation
  `;
  if (rows.length !== 1) throw new Error("DURABLE_RECORD_PREPARATION_MISSING");
  const raw = rows[0]!.preparation;
  const preparation = preparationSchema.parse(
    raw !== null && typeof raw === "object" && "concurrencyNumber" in raw
      ? { ...raw, concurrencyNumber: databaseRevision(raw.concurrencyNumber) }
      : raw,
  );
  if (preparation.outcome !== "prepared") return { outcome: "refused" as const };
  const submittedValues: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(update.values)) {
    const fieldId = preparation.fieldIds[name.toLowerCase()];
    if (fieldId === undefined || Object.hasOwn(submittedValues, fieldId))
      return { outcome: "validation" as const };
    submittedValues[fieldId] = value;
  }
  const command = saveRecordCommandSchema.parse({
    contractVersion: "2.0.0",
    commandId,
    operation: "update",
    recordTypeId: update.recordTypeId,
    recordId: update.recordId,
    expectedConcurrencyNumber: preparation.concurrencyNumber,
    submittedValues,
  });
  return { outcome: "prepared" as const, command };
};

export const executeDurableRecordUpdate = async (
  transaction: RequestDatabaseTransaction,
  records: DurableRecordSave,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  command: ReturnType<typeof saveRecordCommandSchema.parse>,
) => {
  const saved = await records.save(session, selection, command);
  await transaction.query`set local role vortex_request`;
  if (saved.kind === "temporarily_unavailable") throw new Error("DURABLE_RECORD_SAVE_FAILED");
  if (saved.kind !== "available") return { outcome: "refused" as const };
  if (saved.value.outcome === "saved")
    return { outcome: "committed" as const, outputs: { record: saved.value.recordId } };
  if (saved.value.outcome === "correction_required") return { outcome: "validation" as const };
  return {
    outcome: saved.value.error.code === "conflict" ? ("conflict" as const) : ("refused" as const),
  };
};
