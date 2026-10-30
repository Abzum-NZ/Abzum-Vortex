import "server-only";

import { z } from "zod";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";

/** The closed catalogue of option filters a link input may declare; each names one decision. */
export const optionFilterKeys = ["delegable_roles"] as const;
export type OptionFilterKey = (typeof optionFilterKeys)[number];

/**
 * The roles, among the given role identities, the viewer may give in an invitation: the shared
 * delegation decision the invitation itself makes. The invitation stays the final judge.
 */
export const delegableRoleIds = async (
  transaction: RequestDatabaseTransaction,
  roleIds: readonly string[],
): Promise<ReadonlySet<string>> => {
  if (roleIds.length === 0) return new Set();
  const rows = await transaction.query<DatabaseRow & { role_ids: unknown }>`
    select vortex_access.delegable_invitation_role_ids(${`{${roleIds.join(",")}}`}::text::uuid[]) as role_ids
  `;
  const parsed = z.array(z.uuid()).safeParse(rows[0]?.role_ids);
  if (rows.length !== 1 || !parsed.success) {
    console.error("[option-filters] code=DELEGABLE_ROLES_RESULT_INVALID rows=" + rows.length);
    throw new Error("DELEGABLE_ROLES_RESULT_INVALID");
  }
  return new Set(parsed.data.map((id) => id.toLowerCase()));
};
