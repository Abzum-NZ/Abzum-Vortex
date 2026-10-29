import { z } from "zod";
import { recordsTableSavedViewsFeature } from "../saved-views";

const savedViewsProjectionSchema = z.literal(true);

/** This feature's viewer projection: its definition's property and the strict schema under it. */
export const savedViewsProjection = {
  property: recordsTableSavedViewsFeature.property,
  schema: savedViewsProjectionSchema,
} as const;
