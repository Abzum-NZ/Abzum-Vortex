import { z } from "zod";
import { recordsTableRowEditFeature } from "../row-edit";
import { inlineEditFieldsSchema } from "./inline-edit";

const textSchema = z.string().min(1);
const rowEditProjectionSchema = z
  .object({ eventId: textSchema, trigger: z.literal("button"), fields: inlineEditFieldsSchema })
  .strict()
  .readonly();

/** This feature's viewer projection: its definition's property and the strict schema under it. */
export const rowEditProjection = {
  property: recordsTableRowEditFeature.property,
  schema: rowEditProjectionSchema,
} as const;
