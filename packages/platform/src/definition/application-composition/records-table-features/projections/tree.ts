import { z } from "zod";

const positiveSchema = z.number().int().min(1);
export const treeProjectionSchema = z.object({ pageSize: positiveSchema }).strict().readonly();
