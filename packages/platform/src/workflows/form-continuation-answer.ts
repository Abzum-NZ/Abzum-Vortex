import { z } from "zod";
import { jsonValueSchema } from "../catalogue/common";
import { builderKeySchema, recordIdSchema } from "../catalogue/identifiers";

/*
 * What a person answers to a paused flow form, and the choice evidence that travels with it: the
 * part of the form continuation contract the browser checks before it sends an answer.
 */

const maximumAnswerValues = 500;

/** Opaque evidence for the permitted Query page that issued one reference-choice option key. */
export const referenceChoiceSelectionEvidenceSchema = z
  .object({
    search: z.string().trim().min(1).max(100).optional(),
    continuationToken: z.string().min(1).max(65_536).optional(),
    exactRecordId: recordIdSchema.optional(),
  })
  .strict();
export type ReferenceChoiceSelectionEvidence = z.infer<
  typeof referenceChoiceSelectionEvidenceSchema
>;

/** Evidence keyed by the authored field name; a server rechecks every submitted key. */
export const referenceChoiceSelectionEvidenceMapSchema = z
  .record(builderKeySchema, referenceChoiceSelectionEvidenceSchema)
  .refine((values) => Object.keys(values).length <= maximumAnswerValues, {
    message: "Choice evidence is bounded by the form answer limit",
  });
export type ReferenceChoiceSelectionEvidenceMap = z.infer<
  typeof referenceChoiceSelectionEvidenceMapSchema
>;

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
      choiceEvidence: referenceChoiceSelectionEvidenceMapSchema.optional(),
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
