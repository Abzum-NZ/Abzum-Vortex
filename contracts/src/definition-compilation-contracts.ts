import { z } from "zod";
import { applicationDraftV1Schema } from "./application-contracts";
import { publishedApplicationDefinitionSchema } from "./application-contracts";
import { connectionTypeSchema } from "./integration-contracts";
import { moduleDraftSchema, publishedModuleDefinitionSchema } from "./module-contracts";
import { definitionSourceDocumentSchema } from "./definition-source";
import {
  actorIdSchema,
  applicationRootIdSchema,
  builderKeySchema,
  connectionTypeIdSchema,
  containedComponentIdSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  platformIdSchema,
  revisionSchema,
  semanticVersionSchema,
  timestampSchema,
} from "./identifiers";

export const sourceIdentityKindSchema = z.enum([
  "root",
  "storage_contract",
  "record_type",
  "field",
  "relationship",
  "permission",
  "action",
  "rule",
  "event",
  "extension_point",
  "sharing_condition",
  "role",
  "navigation_item",
  "query",
  "block",
  "block_placement",
  "page",
  "guided_step",
  "workflow",
  "workflow_node",
  "pipeline",
  "connection_binding",
  "interface",
  "interface_operation",
  "public_address",
]);
export type SourceIdentityKind = z.infer<typeof sourceIdentityKindSchema>;

export const sourceIdentityAssignmentSchema = z
  .object({
    definitionKey: namespacedKeySchema,
    scope: z.string().min(1).max(500),
    kind: sourceIdentityKindSchema,
    componentOwner: z.string().min(1).max(240),
    alias: z.string().min(1).max(500),
    identifier: platformIdSchema,
  })
  .strict();

export const resolvedDefinitionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("module"),
      key: namespacedKeySchema,
      rootId: moduleRootIdSchema,
      exactVersion: semanticVersionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("application"),
      key: namespacedKeySchema,
      rootId: applicationRootIdSchema,
      exactVersion: semanticVersionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("connection_type"),
      key: namespacedKeySchema,
      rootId: connectionTypeIdSchema,
      exactVersion: semanticVersionSchema,
      operationKeys: z.array(builderKeySchema),
    })
    .strict(),
]);

export const definitionResolutionSnapshotSchema = z
  .object({
    contractVersion: z.literal("1.0.0"),
    fingerprint: fingerprintSchema,
    definitions: z.array(resolvedDefinitionSchema).min(1),
    identities: z.array(sourceIdentityAssignmentSchema),
  })
  .strict();

export const definitionDraftMetadataSchema = z
  .object({
    organizationId: organizationIdSchema,
    draftRevision: revisionSchema,
    publishedRevision: revisionSchema.optional(),
    createdAt: timestampSchema,
    createdBy: actorIdSchema,
    updatedAt: timestampSchema,
    updatedBy: actorIdSchema,
  })
  .strict();

export const savedConditionRevisionAssignmentSchema = z
  .object({
    conditionId: containedComponentIdSchema,
    revision: revisionSchema,
  })
  .strict();

export const definitionCompilationRequestSchema = z
  .object({
    source: definitionSourceDocumentSchema,
    resolution: definitionResolutionSnapshotSchema,
    draftMetadata: definitionDraftMetadataSchema.optional(),
    savedConditionRevisions: z.array(savedConditionRevisionAssignmentSchema).optional(),
  })
  .strict();

const definitionPathSchema = z
  .array(z.union([z.string(), z.number().int().nonnegative()]))
  .max(100);
export const definitionProvenanceEntrySchema = z
  .object({
    canonicalPath: definitionPathSchema,
    origin: z.enum(["source", "resolved", "fixed_default", "system_metadata"]),
    sourcePath: definitionPathSchema.optional(),
    ruleCode: namespacedKeySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const tracesSource = value.origin === "source" || value.origin === "resolved";
    if (tracesSource !== (value.sourcePath !== undefined))
      context.addIssue({
        code: "custom",
        path: ["sourcePath"],
        message:
          "Source and resolved provenance require a source path; defaults and system metadata do not",
      });
  });

const compiledArtifactCommon = {
  definitionKey: namespacedKeySchema,
  exactVersion: semanticVersionSchema,
  contentFingerprint: fingerprintSchema,
  resolutionFingerprint: fingerprintSchema,
};
const compiledModuleArtifactSchema = z
  .object({
    kind: z.literal("module"),
    ...compiledArtifactCommon,
    rootId: moduleRootIdSchema,
  })
  .strict();
const compiledApplicationArtifactSchema = z
  .object({
    kind: z.literal("application"),
    ...compiledArtifactCommon,
    rootId: applicationRootIdSchema,
  })
  .strict();
const compiledConnectionArtifactSchema = z
  .object({
    kind: z.literal("connection_type"),
    ...compiledArtifactCommon,
    rootId: connectionTypeIdSchema,
  })
  .strict();
export const compiledDefinitionArtifactSchema = z.discriminatedUnion("kind", [
  compiledModuleArtifactSchema,
  compiledApplicationArtifactSchema,
  compiledConnectionArtifactSchema,
]);

export const applicationCompilationOutputV1Schema = z
  .object({
    kind: z.literal("application"),
    canonical: applicationDraftV1Schema,
    artifact: compiledApplicationArtifactSchema,
    provenance: z.array(definitionProvenanceEntrySchema),
    dependencyOrder: z.array(namespacedKeySchema),
    resolvedDependencies: z.array(resolvedDefinitionSchema),
    resolutionFingerprint: fingerprintSchema,
  })
  .strict();

export const definitionCompilationOutputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("module"),
      canonical: moduleDraftSchema,
      artifact: compiledModuleArtifactSchema,
      provenance: z.array(definitionProvenanceEntrySchema),
      dependencyOrder: z.array(namespacedKeySchema),
      resolvedDependencies: z.array(resolvedDefinitionSchema),
      resolutionFingerprint: fingerprintSchema,
    })
    .strict(),
  applicationCompilationOutputV1Schema,
  z
    .object({
      kind: z.literal("connection_type"),
      canonical: connectionTypeSchema,
      artifact: compiledConnectionArtifactSchema,
      provenance: z.array(definitionProvenanceEntrySchema),
      dependencyOrder: z.array(namespacedKeySchema),
      resolvedDependencies: z.array(resolvedDefinitionSchema),
      resolutionFingerprint: fingerprintSchema,
    })
    .strict(),
]);

export const publishedDefinitionHistorySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("module"),
      definitionKey: namespacedKeySchema,
      history: z.array(publishedModuleDefinitionSchema).max(10_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("application"),
      definitionKey: namespacedKeySchema,
      history: z.array(publishedApplicationDefinitionSchema).max(10_000),
    })
    .strict(),
]);

export const definitionPublicationContextSchema = z
  .object({
    dependencyOutputs: z.array(definitionCompilationOutputSchema).max(10_000).optional(),
    publishedHistories: z.array(publishedDefinitionHistorySchema).max(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    const ensureUnique = (keys: string[], path: string) => {
      if (new Set(keys).size !== keys.length)
        context.addIssue({
          code: "custom",
          path: [path],
          message: `${path} must not contain duplicate subjects`,
        });
    };
    ensureUnique(
      (value.dependencyOutputs ?? []).map((output) =>
        output.kind === "connection_type" ? output.canonical.key : output.canonical.envelope.key,
      ),
      "dependencyOutputs",
    );
    ensureUnique(
      value.publishedHistories.map((entry) => `${entry.kind}:${entry.definitionKey}`),
      "publishedHistories",
    );
  });

const definitionCheckCommon = {
  definitionKey: namespacedKeySchema,
  releaseVersion: semanticVersionSchema,
  contentFingerprint: fingerprintSchema,
  resolutionFingerprint: fingerprintSchema,
};
const definitionCheckRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("module"), ...definitionCheckCommon, rootId: moduleRootIdSchema })
    .strict(),
  z
    .object({
      kind: z.literal("application"),
      ...definitionCheckCommon,
      rootId: applicationRootIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("connection_type"),
      ...definitionCheckCommon,
      rootId: connectionTypeIdSchema,
    })
    .strict(),
]);
export const definitionInstallCheckRequestSchema = definitionCheckRequestSchema;
export const definitionInstallCheckResultSchema = z
  .object({ accepted: z.boolean(), refusalCodes: z.array(namespacedKeySchema) })
  .strict();

export const definitionRuntimeCheckRequestSchema = definitionCheckRequestSchema;
export const definitionRuntimeCheckResultSchema = z
  .object({ available: z.boolean(), refusalCodes: z.array(namespacedKeySchema) })
  .strict();

export type DefinitionResolutionSnapshot = z.infer<typeof definitionResolutionSnapshotSchema>;
export type DefinitionDraftMetadata = z.infer<typeof definitionDraftMetadataSchema>;
export type SavedConditionRevisionAssignment = z.infer<
  typeof savedConditionRevisionAssignmentSchema
>;
export type DefinitionCompilationRequest = z.input<typeof definitionCompilationRequestSchema>;
export type DefinitionCompilationOutput = z.infer<typeof definitionCompilationOutputSchema>;
export type CompiledDefinitionArtifact = z.infer<typeof compiledDefinitionArtifactSchema>;
export type DefinitionProvenanceEntry = z.infer<typeof definitionProvenanceEntrySchema>;
export type PublishedDefinitionHistory = z.infer<typeof publishedDefinitionHistorySchema>;
export type DefinitionPublicationContext = z.infer<typeof definitionPublicationContextSchema>;
export type DefinitionInstallCheckRequest = z.infer<typeof definitionInstallCheckRequestSchema>;
export type DefinitionInstallCheckResult = z.infer<typeof definitionInstallCheckResultSchema>;
export type DefinitionRuntimeCheckRequest = z.infer<typeof definitionRuntimeCheckRequestSchema>;
export type DefinitionRuntimeCheckResult = z.infer<typeof definitionRuntimeCheckResultSchema>;
