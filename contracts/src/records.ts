import { z } from "zod";
import { correlationIdSchema, jsonValueSchema } from "./common";
import {
  applicationRootIdSchema,
  builderKeySchema,
  fieldIdSchema,
  moduleRootIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  groupIdSchema,
  platformIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  storageContractIdSchema,
} from "./identifiers";
import { safeErrorResponseSchema } from "./operation-contracts";

const sharedScopeFields = {
  organizationId: organizationIdSchema,
  moduleRootId: moduleRootIdSchema,
  recordTypeId: recordTypeIdSchema,
  storageContractId: storageContractIdSchema,
  recordId: recordIdSchema,
};

export const organizationSharedRecordScopeSchema = z
  .object({ storageScope: z.literal("organization_shared"), ...sharedScopeFields })
  .strict();

export const applicationContainedRecordScopeSchema = z
  .object({
    storageScope: z.literal("application_contained"),
    ...sharedScopeFields,
    applicationRootId: applicationRootIdSchema,
  })
  .strict();

export const recordScopeSchema = z.discriminatedUnion("storageScope", [
  organizationSharedRecordScopeSchema,
  applicationContainedRecordScopeSchema,
]);

const saveRecordContractVersionSchema = z.literal("2.0.0");
const saveRecordRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);
const submittedRecordValuesSchema = z.record(fieldIdSchema, jsonValueSchema);

const saveRecordCommandFields = {
  contractVersion: saveRecordContractVersionSchema,
  commandId: platformIdSchema,
  recordTypeId: recordTypeIdSchema,
  submittedValues: submittedRecordValuesSchema,
};

export const saveRecordCommandV2Schema = z.discriminatedUnion("operation", [
  z
    .object({
      ...saveRecordCommandFields,
      operation: z.literal("create"),
      selectedOwnerGroupId: groupIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...saveRecordCommandFields,
      operation: z.literal("update"),
      recordId: recordIdSchema,
      expectedConcurrencyNumber: saveRecordRevisionSchema,
    })
    .strict(),
]);

const transferRecordOwnershipCommandFields = {
  contractVersion: saveRecordContractVersionSchema,
  commandId: platformIdSchema,
  recordTypeId: recordTypeIdSchema,
  recordId: recordIdSchema,
  expectedConcurrencyNumber: saveRecordRevisionSchema,
};

/**
 * Fixed single-record owner change.  This is intentionally distinct from a
 * field update and from named actions; server context supplies scope and actor.
 */
export const transferRecordOwnershipCommandV2Schema = z
  .discriminatedUnion("targetKind", [
    z
      .object({
        ...transferRecordOwnershipCommandFields,
        targetKind: z.literal("organization_account"),
        targetOrganizationAccountId: organizationAccountIdSchema,
      })
      .strict(),
    z
      .object({
        ...transferRecordOwnershipCommandFields,
        targetKind: z.literal("group"),
        targetGroupId: groupIdSchema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.targetKind === "organization_account" &&
      value.targetOrganizationAccountId === undefined
    )
      context.addIssue({
        code: "custom",
        message: "An account transfer requires an account target",
      });
    if (value.targetKind === "group" && value.targetGroupId === undefined)
      context.addIssue({ code: "custom", message: "A Group transfer requires a Group target" });
  });

export const transferRecordOwnershipResultV2Schema = z.discriminatedUnion("outcome", [
  z
    .object({
      contractVersion: saveRecordContractVersionSchema,
      outcome: z.literal("transferred"),
      recordId: recordIdSchema,
      concurrencyNumber: saveRecordRevisionSchema,
      correlationId: correlationIdSchema,
      replayed: z.boolean(),
    })
    .strict(),
  z
    .object({
      contractVersion: saveRecordContractVersionSchema,
      outcome: z.literal("refused"),
      error: safeErrorResponseSchema,
    })
    .strict(),
]);

export const recordSaveFieldCorrectionSchema = z
  .object({
    code: z.enum(["invalid_value", "required_value", "field_refused"]),
    fieldId: fieldIdSchema,
    nestedPath: z
      .array(z.union([builderKeySchema, z.number().int().nonnegative()]))
      .min(1)
      .optional(),
  })
  .strict();

const readableRecordSaveProjectionSchema = z
  .object({
    recordId: recordIdSchema,
    concurrencyNumber: saveRecordRevisionSchema,
    readableValues: z.record(fieldIdSchema, jsonValueSchema),
  })
  .strict();

const refusedSaveRecordResultV2Schema = z
  .object({
    contractVersion: saveRecordContractVersionSchema,
    outcome: z.literal("refused"),
    error: safeErrorResponseSchema,
    current: readableRecordSaveProjectionSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.current !== undefined && value.error.code !== "conflict")
      context.addIssue({
        code: "custom",
        path: ["current"],
        message: "A current readable projection is supplied only for a conflict",
      });
  });

export const saveRecordResultV2Schema = z.discriminatedUnion("outcome", [
  z
    .object({
      contractVersion: saveRecordContractVersionSchema,
      outcome: z.literal("saved"),
      recordId: recordIdSchema,
      concurrencyNumber: saveRecordRevisionSchema,
      readableValues: z.record(fieldIdSchema, jsonValueSchema),
      correlationId: correlationIdSchema,
      backgroundDelivery: z.enum(["none", "pending"]),
    })
    .strict(),
  z
    .object({
      contractVersion: saveRecordContractVersionSchema,
      outcome: z.literal("correction_required"),
      correlationId: correlationIdSchema,
      corrections: z.array(recordSaveFieldCorrectionSchema).min(1),
    })
    .strict(),
  refusedSaveRecordResultV2Schema,
]);

export type RecordScope = z.infer<typeof recordScopeSchema>;
export type SaveRecordCommandV2 = z.infer<typeof saveRecordCommandV2Schema>;
export type TransferRecordOwnershipCommandV2 = z.infer<
  typeof transferRecordOwnershipCommandV2Schema
>;
export type TransferRecordOwnershipResultV2 = z.infer<typeof transferRecordOwnershipResultV2Schema>;
export type RecordSaveFieldCorrection = z.infer<typeof recordSaveFieldCorrectionSchema>;
export type SaveRecordResultV2 = z.infer<typeof saveRecordResultV2Schema>;
