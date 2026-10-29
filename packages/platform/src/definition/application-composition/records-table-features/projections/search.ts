import { z } from "zod";
import { recordsTableSearchFeature } from "../search";

const searchProjectionSchema = z.literal(true);

/** This feature's viewer projection: its definition's property and the strict schema under it. */
export const searchProjection = {
  property: recordsTableSearchFeature.property,
  schema: searchProjectionSchema,
} as const;
