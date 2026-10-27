import { z } from "zod";
import { recordsTableTreeFeature } from "../tree";

const positiveSchema = z.number().int().min(1);
export const treeProjectionSchema = z.object({ pageSize: positiveSchema }).strict().readonly();

/** This feature's viewer projection: its definition's property and the strict schema under it. */
export const treeProjection = {
  property: recordsTableTreeFeature.property,
  schema: treeProjectionSchema,
} as const;
