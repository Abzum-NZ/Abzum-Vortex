import { z } from "zod";
import {
  RECORDS_TABLE_EXPORT_MAXIMUM_ROWS,
  recordsTableExportFormats,
  recordsTableExportFeature,
} from "../export";

export const exportProjectionSchema = z
  .object({
    maxRows: z.number().int().min(1).max(RECORDS_TABLE_EXPORT_MAXIMUM_ROWS),
    formats: z
      .array(z.enum(recordsTableExportFormats))
      .min(1)
      .refine((formats) => new Set(formats).size === formats.length, "Name each format once")
      .readonly(),
  })
  .strict()
  .readonly();

/** This feature's viewer projection: its definition's property and the strict schema under it. */
export const exportProjection = {
  property: recordsTableExportFeature.property,
  schema: exportProjectionSchema,
} as const;
