import { z } from "zod";
import { jsonValueSchema } from "../catalogue/common";

/*
 * What a person answers to a paused flow form: the part of the form continuation contract the
 * browser checks before it sends an answer.
 */

const maximumAnswerValues = 500;

export const formContinuationAnswerSchema = z.discriminatedUnion("kind", [
  /** Continue or submit the form with its permitted answers. */
  z
    .object({
      kind: z.literal("submit"),
      values: z
        .record(z.string().min(1).max(200), jsonValueSchema)
        .refine((values) => Object.keys(values).length <= maximumAnswerValues, {
          message: "A form answer carries a bounded number of values",
        }),
    })
    .strict(),
  /** Cancel the form; the flow follows its declared not-submitted path. */
  z.object({ kind: z.literal("cancel") }).strict(),
  /** Answer a confirmation, with the person's opt-in when the confirmation offered one. */
  z
    .object({ kind: z.literal("confirm"), confirmed: z.boolean(), choice: z.boolean().optional() })
    .strict(),
]);
export type FormContinuationAnswer = z.infer<typeof formContinuationAnswerSchema>;
