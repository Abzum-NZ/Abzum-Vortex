import { z } from "zod";

const textSchema = z.string().min(1);
const positiveSchema = z.number().int().min(1);
export const pivotProjectionSchema = z
  .object({
    rowPageSize: positiveSchema,
    totals: z.boolean(),
    view: z.object({ cursor: textSchema.optional() }).strict().readonly().optional(),
  })
  .strict()
  .readonly();
