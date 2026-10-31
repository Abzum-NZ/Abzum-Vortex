import { z } from "zod";
import { correlationIdSchema, jsonValueSchema } from "../catalogue/common";
import {
  applicationRootIdSchema,
  builderKeySchema,
  fieldIdSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  groupIdSchema,
  platformIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  storageContractIdSchema,
} from "../catalogue/identifiers";
import { safeErrorResponseSchema } from "./safe-error-contracts";

const sharedScopeFields = {
  organizationId: organizationIdSchema,
  moduleRootId: moduleRootIdSchema,
  recordTypeId: recordTypeIdSchema,
  storageContractId: storageContractIdSchema,
  recordId: recordIdSchema,
};

const organizationSharedRecordScopeSchema = z
  .object({ storageScope: z.literal("organization_shared"), ...sharedScopeFields })
  .strict();

const applicationContainedRecordScopeSchema = z
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
const submittedRecordValuesSchema = z.record(fieldIdSchema, jsonValueSchema);

const saveRecordCommandFields = {
  contractVersion: saveRecordContractVersionSchema,
  commandId: platformIdSchema,
  recordTypeId: recordTypeIdSchema,
  submittedValues: submittedRecordValuesSchema,
};

export const saveRecordCommandSchema = z.discriminatedUnion("operation", [
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
      expectedConcurrencyNumber: revisionSchema,
    })
    .strict(),
]);

const recordSaveFieldCorrectionSchema = z
  .object({
    code: z.enum(["invalid_value", "required_value", "field_refused"]),
    fieldId: fieldIdSchema,
    nestedPath: z
      .array(z.union([builderKeySchema, z.number().int().nonnegative()]))
      .min(1)
      .optional(),
    /** The readable reason safe to show: a refusing rule's authored message, or the field and option labels of a permission-gated choice. */
    message: z.string().min(1).max(300).optional(),
  })
  .strict();

const readableRecordSaveProjectionSchema = z
  .object({
    recordId: recordIdSchema,
    concurrencyNumber: revisionSchema,
    readableValues: z.record(fieldIdSchema, jsonValueSchema),
  })
  .strict();

const refusedSaveRecordResultSchema = z
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

export const saveRecordResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      contractVersion: saveRecordContractVersionSchema,
      outcome: z.literal("saved"),
      recordId: recordIdSchema,
      concurrencyNumber: revisionSchema,
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
  refusedSaveRecordResultSchema,
]);
export type RecordScope = z.infer<typeof recordScopeSchema>;
export type SaveRecordCommand = z.infer<typeof saveRecordCommandSchema>;
export type RecordSaveFieldCorrection = z.infer<typeof recordSaveFieldCorrectionSchema>;
export type SaveRecordResult = z.infer<typeof saveRecordResultSchema>;
