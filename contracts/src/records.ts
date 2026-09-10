import { z } from "zod";
import { correlationIdSchema, jsonValueSchema } from "./common";
import {
  applicationRootIdSchema,
  builderKeySchema,
  fieldIdSchema,
  moduleRootIdSchema,
  organizationIdSchema,
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
  z.object({ ...saveRecordCommandFields, operation: z.literal("create") }).strict(),
  z
    .object({
      ...saveRecordCommandFields,
      operation: z.literal("update"),
      recordId: recordIdSchema,
      expectedConcurrencyNumber: saveRecordRevisionSchema,
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
export type RecordSaveFieldCorrection = z.infer<typeof recordSaveFieldCorrectionSchema>;
export type SaveRecordResultV2 = z.infer<typeof saveRecordResultV2Schema>;
