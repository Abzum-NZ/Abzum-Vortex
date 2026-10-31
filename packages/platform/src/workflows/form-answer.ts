import { z } from "zod";
import { jsonValueSchema } from "../catalogue/common";

/*
 * What a person answers to a form the page shows: the closed answer the browser checks before it
 * sends one. A flow's interface steps run in the page, so an answer is a page event, never a
 * continuation of a server-held run.
 */

const maximumAnswerValues = 500;

export const formAnswerSchema = z.discriminatedUnion("kind", [
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
export type FormAnswer = z.infer<typeof formAnswerSchema>;
