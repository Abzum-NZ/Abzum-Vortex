import { z } from "zod";
import {
  applicationCompilationOutputV2Schema,
} from "./definition-compilation-contracts";
import {
  applicationRootIdSchema,
  identityIdSchema,
  moduleRootIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  storageContractIdSchema,
  timestampSchema,
} from "./identifiers";

export const previewInstallationIdSchema = z
  .uuid()
  .refine((value) => value !== "00000000-0000-0000-0000-000000000000");

export const previewInstallationCandidateSchema = z
  .object({
    compilation: applicationCompilationOutputV2Schema,
    currentReleaseRevision: revisionSchema.nullable(),
  })
  .strict();

export const previewInstallationCreateRequestSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    expectedDraftRevision: revisionSchema,
  })
  .strict();

export const previewInstallationAddressSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    previewInstallationId: previewInstallationIdSchema,
  })
  .strict();

export const previewInstallationStorageIdentitySchema = z
  .object({
    moduleRootId: moduleRootIdSchema,
    moduleReleaseRevision: revisionSchema,
    recordTypeId: recordTypeIdSchema,
    releaseStorageContractId: storageContractIdSchema,
    previewStorageContractId: storageContractIdSchema,
  })
  .strict();

export const previewInstallationResolvedModuleSchema = z
  .object({
    moduleRootId: moduleRootIdSchema,
    moduleReleaseRevision: revisionSchema,
    releaseVersion: z.string().min(1).max(120),
  })
  .strict();

export const previewInstallationSchema = z
  .object({
    previewInstallationId: previewInstallationIdSchema,
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    draftRevision: revisionSchema,
    previewerIdentityId: identityIdSchema,
    previewerOrganizationAccountId: organizationAccountIdSchema,
    candidate: previewInstallationCandidateSchema,
    resolvedModules: z.array(previewInstallationResolvedModuleSchema).max(10_000),
    storageIdentities: z.array(previewInstallationStorageIdentitySchema).max(10_000),
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict()
  .refine((value) => Date.parse(value.expiresAt) > Date.parse(value.createdAt), {
    path: ["expiresAt"],
    message: "Preview installation expiry must follow creation",
  });

export const previewInstallationExpiryRequestSchema = z
  .object({
    organizationId: organizationIdSchema,
    limit: z.number().int().min(1).max(100).default(100),
  })
  .strict();

export const previewInstallationExpiryResultSchema = z
  .object({ expiredCount: z.number().int().min(0).max(100) })
  .strict();

export const previewInstallationDiscardResultSchema = z
  .object({
    discarded: z.literal(true),
    previewInstallationId: previewInstallationIdSchema,
  })
  .strict();

export type PreviewInstallationCandidate = z.infer<typeof previewInstallationCandidateSchema>;
export type PreviewInstallationCreateRequest = z.infer<
  typeof previewInstallationCreateRequestSchema
>;
export type PreviewInstallationAddress = z.infer<typeof previewInstallationAddressSchema>;
export type PreviewInstallationStorageIdentity = z.infer<
  typeof previewInstallationStorageIdentitySchema
>;
export type PreviewInstallationResolvedModule = z.infer<
  typeof previewInstallationResolvedModuleSchema
>;
export type PreviewInstallation = z.infer<typeof previewInstallationSchema>;
export type PreviewInstallationExpiryRequest = z.input<
  typeof previewInstallationExpiryRequestSchema
>;
export type PreviewInstallationExpiryResult = z.infer<
  typeof previewInstallationExpiryResultSchema
>;
export type PreviewInstallationDiscardResult = z.infer<
  typeof previewInstallationDiscardResultSchema
>;
