import { z } from "zod";
import { recordsTableGroupingFeature } from "../grouping";

const textSchema = z.string().min(1);
const onlyTrue = z.literal(true);
const groupingProjectionSchema = z
  .object({
    fieldId: textSchema,
    label: textSchema,
    unassignedLabel: textSchema,
    /** The authored opening state: the address overrides it (grouped or flat) for this viewer. */
    opensGrouped: z.boolean(),
    /** The table reads a grouped query, so it is always grouped and offers no way to ungroup. */
    required: onlyTrue.optional(),
  })
  .strict()
  .readonly();

/** This feature's viewer projection: its definition's property and the strict schema under it. */
export const groupingProjection = {
  property: recordsTableGroupingFeature.property,
  schema: groupingProjectionSchema,
} as const;
