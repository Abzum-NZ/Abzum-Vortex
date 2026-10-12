import { z } from "zod";
import { correlationIdSchema, jsonValueSchema } from "../catalogue/common";
import {
  actionIdSchema,
  applicationRootIdSchema,
  moduleRootIdSchema,
  platformIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  revisionSchema,
} from "../catalogue/identifiers";
import { safeErrorResponseSchema } from "../definition/operation-contracts";

export const installedNamedActionReferenceSchema = z.discriminatedUnion("ownerKind", [
  z
    .object({
      ownerKind: z.literal("application"),
      ownerId: applicationRootIdSchema,
      releaseRevision: revisionSchema,
      actionId: actionIdSchema,
    })
    .strict(),
  z
    .object({
      ownerKind: z.literal("module"),
      ownerId: moduleRootIdSchema,
      releaseRevision: revisionSchema,
      actionId: actionIdSchema,
    })
    .strict(),
]);

/** Closed human request for one exact published and installed named action. */
export const executeNamedActionCommandSchema = z
  .object({
    contractVersion: z.literal("2.0.0"),
    commandId: platformIdSchema,
    action: installedNamedActionReferenceSchema,
    recordTypeId: recordTypeIdSchema,
    recordId: recordIdSchema,
    expectedConcurrencyNumber: revisionSchema.max(Number.MAX_SAFE_INTEGER - 1),
    inputs: z.record(z.string().min(1).max(40), jsonValueSchema),
  })
  .strict();

export const executeNamedActionResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      contractVersion: z.literal("2.0.0"),
      outcome: z.literal("completed"),
      recordId: recordIdSchema,
      concurrencyNumber: revisionSchema,
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

export type InstalledNamedActionReference = z.infer<typeof installedNamedActionReferenceSchema>;
export type ExecuteNamedActionCommand = z.infer<typeof executeNamedActionCommandSchema>;
export type ExecuteNamedActionResult = z.infer<typeof executeNamedActionResultSchema>;
