import { z } from "zod";
import { platformIdSchema, recordIdSchema, revisionSchema } from "../catalogue/identifiers";

/**
 * What a person selected in a Records table, as every bulk command over a table takes it: bulk
 * named actions now, and the CSV and Excel exports. It is one of two kinds.
 *
 * - `ids`: rows of the shown page, each with the revision the person saw; at most one page (200).
 * - `matching`: every record the table's bound query, parameter bindings, filters and search match,
 *   minus the records the person unticked. The browser never lists those records: `token` is the
 *   descriptor the server sealed when it read the shown page (placement, release, resolved
 *   parameter bindings and the query state minus the page), bound to the person, organisation,
 *   application and release like a continuation token. The server resolves it again when the
 *   command runs, under the person's current access, in bounded batches.
 */
export const recordsSelectionMaximumIds = 200;
export const recordsSelectionMaximumExclusions = 200;

const selectionTokenSchema = z
  .string()
  .min(1)
  .max(65_536)
  .regex(/^[A-Za-z0-9_-]+$/);

export const recordsSelectionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ids"),
      items: z
        .array(z.object({ recordId: recordIdSchema, revision: revisionSchema }).strict())
        .min(1)
        .max(recordsSelectionMaximumIds),
    })
    .strict(),
  z
    .object({
      kind: z.literal("matching"),
      token: selectionTokenSchema,
      excluded: z.array(recordIdSchema).max(recordsSelectionMaximumExclusions),
    })
    .strict(),
]);
export type RecordsSelection = z.infer<typeof recordsSelectionSchema>;
/** A selection as the browser builds it, before the server parses its identities. */
export type RecordsSelectionInput = z.input<typeof recordsSelectionSchema>;

/** The table placement and page a bulk command addresses; the page's own address names the rest. */
const placementCommandBase = {
  pageKey: z.string().min(1).max(200),
  placementId: z.string().min(1).max(200),
};

/** The count behind "Select all matching records", read once, when the person asks for it. */
export const recordsSelectionCountRequestSchema = z
  .object({ ...placementCommandBase, token: selectionTokenSchema })
  .strict();
export type RecordsSelectionCountRequest = z.infer<typeof recordsSelectionCountRequestSchema>;

/** The most records the one capped count path counts; above it the person narrows the filter. */
export const recordsSelectionCountCeiling = 100_000;

export const recordsSelectionCountResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("counted"), count: z.number().int().nonnegative() }).strict(),
  /** More records match than the count ceiling. */
  z.object({ kind: z.literal("too_many") }).strict(),
  /** A search narrows the table; the count path counts by filters only, so the search must go. */
  z.object({ kind: z.literal("search_not_counted") }).strict(),
  z.object({ kind: z.literal("refused") }).strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
]);
export type RecordsSelectionCountResult = z.infer<typeof recordsSelectionCountResultSchema>;

/**
 * One run of a declared bulk action over a selection. `commandId` is the person's one gesture:
 * submitting the same command again replays each record's completed change instead of repeating it.
 */
export const recordsTableBulkActionRequestSchema = z
  .object({
    ...placementCommandBase,
    action: z.string().min(1).max(200),
    commandId: platformIdSchema,
    selection: recordsSelectionSchema,
  })
  .strict();
export type RecordsTableBulkActionRequest = z.infer<typeof recordsTableBulkActionRequestSchema>;

/** Why a record of a bulk run was not changed, in the words the summary groups them by. */
export const recordsTableBulkRefusalReasons = [
  /** The action does not apply to the record in its current state (its precondition refused). */
  "not_applicable",
  /** The person may not run the action on the record. */
  "not_permitted",
  /** The record changed after the person selected it. */
  "changed",
  /** The record was removed, or the person can no longer see it. */
  "removed",
  /** The record's change was refused for another reason; the server log keeps the cause. */
  "refused",
] as const;
export type RecordsTableBulkRefusalReason = (typeof recordsTableBulkRefusalReasons)[number];

const countSchema = z.number().int().nonnegative();

/**
 * The lines a bulk run streams back: progress after every batch, then one summary. `total` is the
 * number of records the selection held when the run resolved it; `changed` counts the records the
 * selection gained or lost between the count the person confirmed and the run (drift).
 */
export const recordsTableBulkRunLineSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("progress"),
      total: countSchema,
      processed: countSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("summary"),
      total: countSchema,
      done: countSchema,
      refused: z
        .array(
          z.object({ reason: z.enum(recordsTableBulkRefusalReasons), count: countSchema }).strict(),
        )
        .max(recordsTableBulkRefusalReasons.length),
      /** Records not reached: the run stopped at the action's limit or could not continue. */
      notProcessed: countSchema,
      /** The run stopped because more records matched than the action's limit. */
      limited: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("refused") }).strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
]);
export type RecordsTableBulkRunLine = z.infer<typeof recordsTableBulkRunLineSchema>;
