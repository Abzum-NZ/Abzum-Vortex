import "server-only";

import { withRuntimeTransaction, type DatabaseRow } from "../db/index";
import { DefinitionError } from "./definition-error";

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
