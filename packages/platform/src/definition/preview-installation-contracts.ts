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

export const previewInstallationCreateRequestSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    expectedDraftRevision: revisionSchema,
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

export type PreviewInstallationCreateRequest = z.infer<
  typeof previewInstallationCreateRequestSchema
>;
export type PreviewInstallation = z.infer<typeof previewInstallationSchema>;
export type PreviewApplicationIdentity = z.infer<typeof previewApplicationIdentitySchema>;
