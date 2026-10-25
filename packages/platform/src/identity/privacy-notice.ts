import "server-only";

import { withRuntimeTransaction } from "../db/index";
import { describeFailure, privacyNoticeSchema, type PrivacyNotice } from "../schema";

/** Public notice content only; this function never exposes acknowledgement evidence. */
export const readPrivacyNotice = async (versionId?: string): Promise<PrivacyNotice> => {
  try {
    const rows = await withRuntimeTransaction(
      (transaction) =>
        transaction.query`select vortex_identity.read_current_privacy_notice(${versionId ?? null}::uuid) as notice`,
    );
    return privacyNoticeSchema.parse(rows[0]?.notice);
  } catch (error) {
    console.error(`[identity] privacy-notice read failed: ${describeFailure(error)}`);
    throw error;
  }
};
