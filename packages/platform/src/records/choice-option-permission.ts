import "server-only";

import { recordTypeIdSchema, permissionIdSchema } from "../schema";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";

type DecisionRow = DatabaseRow & { readonly allowed: unknown };

/**
 * Whether the signed-in person holds, for one record type, the permission that gates a choice
 * option. The database decides it from the installed release and the person's current roles; the
 * page that offers the option and the save that stores it both ask this one decision. A reason for
 * a refusal stays in the database log.
 */
export const decideChoiceOptionPermission = async (
  transaction: RequestDatabaseTransaction,
  recordTypeId: string,
  permissionId: string,
): Promise<boolean> => {
  const recordType = recordTypeIdSchema.parse(recordTypeId);
  const permission = permissionIdSchema.parse(permissionId);
  const rows = await transaction.query<DecisionRow>`
    select vortex_record.decide_choice_option_permission(
      ${recordType}::uuid, ${permission}::uuid
    ) as allowed
  `;
  if (rows.length !== 1 || typeof rows[0]?.allowed !== "boolean")
    throw new Error("CHOICE_OPTION_PERMISSION_DECISION_INVALID");
  return rows[0].allowed;
};
