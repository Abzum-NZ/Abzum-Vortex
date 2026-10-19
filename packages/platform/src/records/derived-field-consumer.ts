import "server-only";

import { z } from "zod";
import { installationActivatedOccurrenceSchema } from "../schema";
import type { DatabaseRow } from "../db/index";
import type { EventConsumerAdapter } from "../events/dispatcher";
import { inEventConsumerScope } from "../events/system-scope";
import { backfillDerivedFieldPage } from "./derived-field-backfill";

const checkpointSchema = z
  .object({
    releaseRevision: z.number().int().positive(),
    recordTypeId: z.uuid().nullable(),
    afterRecordId: z.uuid().nullable(),
    processedCount: z.number().int().nonnegative(),
    writtenCount: z.number().int().nonnegative(),
    complete: z.boolean(),
  })
  .strict();
const openedSchema = z
  .object({
    checkpoint: checkpointSchema.nullable(),
    releaseRevision: z.number().int().positive().nullable(),
    settings: z.object({ timeZone: z.string(), currency: z.string() }).strict(),
  })
  .strict();
const typesSchema = z.object({ recordTypeIds: z.array(z.uuid()) }).strict();

/** One delivery commits at most 100 existing records and their cursor, using the dispatcher lease. */
export const createDerivedFieldBackfillConsumer = (): EventConsumerAdapter => ({
  consumerKey: "installation-derived-values",
  policy: { leaseSeconds: 60, maxAttempts: 5, retryBackoffSeconds: 30 },
  async deliver(delivery) {
    try {
      const occurrence = installationActivatedOccurrenceSchema.parse(delivery.occurrence);
      return await inEventConsumerScope(
        occurrence.organizationId,
        occurrence.applicationRootId,
        async (transaction) => {
          await transaction.query`set local role vortex_runtime`;
          const rows = await transaction.query<DatabaseRow>`
          select vortex_platform.installation_backfill_progress(
            ${occurrence.occurrenceId}::uuid, ${delivery.claimCursor}::uuid, null::jsonb
          ) as progress
        `;
          if (rows.length !== 1) throw new Error("INSTALLATION_BACKFILL_PROGRESS_INVALID");
          const opened = openedSchema.parse(rows[0]!.progress);
          // A detached installation has no remaining records to update.
          if (opened.releaseRevision === null) return { outcome: "completed" };
          const checkpoint =
            opened.checkpoint?.releaseRevision === opened.releaseRevision
              ? opened.checkpoint
              : {
                  releaseRevision: opened.releaseRevision,
                  recordTypeId: null,
                  afterRecordId: null,
                  processedCount: 0,
                  writtenCount: 0,
                  complete: false,
                };
          if (checkpoint.complete) return { outcome: "completed" };
          const listed = await transaction.query<DatabaseRow>`
          select vortex_record.read_derived_field_backfill(null::uuid, null::uuid) as backfill
        `;
          if (listed.length !== 1) throw new Error("DERIVED_FIELD_BACKFILL_RESULT_INVALID");
          const types = typesSchema.parse(listed[0]!.backfill).recordTypeIds;
          const recordTypeId = checkpoint.recordTypeId ?? types[0];
          const page =
            recordTypeId === undefined
              ? undefined
              : await backfillDerivedFieldPage(
                  transaction,
                  recordTypeId,
                  checkpoint.afterRecordId,
                  occurrence.occurredAt,
                  opened.settings,
                );
          const nextType =
            recordTypeId === undefined ? undefined : types[types.indexOf(recordTypeId) + 1];
          const complete = page === undefined || (page.complete && nextType === undefined);
          const next = {
            releaseRevision: opened.releaseRevision,
            recordTypeId: page?.complete ? (nextType ?? null) : (recordTypeId ?? null),
            afterRecordId: page?.complete ? null : (page?.after ?? null),
            processedCount: checkpoint.processedCount + (page?.processed ?? 0),
            writtenCount: checkpoint.writtenCount + (page?.written ?? 0),
            complete,
          };
          await transaction.query`
          select vortex_platform.installation_backfill_progress(
            ${occurrence.occurrenceId}::uuid, ${delivery.claimCursor}::uuid,
            ${JSON.stringify(next)}::text::jsonb
          )
        `;
          return { outcome: complete ? "completed" : "continued" };
        },
      );
    } catch (error) {
      console.error("Derived values page failed", {
        cause: error instanceof Error ? error.message : String(error),
        code: (error as { code?: unknown } | null)?.code,
      });
      return { outcome: "retryable_failure", failureCode: "unclassified" };
    }
  },
});
