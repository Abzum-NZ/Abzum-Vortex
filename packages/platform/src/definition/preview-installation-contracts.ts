import { z } from "zod";
import {
  applicationRootIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  revisionSchema,
  timestampSchema,
} from "../catalogue/identifiers";

export const previewInstallationIdSchema = z
  .uuid()
  .refine((value) => value !== "00000000-0000-0000-0000-000000000000");

/** The fingerprint of the parts of an Application draft a preview's data and access depend on. */
const shapeFingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const previewInstallationCreateRequestSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    expectedDraftRevision: revisionSchema,
    shapeFingerprint: shapeFingerprintSchema,
  })
  .strict();

/** Moves the builder's existing preview to the current draft revision in place. */
export const previewInstallationRefreshRequestSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    previewInstallationId: z.uuid(),
    expectedDraftRevision: revisionSchema,
    shapeFingerprint: shapeFingerprintSchema,
  })
  .strict();

/** One preview of an Application draft: the draft revision it runs and the release it pins. */
export const previewInstallationSchema = z
  .object({
    previewInstallationId: previewInstallationIdSchema,
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    draftRevision: revisionSchema,
    applicationReleaseRevision: revisionSchema,
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict()
  .refine((value) => Date.parse(value.expiresAt) > Date.parse(value.createdAt), {
    path: ["expiresAt"],
    message: "Preview installation expiry must follow creation",
  });

/** The Application one preview runs, as a builder of its organisation may address it. */
export const previewApplicationIdentitySchema = z
  .object({
    previewInstallationId: previewInstallationIdSchema,
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    definitionKey: namespacedKeySchema,
    draftRevision: revisionSchema,
    expiresAt: timestampSchema,
    /** Whether the preview holds copies of live records, which are decided again on opening. */
    seeded: z.boolean(),
  })
  .strict();

/** The builder's current preview of one Application, as Studio decides whether it can read it. */
export const builderPreviewInstallationSchema = previewApplicationIdentitySchema
  .extend({
    /** The data shape of the draft revision it runs; absent for a preview made before shapes. */
    shapeFingerprint: shapeFingerprintSchema.nullable(),
    /** Whether its copied live records are due to be decided again before a read. */
    reconcileDue: z.boolean(),
  })
  .strict();

export type PreviewInstallationCreateRequest = z.infer<
  typeof previewInstallationCreateRequestSchema
>;
export type PreviewInstallationRefreshRequest = z.infer<
  typeof previewInstallationRefreshRequestSchema
>;
export type BuilderPreviewInstallation = z.infer<typeof builderPreviewInstallationSchema>;
export type PreviewInstallation = z.infer<typeof previewInstallationSchema>;
export type PreviewApplicationIdentity = z.infer<typeof previewApplicationIdentitySchema>;
