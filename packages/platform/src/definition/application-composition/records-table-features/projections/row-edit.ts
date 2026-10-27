import { z } from "zod";
import { inlineEditFieldsSchema } from "./inline-edit";

const textSchema = z.string().min(1);
export const rowEditProjectionSchema = z
  .object({ eventId: textSchema, trigger: z.literal("button"), fields: inlineEditFieldsSchema })
  .strict()
  .readonly();
