import { z } from "zod";
import { correlationIdSchema } from "../catalogue/common";
import { actorIdSchema, builderKeySchema, timestampSchema } from "../catalogue/identifiers";
import { protectedOperationChannelSchema } from "../definition/application-flow-bindings";

export const activityActorKindSchema = z.enum([
  "identity",
  "organization_account",
  "system",
  "public_session",
]);

export const activitySourceSchema = protectedOperationChannelSchema;

export const activityOutcomeSchema = z.enum(["completed", "refused", "failed"]);

/**
 * The two protected Activity projections. Every caller may read the activity
 * they performed (`own`); the organisation-wide `audit` projection additionally
 * requires the organisation's access-administration read authority, so a plain
 * account never enumerates another account's activity.
 */
export const activityProjectionSchema = z.enum(["own", "audit"]);

/** Bounded Activity filters. Every filter is optional and combined conjunctively. */
export const activityHistoryFilterSchema = z
  .object({
    occurredFrom: timestampSchema.optional(),
    occurredTo: timestampSchema.optional(),
    actorKind: activityActorKindSchema.optional(),
    actorId: actorIdSchema.optional(),
    action: builderKeySchema.optional(),
    correlationId: correlationIdSchema.optional(),
    outcome: activityOutcomeSchema.optional(),
    source: activitySourceSchema.optional(),
  })
  .strict()
  .refine(
    (filter) =>
      filter.occurredFrom === undefined ||
      filter.occurredTo === undefined ||
      Date.parse(filter.occurredFrom) <= Date.parse(filter.occurredTo),
    { message: "An Activity window cannot start after it ends" },
  );

/** The bounded dimension one Activity aggregate may group by. */
export const activityAggregateDimensionSchema = z.enum([
  "action",
  "actorKind",
  "source",
  "outcome",
]);
