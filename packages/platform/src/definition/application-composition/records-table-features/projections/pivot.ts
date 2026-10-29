import { z } from "zod";
import { recordsTablePivotFeature } from "../pivot";

const textSchema = z.string().min(1);
const positiveSchema = z.number().int().min(1);
const pivotProjectionSchema = z
  .object({
    rowPageSize: positiveSchema,
    totals: z.boolean(),
    view: z.object({ cursor: textSchema.optional() }).strict().readonly().optional(),
  })
  .strict()
  .readonly();

/** This feature's viewer projection: its definition's property and the strict schema under it. */
export const pivotProjection = {
  property: recordsTablePivotFeature.property,
  schema: pivotProjectionSchema,
} as const;
