import { z } from "zod";
import { recordsTableBulkActionRecordLimit } from "../bulk-actions";

const textSchema = z.string().min(1);
const bulkActionSchema = z
  .object({
    action: textSchema,
    label: textSchema,
    confirm: z.boolean(),
    maxRecords: z.number().int().min(1).max(recordsTableBulkActionRecordLimit),
  })
  .strict()
  .readonly();

export const bulkActionsProjectionSchema = z.array(bulkActionSchema).min(1).readonly();
