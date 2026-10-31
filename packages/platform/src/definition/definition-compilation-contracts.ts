import { z } from "zod";
import { applicationDraftSchema } from "./application-contracts";
import { applicationCompositionCatalogueSnapshotSchema } from "./application-composition/catalogue-snapshot";
import { applicationSourceDocumentSchema } from "./application-source-contracts";
import {
  applicationSourceContractVersion,
  applicationValidationContractVersion,
} from "./application-contract-versions";
import {
  applicationActionInputDefinitionSchema,
  publishedApplicationDefinitionSchema,
} from "./application-contracts";
import { flowValueDeclarationSchema } from "./application-flow-bindings";
import { connectionTypeSourceDocumentSchema } from "../connections/connection-source-contracts";
import { connectionTypeSchema } from "../connections/integration-contracts";
import {
  actionInputDefinitionSchema,
  moduleContractVersionPairSchema,
  moduleDraftSchema,
  moduleValidationContractVersion,
} from "./module-contracts";
import { moduleSourceDocumentSchema } from "./definition-source";
import { descriptionSchema } from "../catalogue/common";
import { definitionProvenanceEntrySchema } from "./definition-provenance";
import {
  actionIdSchema,
  actorIdSchema,
  applicationRootIdSchema,
  builderKeySchema,
  connectionTypeIdSchema,
  containedComponentIdSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  pageIdSchema,
  platformIdSchema,
  queryIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  flowIdSchema,
  semanticVersionSchema,
  timestampSchema,
  stableDefinitionReleaseVersionSchema,
} from "../catalogue/identifiers";
import { applicationPlatformCompatibilityVersionSchema } from "./platform-compatibility";
import { moduleVersionImpactHistoryEntrySchema } from "./version-impact";

export {
  definitionProvenanceEntrySchema,
  type DefinitionProvenanceEntry,
} from "./definition-provenance";

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
  "pipeline",
  "connection_binding",
  "interface",
  "interface_operation",
  "public_address",
  "shell",
  "shell_content_slot",
  "flow",
  "flow_node",
  "flow_edge",
  "flow_binding",
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
/** Historical names remain reserved even when their item has left the draft. */
export const sourceIdentityReservationSchema = sourceIdentityAssignmentSchema.omit({
  identifier: true,
});
export type SourceIdentityReservation = z.infer<typeof sourceIdentityReservationSchema>;
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
    contractVersion: z.literal("4.2.0"),
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

/**
 * The platform connection-type compilation request. Application and Module publication use the
 * explicit current-contract requests below; neither is accepted here.
 */
export const definitionCompilationRequestSchema = z
  .object({
    source: connectionTypeSourceDocumentSchema,
    resolution: definitionResolutionSnapshotSchema,
    draftMetadata: definitionDraftMetadataSchema.optional(),
    savedConditionRevisions: z.array(savedConditionRevisionAssignmentSchema).optional(),
  })
  .strict();

/** The one current Module compilation request; runtime dispatch requires this exact pair. */
export const moduleCompilationRequestSchema = z
  .object({
    ...moduleContractVersionPairSchema.shape,
    source: moduleSourceDocumentSchema,
    resolution: definitionResolutionSnapshotSchema,
    draftMetadata: definitionDraftMetadataSchema,
    savedConditionRevisions: z.array(savedConditionRevisionAssignmentSchema).optional(),
  })
  .strict();

/** The one current Application compilation request; runtime dispatch requires this exact pair. */
export const applicationCompilationRequestSchema = z
  .object({
    sourceContractVersion: z.literal(applicationSourceContractVersion),
    validationContractVersion: z.literal(applicationValidationContractVersion),
    source: applicationSourceDocumentSchema,
    resolution: definitionResolutionSnapshotSchema,
    catalogueSnapshot: applicationCompositionCatalogueSnapshotSchema,
    draftMetadata: definitionDraftMetadataSchema,
  })
  .strict();

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

export const applicationCompilationOutputSchema = z
  .object({
    kind: z.literal("application"),
    validationContractVersion: z.literal(applicationValidationContractVersion),
    platformCompatibilityVersion: applicationPlatformCompatibilityVersionSchema,
    canonical: applicationDraftSchema,
    artifact: compiledApplicationArtifactSchema,
    provenance: z.array(definitionProvenanceEntrySchema),
    dependencyOrder: z.array(namespacedKeySchema),
    resolvedDependencies: z.array(resolvedDefinitionSchema),
    resolutionFingerprint: fingerprintSchema,
  })
  .strict();

export const moduleCompilationOutputSchema = z
  .object({
    kind: z.literal("module"),
    validationContractVersion: z.literal(moduleValidationContractVersion),
    canonical: moduleDraftSchema,
    artifact: compiledModuleArtifactSchema,
    provenance: z.array(definitionProvenanceEntrySchema),
    dependencyOrder: z.array(namespacedKeySchema),
    resolvedDependencies: z.array(resolvedDefinitionSchema),
    resolutionFingerprint: fingerprintSchema,
  })
  .strict();

export const definitionCompilationOutputSchema = z.union([
  moduleCompilationOutputSchema,
  applicationCompilationOutputSchema,
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

const publishedModuleHistoryEntrySchema = moduleVersionImpactHistoryEntrySchema;

export const publishedDefinitionHistorySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("module"),
      definitionKey: namespacedKeySchema,
      history: z.array(publishedModuleHistoryEntrySchema).max(10_000),
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

const historyEvidenceCommon = {
  definitionKey: namespacedKeySchema,
  anchorReleaseRevision: revisionSchema.nullable(),
  /**
   * The version of the anchor release when it was published under an earlier definition contract:
   * it is history only, so the next release follows its version but nothing compares its content.
   */
  supersededReleaseVersion: stableDefinitionReleaseVersionSchema.nullable(),
};

/** The latest immutable release of one definition, which the database anchors as current. */
export const definitionPublicationHistorySchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("module"),
        ...historyEvidenceCommon,
        rootId: moduleRootIdSchema,
        latestRelease: publishedModuleHistoryEntrySchema.nullable(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("application"),
        ...historyEvidenceCommon,
        rootId: applicationRootIdSchema,
        latestRelease: publishedApplicationDefinitionSchema.nullable(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      (value.anchorReleaseRevision === null) !==
        (value.latestRelease === null && value.supersededReleaseVersion === null) ||
      (value.latestRelease !== null && value.supersededReleaseVersion !== null)
    )
      context.addIssue({
        code: "custom",
        message: "History evidence anchor and latest release must agree",
      });
    if (
      value.latestRelease !== null &&
      (value.latestRelease.publication.kind !== value.kind ||
        value.latestRelease.publication.rootId !== value.rootId ||
        value.latestRelease.publication.revision !== value.anchorReleaseRevision)
    )
      context.addIssue({
        code: "custom",
        message: "History evidence latest release must match its subject and anchor",
      });
  });

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

export type DefinitionResolutionSnapshot = z.infer<typeof definitionResolutionSnapshotSchema>;
export type SavedConditionRevisionAssignment = z.infer<
  typeof savedConditionRevisionAssignmentSchema
>;
export type DefinitionCompilationRequest = z.input<typeof definitionCompilationRequestSchema>;
export type ModuleCompilationRequest = z.input<typeof moduleCompilationRequestSchema>;
export type ApplicationCompilationRequest = z.input<typeof applicationCompilationRequestSchema>;
export type DefinitionCompilationOutput = z.infer<typeof definitionCompilationOutputSchema>;
export type ModuleCompilationOutput = z.infer<typeof moduleCompilationOutputSchema>;
export type ApplicationCompilationOutput = z.infer<typeof applicationCompilationOutputSchema>;
export type PublishedDefinitionHistory = z.infer<typeof publishedDefinitionHistorySchema>;
export type DefinitionPublicationHistory = z.infer<typeof definitionPublicationHistorySchema>;
export type DefinitionPublicationContext = z.infer<typeof definitionPublicationContextSchema>;
