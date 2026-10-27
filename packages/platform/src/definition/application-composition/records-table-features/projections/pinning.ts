import { z } from "zod";
import { recordsTablePinningFeature } from "../pinning";

export const pinningProjectionSchema = z.literal(true);

/** This feature's viewer projection: its definition's property and the strict schema under it. */
export const pinningProjection = {
  property: recordsTablePinningFeature.property,
  schema: pinningProjectionSchema,
} as const;
