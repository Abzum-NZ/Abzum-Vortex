import { z } from "zod";
import { flowValueSchema } from "../workflows/flow-values";

/** The authored change list used by both named actions and interactive record steps. */
export const recordChangeListSchema = z
  .array(
    z
      .object({
        kind: z.literal("copy_relationships"),
        relationshipIds: z.array(z.string().min(1).max(250)).min(1).max(500),
        subject: flowValueSchema,
        target: flowValueSchema,
      })
      .strict(),
  )
  .min(1)
  .max(200);
