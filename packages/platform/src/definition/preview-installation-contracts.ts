import { z } from "zod";
import {
  applicationRootIdSchema,
  containedComponentIdSchema,
  fieldIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  recordTypeIdSchema,
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

/**
 * What the visible readers of a preview need: the record types they read, the fields they show and
 * the relationship paths their predicates and sorts follow. The database decides what else the
 * preview needs for them.
 */
export const previewDemandSchema = z
  .object({
    recordTypes: z
      .array(
        z
          .object({
            recordTypeId: recordTypeIdSchema,
            fieldIds: z.array(fieldIdSchema).max(500),
            relationshipPaths: z.array(z.array(containedComponentIdSchema).min(1).max(8)).max(50),
          })
          .strict(),
      )
      .min(1)
      .max(201),
  })
  .strict();

/** Seeds the builder's preview, in the installed Application's context, with what a demand needs. */
export const previewInstallationMaterializeRequestSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    previewInstallationId: previewInstallationIdSchema,
    expectedDraftRevision: revisionSchema,
    demand: previewDemandSchema,
  })
  .strict();

/** One seed: the record types the demand needs, those it seeded now and those still worked out. */
export const previewSeedResultSchema = z
  .object({
    draftRevision: revisionSchema,
    closure: z.array(recordTypeIdSchema),
    seeded: z.array(recordTypeIdSchema),
    pendingDerived: z.array(recordTypeIdSchema),
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
    /** Whether its builder's live records reach it through the installed Application. */
    seedable: z.boolean(),
    /** Every record type it has storage for: the record types a demand may name. */
    recordTypeIds: z.array(recordTypeIdSchema),
    /** The seeded record types whose totals and stored calculations are worked out. */
    derivedReadyRecordTypeIds: z.array(recordTypeIdSchema),
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
    /** Whether its builder's live records reach it through the installed Application. */
    seedable: z.boolean(),
    /** The record types it was seeded with; their copied live records are decided again on opening. */
    seededRecordTypeIds: z.array(recordTypeIdSchema),
    /** The seeded record types whose totals and stored calculations are worked out. */
    derivedReadyRecordTypeIds: z.array(recordTypeIdSchema),
  })
  .strict();

/** The builder's current preview of one Application, as Studio decides whether it can read it. */
export const builderPreviewInstallationSchema = previewApplicationIdentitySchema
  .extend({
    /** The data shape of the draft revision it runs; absent for a preview made before shapes. */
    shapeFingerprint: shapeFingerprintSchema.nullable(),
    /** Every record type it has storage for: the record types a demand may name. */
    recordTypeIds: z.array(recordTypeIdSchema),
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
export type PreviewDemand = z.infer<typeof previewDemandSchema>;
export type PreviewInstallationMaterializeRequest = z.infer<
  typeof previewInstallationMaterializeRequestSchema
>;
export type PreviewSeedResult = z.infer<typeof previewSeedResultSchema>;
export type BuilderPreviewInstallation = z.infer<typeof builderPreviewInstallationSchema>;
export type PreviewInstallation = z.infer<typeof previewInstallationSchema>;
export type PreviewApplicationIdentity = z.infer<typeof previewApplicationIdentitySchema>;
