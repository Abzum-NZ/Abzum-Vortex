import "server-only";

import { groupIdSchema, unavailableError } from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

type OwnerGroupRow = DatabaseRow & { group_id: unknown; label: unknown };

/** Reads only the verified viewer's current Groups for an initial owner choice. */
export const readCurrentRecordOwnerGroupsAfterAuthorization = async (
  transaction: RequestDatabaseTransaction,
): Promise<readonly Readonly<{ groupId: string; label: string }>[]> => {
  const rows = await transaction.query<OwnerGroupRow>`
    select group_id, label from vortex_access.list_current_record_owner_groups()
  `;
  return rows.map((row) => {
    const groupId = groupIdSchema.safeParse(row.group_id);
    if (!groupId.success || typeof row.label !== "string" || row.label.length === 0)
      throw unavailableError("RECORD_OWNER_GROUP_CHOICES_UNAVAILABLE", "42501");
    return { groupId: groupId.data, label: row.label };
  });
};
