import { z } from "zod";
import { applicationSourceDocumentSchema, moduleSourceDocumentSchema } from "./definition-source";
import {
  actorIdSchema,
  applicationRootIdSchema,
  connectionTypeIdSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  platformIdSchema,
  revisionSchema,
  semanticVersionSchema,
  timestampSchema,
} from "./identifiers";
import {
  stableDefinitionReleaseVersionSchema,
  versionImpactReasonSchema,
  versionImpactSchema,
} from "./version-impact";

const storedDefinitionSourceSchema = z.discriminatedUnion("kind", [
  moduleSourceDocumentSchema,
  applicationSourceDocumentSchema,
]);
const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);

export const createDefinitionRootCommandSchema = z
  .object({ source: storedDefinitionSourceSchema })
  .strict();

export const saveDefinitionDraftCommandSchema = z
  .object({
    rootId: platformIdSchema,
    expectedDraftRevision: javascriptSafeRevisionSchema,
    source: storedDefinitionSourceSchema,
  })
  .strict();

const storedDraftMetadata = {
  organizationId: organizationIdSchema,
  key: namespacedKeySchema,
  draftRevision: javascriptSafeRevisionSchema,
  publishedRevision: javascriptSafeRevisionSchema.optional(),
  sourceContractVersion: semanticVersionSchema,
  sourceFingerprint: fingerprintSchema,
  createdAt: timestampSchema,
  createdBy: actorIdSchema,
  updatedAt: timestampSchema,
  updatedBy: actorIdSchema,
};

export const storedDefinitionDraftSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("module"),
      rootId: moduleRootIdSchema,
      source: moduleSourceDocumentSchema,
      ...storedDraftMetadata,
    })
    .strict(),
  z
    .object({
      kind: z.literal("application"),
      rootId: applicationRootIdSchema,
      source: applicationSourceDocumentSchema,
      ...storedDraftMetadata,
    })
    .strict(),
]);

const exactDependencyCommon = {
  key: namespacedKeySchema,
  releaseVersion: stableDefinitionReleaseVersionSchema,
  contentFingerprint: fingerprintSchema,
};

export const exactDefinitionDependencySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("module"),
      ...exactDependencyCommon,
      rootId: moduleRootIdSchema,
      releaseRevision: javascriptSafeRevisionSchema,
      resolutionFingerprint: fingerprintSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("connection_type"),
      ...exactDependencyCommon,
      rootId: connectionTypeIdSchema,
      catalogueFingerprint: fingerprintSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("platform_theme"),
      catalogueThemeId: z
        .uuid()
        .refine((value) => value !== "00000000-0000-0000-0000-000000000000"),
      releaseVersion: stableDefinitionReleaseVersionSchema,
      contentFingerprint: fingerprintSchema,
      catalogueFingerprint: fingerprintSchema,
    })
    .strict(),
]);

const dependencyManifestSchema = z
  .array(exactDefinitionDependencySchema)
  .max(10_000)
  .superRefine((entries, context) => {
    const subjects = entries.map((entry) =>
      entry.kind === "platform_theme"
        ? `${entry.kind}:${entry.catalogueThemeId}`
        : `${entry.kind}:${entry.key}`,
    );
    if (new Set(subjects).size !== subjects.length)
      context.addIssue({
        code: "custom",
        message: "An exact dependency manifest must contain one release per subject",
      });
    if (subjects.some((subject, index) => index > 0 && subjects[index - 1]! > subject))
      context.addIssue({
        code: "custom",
        message: "An exact dependency manifest must use deterministic subject order",
      });
  });

export const prepareDefinitionPublicationCommandSchema = z
  .object({
    rootId: platformIdSchema,
    expectedDraftRevision: javascriptSafeRevisionSchema,
  })
  .strict();

const publicationConfirmationCommon = {
  rootId: platformIdSchema,
  expectedDraftRevision: javascriptSafeRevisionSchema,
  sourceFingerprint: fingerprintSchema,
  assignedVersion: stableDefinitionReleaseVersionSchema,
  contentFingerprint: fingerprintSchema,
  resolutionFingerprint: fingerprintSchema,
  comparisonFingerprint: fingerprintSchema,
  dependencyManifest: dependencyManifestSchema,
};

export const definitionPublicationConfirmationSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("initial_release"),
      ...publicationConfirmationCommon,
      reasons: z.array(versionImpactReasonSchema).max(0),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("release_required"),
      ...publicationConfirmationCommon,
      impact: versionImpactSchema,
      reasons: z.array(versionImpactReasonSchema).min(1),
    })
    .strict(),
]);

export const prepareDefinitionPublicationResultSchema = z
  .object({ confirmation: definitionPublicationConfirmationSchema })
  .strict();

export const publishDefinitionCommandSchema = z
  .object({
    confirmation: definitionPublicationConfirmationSchema,
    releaseNote: z
      .string()
      .min(1)
      .max(2_000)
      .refine((value) => value === value.trim(), "Release notes must not have outer whitespace"),
  })
  .strict();

export const publishDefinitionResultSchema = z
  .object({
    rootId: platformIdSchema,
    releaseRevision: javascriptSafeRevisionSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    contentFingerprint: fingerprintSchema,
    resolutionFingerprint: fingerprintSchema,
    comparisonFingerprint: fingerprintSchema,
    dependencyManifest: dependencyManifestSchema,
    publishedAt: timestampSchema,
    publishedBy: actorIdSchema,
  })
  .strict();

export type CreateDefinitionRootCommand = z.infer<typeof createDefinitionRootCommandSchema>;
export type SaveDefinitionDraftCommand = z.infer<typeof saveDefinitionDraftCommandSchema>;
export type StoredDefinitionDraft = z.infer<typeof storedDefinitionDraftSchema>;
export type ExactDefinitionDependency = z.infer<typeof exactDefinitionDependencySchema>;
export type PrepareDefinitionPublicationCommand = z.infer<
  typeof prepareDefinitionPublicationCommandSchema
>;
export type DefinitionPublicationConfirmation = z.infer<
  typeof definitionPublicationConfirmationSchema
>;
export type PrepareDefinitionPublicationResult = z.infer<
  typeof prepareDefinitionPublicationResultSchema
>;
export type PublishDefinitionCommand = z.infer<typeof publishDefinitionCommandSchema>;
export type PublishDefinitionResult = z.infer<typeof publishDefinitionResultSchema>;
