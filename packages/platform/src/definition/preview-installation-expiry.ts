import "server-only";

import { describeFailure } from "../catalogue/runtime-primitives";
import { withRuntimeTransaction, type DatabaseRow } from "../db/request-transaction";
import { DefinitionError, databaseErrorCode } from "./definition-error";

const previewExpiryLimits = Object.freeze({ batchSize: 100, maximumBatches: 100 });

type ExpiryRow = DatabaseRow & { readonly expired_count: unknown };

/** Purges expired previews in bounded transactions so one nightly call can drain a backlog. */
export const runScheduledPreviewInstallationExpiry = async (): Promise<number> => {
  let totalExpired = 0;
  try {
    // One batch past the limit tells a drained backlog (it finds nothing) from a real remainder.
    for (let batch = 0; batch <= previewExpiryLimits.maximumBatches; batch += 1) {
      const rows = await withRuntimeTransaction(
        (transaction) =>
          transaction.query<ExpiryRow>`
          select vortex_definition.expire_abandoned_preview_installations_internal(
            ${previewExpiryLimits.batchSize}::integer
          ) as expired_count
        `,
      );
      const expiredCount = rows[0]?.expired_count;
      if (
        rows.length !== 1 ||
        typeof expiredCount !== "number" ||
        !Number.isSafeInteger(expiredCount) ||
        expiredCount < 0 ||
        expiredCount > previewExpiryLimits.batchSize
      )
        throw new DefinitionError("PREVIEW_EXPIRY_RESULT_INVALID");

      totalExpired += expiredCount;
      if (batch === previewExpiryLimits.maximumBatches && expiredCount > 0) break;
      if (expiredCount < previewExpiryLimits.batchSize) return totalExpired;
    }
    throw new DefinitionError("PREVIEW_EXPIRY_BATCH_LIMIT_REACHED");
  } catch (error) {
    throw new DefinitionError("PREVIEW_EXPIRY_UNAVAILABLE", { cause: error });
  }
};

const retiredStorageLimits = Object.freeze({ batchSize: 100 });

type RetiredStorageRow = DatabaseRow & { readonly storage_contract_id: unknown };
type DroppedRow = DatabaseRow & { readonly dropped: unknown };

/**
 * Drops the storage of replaced and expired previews in the background, one storage identity per
 * short transaction, never inside a builder's request. Preview storage references no platform
 * table, so a drop locks only its own table; a lock that is held (a reader of the retired table)
 * fails fast and the next run retries that storage. Returns how many were dropped.
 */
export const dropRetiredPreviewStorage = async (): Promise<number> => {
  const listed = await withRuntimeTransaction(
    (transaction) =>
      transaction.query<RetiredStorageRow>`
        select storage_contract_id
        from vortex_record.read_retired_preview_storage_internal(
          ${retiredStorageLimits.batchSize}::integer
        ) as storage_contract_id
      `,
  );
  let dropped = 0;
  for (const row of listed) {
    const storageContractId = row.storage_contract_id;
    if (typeof storageContractId !== "string")
      throw new DefinitionError("PREVIEW_STORAGE_DROP_RESULT_INVALID");
    try {
      const rows = await withRuntimeTransaction(
        (transaction) =>
          transaction.query<DroppedRow>`
            select vortex_record.drop_retired_preview_storage_internal(
              ${storageContractId}::uuid
            ) as dropped
          `,
      );
      if (rows.length !== 1 || typeof rows[0]?.dropped !== "boolean")
        throw new DefinitionError("PREVIEW_STORAGE_DROP_RESULT_INVALID");
      if (rows[0].dropped) dropped += 1;
    } catch (error) {
      // 55P03: the retired table is still read; the next run drops it.
      if (databaseErrorCode(error) !== "55P03") throw error;
      console.info(
        `[preview] retired preview storage is still in use; a later run drops it: ${describeFailure(error)}`,
      );
    }
  }
  return dropped;
};
