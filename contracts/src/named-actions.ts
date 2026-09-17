import { z } from "zod";
import { correlationIdSchema, jsonValueSchema } from "./common";
import {
  actionIdSchema,
  applicationRootIdSchema,
  moduleRootIdSchema,
  platformIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  revisionSchema,
} from "./identifiers";
import { safeErrorResponseSchema } from "./operation-contracts";

export const installedNamedActionReferenceV2Schema = z.discriminatedUnion("ownerKind", [
  z
    .object({
      ownerKind: z.literal("application"),
      ownerId: applicationRootIdSchema,
      releaseRevision: revisionSchema.max(Number.MAX_SAFE_INTEGER),
      actionId: actionIdSchema,
    })
    .strict(),
  z
    .object({
      ownerKind: z.literal("module"),
      ownerId: moduleRootIdSchema,
      releaseRevision: revisionSchema.max(Number.MAX_SAFE_INTEGER),
      actionId: actionIdSchema,
    })
    .strict(),
]);

/** Closed human request for one exact published and installed named action. */
export const executeNamedActionCommandV2Schema = z
  .object({
    contractVersion: z.literal("2.0.0"),
    commandId: platformIdSchema,
    action: installedNamedActionReferenceV2Schema,
    recordTypeId: recordTypeIdSchema,
    recordId: recordIdSchema,
    expectedConcurrencyNumber: revisionSchema.max(Number.MAX_SAFE_INTEGER - 1),
    inputs: z.record(z.string().min(1).max(40), jsonValueSchema),
  })
  .strict();

export const executeNamedActionResultV2Schema = z.discriminatedUnion("outcome", [
  z
    .object({
      contractVersion: z.literal("2.0.0"),
      outcome: z.literal("completed"),
      recordId: recordIdSchema,
      concurrencyNumber: revisionSchema.max(Number.MAX_SAFE_INTEGER),
      readableValues: z.record(z.string().uuid(), jsonValueSchema),
      correlationId: correlationIdSchema,
      backgroundDelivery: z.literal("pending"),
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal("2.0.0"),
      outcome: z.literal("refused"),
      error: safeErrorResponseSchema,
    })
    .strict(),
]);

export type InstalledNamedActionReferenceV2 = z.infer<typeof installedNamedActionReferenceV2Schema>;
export type ExecuteNamedActionCommandV2 = z.infer<typeof executeNamedActionCommandV2Schema>;
export type ExecuteNamedActionResultV2 = z.infer<typeof executeNamedActionResultV2Schema>;
