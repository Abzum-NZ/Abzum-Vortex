import { z } from "zod";
import { recordsTableTotalsFeature } from "../totals";

const totalsProjectionSchema = z.literal(true);

/** This feature's viewer projection: its definition's property and the strict schema under it. */
export const totalsProjection = {
  property: recordsTableTotalsFeature.property,
  schema: totalsProjectionSchema,
} as const;
