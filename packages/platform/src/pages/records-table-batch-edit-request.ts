import { z } from "zod";
import { recordsTableRequestRejectionSchema } from "./records-selection";
import {
  fieldIdSchema,
  platformIdSchema,
  recordIdSchema,
  revisionSchema,
} from "../catalogue/identifiers";

/** The most records one pasted, filled or undone batch changes. */
export const recordsTableBatchEditMaximumRows = 200;
/** The most fields one record of a batch changes (the visible columns). */
export const recordsTableBatchEditMaximumFields = 50;

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string().max(65_536),
    z.array(jsonValueSchema).max(100),
    z.record(z.string().max(200), jsonValueSchema),
  ]),
);

/**
 * A link cell pasted as the title the person copied: the server resolves it, per person and per
 * field, to exactly one record they may read. It is the only form of a link value that is not a
 * record reference; the cap is the one a record picker reads titles by.
 */
export const pastedLinkTitleSchema = z
  .object({ pastedTitle: z.string().trim().min(1).max(200) })
  .strict();
export type PastedLinkTitle = z.infer<typeof pastedLinkTitleSchema>;

/** The title a cell value pastes, or undefined when the value is not a pasted title. */
export const pastedLinkTitleOf = (value: unknown): string | undefined => {
  const parsed = pastedLinkTitleSchema.safeParse(value);
  return parsed.success ? parsed.data.pastedTitle : undefined;
};

/**
 * One batch of cell changes on the loaded page: explicit record ids with the revision the person
 * saw, at most 200 of them, and the fields each changes. `commandId` is the person's one gesture:
 * submitting it again replays what it committed. It is the whole of the bounded explicit-ids
 * transaction contract of the bulk commands; there is no second selection shape.
 */
export const recordsTableBatchEditRequestSchema = z
  .object({
    pageKey: z.string().min(1).max(200),
    placementId: z.string().min(1).max(200),
    commandId: platformIdSchema,
    rows: z
      .array(
        z
          .object({
            recordId: recordIdSchema,
            revision: revisionSchema,
            /**
             * The value each changed field takes, exactly what a single inline edit would submit
             * (an exact decimal as canonical text, a date as an ISO date, a choice as its option
             * value, a link as its record reference or null). A pasted link is the title the
             * person copied, `{ pastedTitle }`, which the server resolves to one readable record.
             */
            values: z
              .record(fieldIdSchema, jsonValueSchema)
              .refine(
                (values) =>
                  Object.keys(values).length >= 1 &&
                  Object.keys(values).length <= recordsTableBatchEditMaximumFields,
                { message: "A row changes between 1 and 50 fields" },
              )
              .refine(
                (values) =>
                  Object.values(values).every(
                    (value) =>
                      typeof value !== "object" ||
                      value === null ||
                      !("pastedTitle" in value) ||
                      pastedLinkTitleSchema.safeParse(value).success,
                  ),
                { message: "A pasted link is one title of 1 to 200 characters" },
              ),
          })
          .strict(),
      )
      .min(1)
      .max(recordsTableBatchEditMaximumRows),
  })
  .strict();
export type RecordsTableBatchEditRequest = z.infer<typeof recordsTableBatchEditRequestSchema>;

/** Why one cell (or its whole record) stopped the batch; the server log keeps the cause. */
export const recordsTableBatchEditRefusalReasons = [
  /** The person may not change this record or this field now. */
  "not_permitted",
  /** The field is not one the table edits, or is withheld from the person. */
  "not_editable",
  /** The record changed after the person saw it. */
  "changed",
  /** The record was removed or the person can no longer see it. */
  "removed",
  /** The value is not valid for the field, or a rule refused it. */
  "invalid",
  /** The batch could not be written for another reason. */
  "refused",
] as const;
export type RecordsTableBatchEditRefusalReason =
  (typeof recordsTableBatchEditRefusalReasons)[number];

export const recordsTableBatchEditProblemSchema = z
  .object({
    recordId: recordIdSchema,
    /** Absent when the whole record is the problem (changed, removed, not permitted). */
    field: fieldIdSchema.optional(),
    reason: z.enum(recordsTableBatchEditRefusalReasons),
    message: z.string().max(500),
  })
  .strict();
export type RecordsTableBatchEditProblem = z.infer<typeof recordsTableBatchEditProblemSchema>;

/**
 * All changes were written, or none were. A refusal lists every problem found, per record and
 * field; `unavailable` means nothing is known to have been written and the same command may be
 * submitted again.
 */
export const recordsTableBatchEditResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("saved"),
      rows: z
        .array(
          z
            .object({
              recordId: recordIdSchema,
              /** The revision the record holds after the batch, for the inverse batch of an undo. */
              revision: revisionSchema,
              /** The values the batch replaced, per field, for the inverse batch of an undo. */
              previous: z.record(fieldIdSchema, jsonValueSchema),
            })
            .strict(),
        )
        .max(recordsTableBatchEditMaximumRows),
    })
    .strict(),
  recordsTableRequestRejectionSchema
    .extend({
      /** A request rejected before cell validation has no record or field problems. */
      problems: z.array(recordsTableBatchEditProblemSchema).min(1).max(1000).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
]);
export type RecordsTableBatchEditResult = z.infer<typeof recordsTableBatchEditResultSchema>;
