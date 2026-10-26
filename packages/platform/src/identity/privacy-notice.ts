import "server-only";

import { withRuntimeTransaction } from "../db/request-transaction";
import { databaseCode, describeFailure } from "../catalogue/runtime-primitives";
import { privacyNoticeSchema, type PrivacyNotice } from "./privacy-notice-schema";

/**
 * Public notice content only; this function never exposes acknowledgement evidence. Undefined
 * when no notice is in effect (none published yet, or no such version): a configuration state,
 * not a fault. Any other failure is thrown.
 */
export const readPrivacyNotice = async (versionId?: string): Promise<PrivacyNotice | undefined> => {
  try {
    const rows = await withRuntimeTransaction(
      (transaction) =>
        transaction.query`select vortex_identity.read_current_privacy_notice(${versionId ?? null}::uuid) as notice`,
    );
    return privacyNoticeSchema.parse(rows[0]?.notice);
  } catch (error) {
    if (databaseCode(error) === "55000") return undefined;
    console.error(`[identity] privacy-notice read failed: ${describeFailure(error)}`);
    throw error;
  }
};
