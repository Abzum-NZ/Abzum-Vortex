import { z } from "zod";
import { jsonValueSchema } from "./common";
import {
  flowTestRunResultSchema,
  flowTestRunTaskTraceEntrySchema,
} from "./flow-test-run-contracts";
import { flowIdSchema } from "./flow-contracts";
import { formContinuationIntentSchema } from "./form-continuation-contracts";
import {
  applicationRootIdSchema,
  builderKeySchema,
  organizationIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  revisionSchema,
} from "./identifiers";
import {
  previewInstallationCreateRequestSchema,
  previewInstallationDiscardResultSchema,
  previewInstallationSchema,
} from "./preview-installation-contracts";
import { saveRecordCommandV2Schema, saveRecordResultV2Schema } from "./records";
import { publicDefinitionValidationErrorSchema } from "./validation-errors";

export const builderPreviewOperationLocationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("request") }).strict(),
  z
    .object({
      kind: z.literal("draft"),
      organizationId: organizationIdSchema,
      applicationRootId: applicationRootIdSchema,
      expectedDraftRevision: revisionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("preview"),
      organizationId: organizationIdSchema,
      applicationRootId: applicationRootIdSchema,
      previewInstallationId: z.uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("record"),
      organizationId: organizationIdSchema,
      applicationRootId: applicationRootIdSchema,
      previewInstallationId: z.uuid(),
      recordTypeId: recordTypeIdSchema,
      recordId: recordIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("flow"),
      organizationId: organizationIdSchema,
      applicationRootId: applicationRootIdSchema,
      previewInstallationId: z.uuid(),
      flowId: flowIdSchema,
    })
    .strict(),
]);

export const builderPreviewOperationRefusalReasons = [
  "invalid_request",
  "unauthenticated",
  "permission_refused",
  "draft_stale",
  "validation",
  "preview_unavailable",
  "preview_expired",
  "flow_unavailable",
  "flow_not_runnable",
  "flow_not_authorized",
  "record_refused",
  "record_conflict",
  "temporarily_unavailable",
  "operation_failed",
] as const;

export const builderPreviewOperationRefusalSchema = z
  .object({
    kind: z.literal("refused"),
    reason: z.enum(builderPreviewOperationRefusalReasons),
    location: builderPreviewOperationLocationSchema,
    validationErrors: z.array(publicDefinitionValidationErrorSchema).max(200).optional(),
  })
  .strict();

export const builderPreviewCreateRequestSchema = previewInstallationCreateRequestSchema;
export const builderPreviewReadRequestSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    previewInstallationId: z
      .uuid()
      .refine((value) => value !== "00000000-0000-0000-0000-000000000000"),
    expectedDraftRevision: revisionSchema,
  })
  .strict();
export const builderPreviewDiscardRequestSchema = builderPreviewReadRequestSchema;

export const builderPreviewRunFlowRequestSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    previewInstallationId: z
      .uuid()
      .refine((value) => value !== "00000000-0000-0000-0000-000000000000"),
    expectedDraftRevision: revisionSchema,
    flowId: flowIdSchema,
    sampleInputs: z.record(builderKeySchema, jsonValueSchema).default({}),
  })
  .strict();

export const builderPreviewSaveRecordRequestSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    previewInstallationId: z
      .uuid()
      .refine((value) => value !== "00000000-0000-0000-0000-000000000000"),
    expectedDraftRevision: revisionSchema,
    command: saveRecordCommandV2Schema,
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.command.previewInstallationId !== undefined &&
      request.command.previewInstallationId !== request.previewInstallationId
    )
      context.addIssue({
        code: "custom",
        path: ["command", "previewInstallationId"],
        message: "The record command must address the requested preview installation",
      });
  });

export const builderPreviewCreateResultSchema = z.union([
  builderPreviewOperationRefusalSchema,
  z.object({ kind: z.literal("created"), previewInstallation: previewInstallationSchema }).strict(),
]);

export const builderPreviewReadResultSchema = z.union([
  builderPreviewOperationRefusalSchema,
  z.object({ kind: z.literal("read"), previewInstallation: previewInstallationSchema }).strict(),
]);

export const builderPreviewDiscardResultSchema = z.union([
  builderPreviewOperationRefusalSchema,
  z.object({ kind: z.literal("discarded"), result: previewInstallationDiscardResultSchema }).strict(),
]);

export const builderPreviewRunFlowResultSchema = z.union([
  builderPreviewOperationRefusalSchema,
  z
    .object({
      kind: z.literal("completed"),
      runId: z.uuid(),
      flowId: flowIdSchema,
      result: flowTestRunResultSchema,
      trace: z.array(flowTestRunTaskTraceEntrySchema).max(10_000),
      intents: z.array(formContinuationIntentSchema).max(10_000),
    })
    .strict(),
]);

export const builderPreviewSaveRecordResultSchema = z.union([
  builderPreviewOperationRefusalSchema,
  z
    .object({
      kind: z.literal("completed"),
      result: saveRecordResultV2Schema.refine((result) => result.outcome !== "refused", {
        message: "A refused record save must be returned as a located refusal",
      }),
    })
    .strict(),
]);

export type BuilderPreviewOperationLocation = z.infer<
  typeof builderPreviewOperationLocationSchema
>;
export type BuilderPreviewOperationRefusal = z.infer<
  typeof builderPreviewOperationRefusalSchema
>;
export type BuilderPreviewCreateRequest = z.infer<typeof builderPreviewCreateRequestSchema>;
export type BuilderPreviewReadRequest = z.infer<typeof builderPreviewReadRequestSchema>;
export type BuilderPreviewDiscardRequest = z.infer<typeof builderPreviewDiscardRequestSchema>;
export type BuilderPreviewRunFlowRequest = z.infer<typeof builderPreviewRunFlowRequestSchema>;
export type BuilderPreviewSaveRecordRequest = z.infer<
  typeof builderPreviewSaveRecordRequestSchema
>;
export type BuilderPreviewCreateResult = z.infer<typeof builderPreviewCreateResultSchema>;
export type BuilderPreviewReadResult = z.infer<typeof builderPreviewReadResultSchema>;
export type BuilderPreviewDiscardResult = z.infer<typeof builderPreviewDiscardResultSchema>;
export type BuilderPreviewRunFlowResult = z.infer<typeof builderPreviewRunFlowResultSchema>;
export type BuilderPreviewSaveRecordResult = z.infer<
  typeof builderPreviewSaveRecordResultSchema
>;
