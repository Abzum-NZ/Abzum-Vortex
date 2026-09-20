import { z } from "zod";
import { lifecycleStateSchema } from "./catalogues";
import {
  applicationRootIdSchema,
  groupIdSchema,
  organizationAccountIdSchema,
  platformIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  storageContractIdSchema,
} from "./identifiers";

export const recordOffboardingContractVersionSchema = z.literal("1.0.0");
const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);
const javascriptSafeCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const recordOffboardingSectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("organization_shared") }).strict(),
  z
    .object({
      kind: z.literal("application"),
      applicationRootId: applicationRootIdSchema,
    })
    .strict(),
]);

export const recordOffboardingTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("organization_account"),
      targetOrganizationAccountId: organizationAccountIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("group"), targetGroupId: groupIdSchema }).strict(),
]);

export const recordOffboardingCursorSchema = z
  .object({
    storageContractId: storageContractIdSchema,
    recordId: recordIdSchema,
  })
  .strict();

export const recordOffboardingInventoryClassificationSchema = z.enum([
  "transferable",
  "refused_incompatible",
]);

export const recordOffboardingInventoryCommandSchema = z
  .object({
    contractVersion: recordOffboardingContractVersionSchema,
    sourceOrganizationAccountId: organizationAccountIdSchema,
    section: recordOffboardingSectionSchema,
    target: recordOffboardingTargetSchema,
    pageSize: z.number().int().min(1).max(50),
    after: recordOffboardingCursorSchema.optional(),
  })
  .strict();

export const recordOffboardingInventoryItemSchema = z
  .object({
    recordTypeId: recordTypeIdSchema,
    recordId: recordIdSchema,
    concurrencyNumber: javascriptSafeRevisionSchema,
    lifecycleState: lifecycleStateSchema,
    installationState: z.enum(["active", "detached"]),
    classification: recordOffboardingInventoryClassificationSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.lifecycleState === "removal_pending" &&
      value.classification !== "refused_incompatible"
    )
      context.addIssue({
        code: "custom",
        path: ["classification"],
        message: "A removal-pending record must be classified as refused-incompatible",
      });
  });

export const recordOffboardingPerRecordTypeCountSchema = z
  .object({
    recordTypeId: recordTypeIdSchema,
    transferable: javascriptSafeCountSchema,
    refusedIncompatible: javascriptSafeCountSchema,
  })
  .strict();

export const recordOffboardingSharedImpactSchema = z
  .object({
    storageContractId: storageContractIdSchema,
    applicationRootIds: z.array(applicationRootIdSchema).min(1),
  })
  .strict();

const recordOffboardingInventoryResultFields = {
  contractVersion: recordOffboardingContractVersionSchema,
  items: z.array(recordOffboardingInventoryItemSchema).max(50),
  // These are running totals across the full paged walk, so the number of
  // record types is not bounded by one page's 50-item limit.
  perRecordType: z.array(recordOffboardingPerRecordTypeCountSchema),
  next: recordOffboardingCursorSchema.optional(),
  complete: z.boolean(),
  accessVersion: javascriptSafeRevisionSchema,
};

export const recordOffboardingInventoryResultSchema = z
  .union([
    z
      .object({
        ...recordOffboardingInventoryResultFields,
        section: z.object({ kind: z.literal("organization_shared") }).strict(),
        sharedImpact: z.array(recordOffboardingSharedImpactSchema),
      })
      .strict(),
    z
      .object({
        ...recordOffboardingInventoryResultFields,
        section: z
          .object({
            kind: z.literal("application"),
            applicationRootId: applicationRootIdSchema,
          })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.complete === (value.next !== undefined))
      context.addIssue({
        code: "custom",
        path: ["next"],
        message: "A next cursor is present exactly while the inventory is incomplete",
      });
  });

export const offboardingTransferBatchEntrySchema = z.enum(["public", "offboarding"]);

export const offboardingTransferBatchCommandSchema = z
  .object({
    contractVersion: recordOffboardingContractVersionSchema,
    batchId: platformIdSchema,
    sourceOrganizationAccountId: organizationAccountIdSchema,
    targetOrganizationAccountId: organizationAccountIdSchema,
    items: z
      .array(
        z
          .object({
            recordTypeId: recordTypeIdSchema,
            recordId: recordIdSchema,
            expectedConcurrencyNumber: javascriptSafeRevisionSchema,
            entry: offboardingTransferBatchEntrySchema,
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

export const offboardingTransferBatchRefusalCodeSchema = z.enum([
  "operation_refused",
  "record_unavailable",
  "owner_unavailable",
]);

export const offboardingTransferBatchConflictCodeSchema = z.enum([
  "concurrency_conflict",
  "command_identity_conflict",
]);

const offboardingTransferBatchItemIdentity = {
  recordTypeId: recordTypeIdSchema,
  recordId: recordIdSchema,
};

export const offboardingTransferBatchItemResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      ...offboardingTransferBatchItemIdentity,
      outcome: z.literal("completed"),
      concurrencyNumber: javascriptSafeRevisionSchema,
      replayed: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...offboardingTransferBatchItemIdentity,
      outcome: z.literal("conflicted"),
      conflictCode: offboardingTransferBatchConflictCodeSchema,
    })
    .strict(),
  z
    .object({
      ...offboardingTransferBatchItemIdentity,
      outcome: z.literal("refused"),
      refusalCode: offboardingTransferBatchRefusalCodeSchema,
    })
    .strict(),
]);

export const offboardingTransferBatchResultSchema = z
  .object({
    contractVersion: recordOffboardingContractVersionSchema,
    batchId: platformIdSchema,
    items: z.array(offboardingTransferBatchItemResultSchema).min(1).max(50),
    completed: javascriptSafeCountSchema,
    conflicted: javascriptSafeCountSchema,
    refused: javascriptSafeCountSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const actual = { completed: 0, conflicted: 0, refused: 0 };
    for (const item of value.items) actual[item.outcome] += 1;
    for (const outcome of ["completed", "conflicted", "refused"] as const)
      if (value[outcome] !== actual[outcome])
        context.addIssue({
          code: "custom",
          path: [outcome],
          message: `The ${outcome} count must match the per-record outcomes`,
        });
  });

export type RecordOffboardingSection = z.infer<typeof recordOffboardingSectionSchema>;
export type RecordOffboardingTarget = z.infer<typeof recordOffboardingTargetSchema>;
export type RecordOffboardingCursor = z.infer<typeof recordOffboardingCursorSchema>;
export type RecordOffboardingInventoryCommand = z.infer<
  typeof recordOffboardingInventoryCommandSchema
>;
export type RecordOffboardingInventoryResult = z.infer<
  typeof recordOffboardingInventoryResultSchema
>;
export type OffboardingTransferBatchCommand = z.infer<typeof offboardingTransferBatchCommandSchema>;
export type OffboardingTransferBatchResult = z.infer<typeof offboardingTransferBatchResultSchema>;
