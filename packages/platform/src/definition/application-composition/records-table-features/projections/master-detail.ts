import { z } from "zod";
import { recordsTableMasterDetailFeature } from "../master-detail";

const positiveSchema = z.number().int().min(1);
const masterDetailProjectionSchema = z.object({ pageSize: positiveSchema }).strict().readonly();

/** This feature's viewer projection: its definition's property and the strict schema under it. */
export const masterDetailProjection = {
  property: recordsTableMasterDetailFeature.property,
  schema: masterDetailProjectionSchema,
} as const;
