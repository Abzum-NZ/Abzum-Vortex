import { z } from "zod";

/*
 * What an `interface.confirm` step lists under its message: short lines, and one level of nesting
 * for a heading with its own lines (each role an install adds, then what that role allows, grouped
 * by record type). The page renders the nesting; a line carries no identity and no action.
 */

const confirmDetailLine = z.string().trim().min(1).max(300);

export const flowConfirmDetailSchema = z
  .object({
    text: confirmDetailLine,
    lines: z.array(confirmDetailLine).min(1).max(20).readonly().optional(),
  })
  .strict()
  .readonly();
export type FlowConfirmDetail = z.infer<typeof flowConfirmDetailSchema>;

export const flowConfirmDetailsSchema = z.array(flowConfirmDetailSchema).max(50).readonly();
export type FlowConfirmDetails = z.infer<typeof flowConfirmDetailsSchema>;
