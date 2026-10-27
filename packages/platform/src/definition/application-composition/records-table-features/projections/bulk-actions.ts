import { z } from "zod";
import { recordsTableBulkActionRecordLimit, recordsTableBulkActionsFeature } from "../bulk-actions";

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

/** This feature's viewer projection: its definition's property and the strict schema under it. */
export const bulkActionsProjection = {
  property: recordsTableBulkActionsFeature.property,
  schema: bulkActionsProjectionSchema,
} as const;
