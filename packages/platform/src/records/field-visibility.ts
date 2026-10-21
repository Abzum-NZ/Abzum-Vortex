import "server-only";

import { z } from "zod";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";

/**
 * The fields the viewer may read now on one record type, decided by access route in the database
 * (no record is read): a grid lists, reads and offers only these columns. A record's own route or
 * share may still withhold one of them on that row.
 */
export const readRecordTypeVisibleFieldIds = async (
  transaction: RequestDatabaseTransaction,
  recordTypeId: string,
): Promise<ReadonlySet<string>> => {
  const rows = await transaction.query<DatabaseRow & { field_ids: unknown }>`
    select vortex_record.read_record_type_visible_field_ids(${recordTypeId}::uuid) as field_ids
  `;
  if (rows.length !== 1) {
    console.error(
      `[record-fields] code=RECORD_FIELD_VISIBILITY_RESULT_INVALID recordTypeId=${recordTypeId} rows=${rows.length}`,
    );
    throw new Error("RECORD_FIELD_VISIBILITY_RESULT_INVALID");
  }
  const parsed = z.array(z.uuid()).safeParse(rows[0]?.field_ids);
  if (!parsed.success) {
    console.error("[record-fields] code=RECORD_FIELD_VISIBILITY_RESULT_INVALID", parsed.error);
    throw new Error("RECORD_FIELD_VISIBILITY_RESULT_INVALID", { cause: parsed.error });
  }
  return new Set(parsed.data.map((id) => id.toLowerCase()));
};
