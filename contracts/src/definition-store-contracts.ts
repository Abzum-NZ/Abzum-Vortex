import { z } from "zod";
import { correlationIdSchema } from "./common";
import { applicationSourceDocumentV2Schema, moduleSourceDocumentSchema } from "./definition-source";
import { flowTargetDependencySchema } from "./application-flow-bindings";
import {
  actorIdSchema,
  applicationRootIdSchema,
  blockIdSchema,
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

export const storedApplicationSourceDocumentSchema = applicationSourceDocumentV2Schema;
export const storedModuleSourceDocumentSchema = moduleSourceDocumentSchema;
export const storedDefinitionSourceSchema = z.union([
  storedModuleSourceDocumentSchema,
  storedApplicationSourceDocumentSchema,
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

export const createModuleRootCommandSchema = z
  .object({ source: moduleSourceDocumentSchema })
  .strict();

export const saveModuleDraftCommandSchema = z
  .object({
    rootId: moduleRootIdSchema,
    expectedDraftRevision: javascriptSafeRevisionSchema,
    source: moduleSourceDocumentSchema,
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
  restoredFromReleaseRevision: javascriptSafeRevisionSchema.optional(),
  restoredFromSourceFingerprint: fingerprintSchema.optional(),
  restoredBy: actorIdSchema.optional(),
  restoredAt: timestampSchema.optional(),
  restoreCorrelationId: correlationIdSchema.optional(),
};

type StoredDraftEvidence = {
  sourceContractVersion: string;
  source: { source_contract_version: string };
  updatedBy: string;
  updatedAt: string;
  restoredFromReleaseRevision?: number | undefined;
  restoredFromSourceFingerprint?: string | undefined;
  restoredBy?: string | undefined;
  restoredAt?: string | undefined;
  restoreCorrelationId?: string | undefined;
};

const validateStoredDraftEvidence = (draft: StoredDraftEvidence, context: z.RefinementCtx) => {
  if (draft.source.source_contract_version !== draft.sourceContractVersion)
    context.addIssue({
      code: "custom",
      path: ["sourceContractVersion"],
      message: "Stored source metadata must match its authored source",
      input: draft,
    });
  const provenance = [
    draft.restoredFromReleaseRevision,
    draft.restoredFromSourceFingerprint,
    draft.restoredBy,
    draft.restoredAt,
    draft.restoreCorrelationId,
  ];
  const populatedCount = provenance.filter((value) => value !== undefined).length;
  if (populatedCount !== 0 && populatedCount !== provenance.length)
    context.addIssue({
      code: "custom",
      message: "Restore provenance must be either complete or absent",
      input: draft,
    });
  if (
    populatedCount === provenance.length &&
    (draft.restoredBy !== draft.updatedBy || draft.restoredAt !== draft.updatedAt)
  )
    context.addIssue({
      code: "custom",
      message: "Restore provenance must match the draft update evidence",
      input: draft,
    });
};

export const storedDefinitionDraftSchema = z
  .union([
    z
      .object({
        kind: z.literal("module"),
        rootId: moduleRootIdSchema,
        source: storedModuleSourceDocumentSchema,
        ...storedDraftMetadata,
      })
      .strict(),
    z
      .object({
        kind: z.literal("application"),
        rootId: applicationRootIdSchema,
        source: storedApplicationSourceDocumentSchema,
        ...storedDraftMetadata,
      })
      .strict(),
  ])
  .superRefine(validateStoredDraftEvidence);

export const storedModuleDefinitionDraftSchema = z
  .object({
    kind: z.literal("module"),
    rootId: moduleRootIdSchema,
    source: moduleSourceDocumentSchema,
    ...storedDraftMetadata,
  })
  .strict()
  .superRefine(validateStoredDraftEvidence);

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
  z
    .object({
      kind: z.literal("platform_block"),
      blockId: blockIdSchema,
      releaseVersion: stableDefinitionReleaseVersionSchema,
      contentFingerprint: fingerprintSchema,
      catalogueFingerprint: fingerprintSchema,
    })
    .strict(),
  flowTargetDependencySchema,
]);

const dependencyManifestSchema = z
  .array(exactDefinitionDependencySchema)
  .max(10_000)
  .superRefine((entries, context) => {
    // IDs compare lower-cased, matching the database's lowercase dependency references,
    // so casing differences cannot hide a duplicate subject or break canonical order.
    const subjects = entries.map((entry) =>
      (
        entry.kind === "platform_theme"
          ? `${entry.kind}:${entry.catalogueThemeId}`
          : entry.kind === "platform_block"
            ? `${entry.kind}:${entry.blockId}@${entry.releaseVersion}`
            : entry.kind === "application_flow"
                ? `${entry.kind}:${entry.applicationRootId}:${entry.flowId}`
                : entry.kind === "application_flow_node"
                  ? `${entry.kind}:${entry.applicationRootId}:${entry.flowId}:${entry.nodeId}`
                  : entry.kind === "application_query"
                    ? `${entry.kind}:${entry.applicationRootId}:${entry.queryId}`
                    : entry.kind === "module_query"
                      ? `${entry.kind}:${entry.moduleRootId}:${entry.queryId}`
                      : entry.kind === "application_form"
                        ? `${entry.kind}:${entry.applicationRootId}:${entry.formId}`
                : entry.kind === "application_workflow"
                  ? `${entry.kind}:${entry.applicationRootId}:${entry.workflowId}`
                  : entry.kind === "application_action"
                    ? `${entry.kind}:${entry.applicationRootId}:${entry.actionId}`
                          : entry.kind === "protected_operation"
                            ? `${entry.kind}:${entry.operation.owner.kind}:${
                                entry.operation.owner.kind === "application"
                                  ? entry.operation.owner.applicationRootId
                                  : entry.operation.owner.kind === "module"
                                    ? entry.operation.owner.moduleRootId
                                    : entry.operation.owner.serviceId
                              }:${entry.operation.operationId}`
            : `${entry.kind}:${entry.key}`
      ).toLowerCase(),
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
export type CreateModuleRootCommand = z.infer<typeof createModuleRootCommandSchema>;
export type SaveModuleDraftCommand = z.infer<typeof saveModuleDraftCommandSchema>;
export type StoredDefinitionSource = z.infer<typeof storedDefinitionSourceSchema>;
export type StoredModuleSourceDocument = z.infer<typeof storedModuleSourceDocumentSchema>;
export type StoredDefinitionDraft = z.infer<typeof storedDefinitionDraftSchema>;
export type StoredModuleDefinitionDraft = z.infer<typeof storedModuleDefinitionDraftSchema>;
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
