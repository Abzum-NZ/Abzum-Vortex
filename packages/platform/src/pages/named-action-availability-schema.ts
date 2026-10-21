import { z } from "zod";
import { recordIdSchema, revisionSchema } from "../catalogue/identifiers";
import { recordsSelectionMaximumIds, recordsTableBulkRefusalReasons } from "./records-selection";

const targetSchema = z.object({ recordId: recordIdSchema, revision: revisionSchema }).strict();

/**
 * Drawn identities (page roots and opened tree children) at their displayed revisions, bounded by
 * the explicit selection maximum; matching descriptors cannot enter this path.
 */
export const namedActionAvailabilityRequestSchema = z
  .object({
    pageKey: z.string().min(1).max(200),
    placementId: z.string().min(1).max(200),
    targets: z
      .array(targetSchema)
      .min(1)
      .max(recordsSelectionMaximumIds)
      .refine(
        (targets) =>
          new Set(targets.map((target) => target.recordId.toLowerCase())).size === targets.length,
        "Each selected record must occur once",
      ),
  })
  .strict();
export type NamedActionAvailabilityRequest = z.infer<typeof namedActionAvailabilityRequestSchema>;

const actionSchema = z.discriminatedUnion("eligible", [
  z.object({ action: z.string().min(1).max(200), eligible: z.literal(true) }).strict(),
  z
    .object({
      action: z.string().min(1).max(200),
      eligible: z.literal(false),
      reason: z.enum(recordsTableBulkRefusalReasons),
    })
    .strict(),
]);

/** Permission results travel beside identities, never in a row's visible business values. */
export const namedActionAvailabilitySchema = z
  .array(
    targetSchema
      .extend({
        actions: z
          .array(actionSchema)
          .min(1)
          .max(20)
          .refine(
            (actions) => new Set(actions.map((action) => action.action)).size === actions.length,
            "Each declared action must occur once",
          ),
      })
      .strict(),
  )
  .max(200)
  .refine(
    (records) =>
      new Set(records.map((record) => record.recordId.toLowerCase())).size === records.length,
    "Each selected record must occur once",
  );
export type NamedActionAvailability = z.infer<typeof namedActionAvailabilitySchema>;

export const namedActionAvailabilityResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("available"), records: namedActionAvailabilitySchema }).strict(),
  z.object({ kind: z.literal("refused") }).strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
]);
export type NamedActionAvailabilityResult = z.infer<typeof namedActionAvailabilityResultSchema>;
