import { z } from "zod";
import { applicationDraftV2Schema } from "./application-contracts";
import { applicationCompositionCatalogueSnapshotV2Schema } from "./application-composition-v2";
import { applicationSourceDocumentV2Schema } from "./application-source-contracts";
import {
  actionInputDefinitionSchema,
  publishedApplicationDefinitionSchema,
} from "./application-contracts";
import { flowValueDeclarationSchema } from "./application-flow-bindings";
import { connectionTypeSourceDocumentSchema } from "./connection-source-contracts";
import { connectionTypeSchema } from "./integration-contracts";
import {
  actionInputDefinitionV3Schema,
  moduleContractVersionPairV3Schema,
  moduleDraftV3Schema,
} from "./module-contracts-v3";
import { moduleSourceDocumentSchema } from "./definition-source";
import { descriptionSchema } from "./common";
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
  ruleIdSchema,
  semanticVersionSchema,
  timestampSchema,
} from "./identifiers";
import { moduleVersionImpactHistoryEntryV3Schema } from "./version-impact";

export { definitionProvenanceEntrySchema, type DefinitionProvenanceEntry } from "./definition-provenance";

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

/** V2-only identity vocabulary. The legacy identity decoder remains intentionally closed. */
export const sourceIdentityKindV2Schema = z.enum([
  ...sourceIdentityKindSchema.options,
  "shell",
  "shell_content_slot",
  "flow",
  "flow_node",
  "flow_edge",
  "flow_binding",
]);
export type SourceIdentityKindV2 = z.infer<typeof sourceIdentityKindV2Schema>;

/** Module V3 adds stable identities owned by each shared Rule graph. */
export const sourceIdentityKindV3Schema = z.enum([
  ...sourceIdentityKindV2Schema.options,
  "rule_input",
  "rule_variable",
  "rule_node",
]);
export type SourceIdentityKindV3 = z.infer<typeof sourceIdentityKindV3Schema>;

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

export const sourceIdentityAssignmentV2Schema = z
  .object({
    definitionKey: namespacedKeySchema,
    scope: z.string().min(1).max(500),
    kind: sourceIdentityKindV2Schema,
    componentOwner: z.string().min(1).max(240),
    alias: z.string().min(1).max(500),
    identifier: platformIdSchema,
  })
  .strict();

export const sourceIdentityAssignmentV3Schema = z
  .object({
    definitionKey: namespacedKeySchema,
    scope: z.string().min(1).max(500),
    kind: sourceIdentityKindV3Schema,
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

export const definitionResolutionSnapshotV2Schema = z
  .object({
    contractVersion: z.literal("2.0.0"),
    fingerprint: fingerprintSchema,
    definitions: z.array(resolvedDefinitionSchema).min(1),
    identities: z.array(sourceIdentityAssignmentV2Schema),
  })
  .strict();

export const definitionResolutionSnapshotV3Schema = z
  .object({
    contractVersion: z.literal("3.0.0"),
    fingerprint: fingerprintSchema,
    definitions: z.array(resolvedDefinitionSchema).min(1),
    identities: z.array(sourceIdentityAssignmentV3Schema),
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
export const moduleCompilationRequestV3Schema = z
  .object({
    ...moduleContractVersionPairV3Schema.shape,
    source: moduleSourceDocumentSchema,
    resolution: definitionResolutionSnapshotV3Schema,
    draftMetadata: definitionDraftMetadataSchema,
    savedConditionRevisions: z.array(savedConditionRevisionAssignmentSchema).optional(),
  })
  .strict();

/** The one current Application compilation request; runtime dispatch requires this exact pair. */
export const applicationCompilationRequestV2Schema = z
  .object({
    sourceContractVersion: z.literal("2.0.0"),
    validationContractVersion: z.literal("2.0.0"),
    source: applicationSourceDocumentV2Schema,
    resolution: definitionResolutionSnapshotV2Schema,
    catalogueSnapshot: applicationCompositionCatalogueSnapshotV2Schema,
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
export const compiledDefinitionArtifactSchema = z.discriminatedUnion("kind", [
  compiledModuleArtifactSchema,
  compiledApplicationArtifactSchema,
  compiledConnectionArtifactSchema,
]);

/**
 * A compiled tool name: `<applicationKey>.<operationKind>.<operationKey>`. The operation kind keeps
 * an action, flow, query and navigation target with the same key distinct, and the bound is sized
 * for the longest key the definition contracts accept so a valid application always compiles.
 */
export const applicationToolNameSchema = z
  .string()
  .min(5)
  .max(320)
  .regex(
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$/,
    "Use lowercase dot-separated namespace segments",
  );

/** The permanent definition that owns a compiled tool's operation. */
export const applicationToolOperationOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("application"), applicationRootId: applicationRootIdSchema }).strict(),
  z.object({ kind: z.literal("module"), moduleRootId: moduleRootIdSchema }).strict(),
]);

/**
 * One exact business operation a compiled application tool invokes. The reference keeps the
 * operation's declared key and its permanent owning identity, so a call reaches the same published
 * binding as the matching web control and never a caller-supplied target. A form or public page may
 * commit a bound Module's standard record action, which has no action identity of its own and is
 * pinned instead by its exact record type.
 */
export const applicationToolOperationReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("action"),
      owner: applicationToolOperationOwnerSchema,
      key: namespacedKeySchema,
      actionId: actionIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("standard_record_action"),
      key: namespacedKeySchema,
      moduleRootId: moduleRootIdSchema,
      recordTypeId: recordTypeIdSchema,
      standardAction: z.enum(["create", "read", "update", "soft_delete", "restore", "export"]),
    })
    .strict(),
  z
    .object({ kind: z.literal("flow"), key: builderKeySchema, flowId: ruleIdSchema })
    .strict(),
  z
    .object({
      kind: z.literal("query"),
      owner: applicationToolOperationOwnerSchema,
      key: builderKeySchema,
      queryId: queryIdSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("navigation"), key: builderKeySchema, pageId: pageIdSchema })
    .strict(),
]);

/**
 * The declared input contract of one compiled tool, copied from the operation's own definition:
 * an Application action's typed inputs, a bound Module action's or Module query's typed inputs, a
 * Frontend Flow's typed inputs, the exact record type a standard record action writes, or no
 * declared inputs (a navigation target or an Application query read). Nothing is invented here;
 * the MCP surfaces render exactly what the operation already declares.
 */
export const applicationToolInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("action_inputs"),
      inputs: z.array(actionInputDefinitionSchema).max(50),
    })
    .strict(),
  z
    .object({
      kind: z.literal("module_inputs"),
      inputs: z.array(actionInputDefinitionV3Schema).max(50),
    })
    .strict(),
  z
    .object({
      kind: z.literal("flow_inputs"),
      inputs: z.record(builderKeySchema, flowValueDeclarationSchema),
    })
    .strict(),
  z.object({ kind: z.literal("record_type"), recordTypeId: recordTypeIdSchema }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);

/**
 * The permission meaning one compiled tool carries. It names the gates that govern discoverability
 * and invocation without carrying any internal permission key, role name or private value: the
 * runtime reader resolves the exact Access declarations from the owning operation and the pages
 * that host it. `discover` is `application_navigation` for a navigation target (its navigation
 * entry and page access), otherwise `page_access` for the pages that host the operation. `use` is
 * `operation_permission` when the owning operation declares its own permission (a named or
 * standard record action), `delegated_operations` for a Frontend Flow whose protected operations
 * each apply their own permission, and `none` for a read or navigation governed only by discovery
 * and record access.
 */
export const applicationToolPermissionMeaningSchema = z
  .object({
    discover: z.enum(["application_navigation", "page_access"]),
    use: z.enum(["operation_permission", "delegated_operations", "none"]),
  })
  .strict();

export const applicationToolSchema = z
  .object({
    name: applicationToolNameSchema,
    description: descriptionSchema.optional(),
    inputSchema: applicationToolInputSchema,
    operation: applicationToolOperationReferenceSchema,
    permission: applicationToolPermissionMeaningSchema,
  })
  .strict();

/**
 * The agent tools one Application release carries, compiled from its published navigation, pages,
 * forms, named actions, Frontend Flow entry points and the queries it reads. Names are
 * deterministic and namespaced by the application key, and each tool maps to exactly one real
 * operation, so buttons that start the same operation never add a second tool. Nothing is authored
 * here separately from the definition.
 */
export const applicationToolBundleSchema = z
  .object({
    contractVersion: z.literal("1.0.0"),
    applicationKey: namespacedKeySchema,
    tools: z.array(applicationToolSchema).max(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    const names = value.tools.map((tool) => tool.name);
    if (names.some((name, index) => index > 0 && names[index - 1]! >= name))
      context.addIssue({
        code: "custom",
        path: ["tools"],
        message: "Compiled tools must use unique names in canonical order",
      });
    if (value.tools.some((tool) => !tool.name.startsWith(`${value.applicationKey}.`)))
      context.addIssue({
        code: "custom",
        path: ["tools"],
        message: "Every compiled tool name must be namespaced by its application key",
      });
  });

export const applicationCompilationOutputV2Schema = z
  .object({
    kind: z.literal("application"),
    validationContractVersion: z.literal("2.0.0"),
    canonical: applicationDraftV2Schema,
    artifact: compiledApplicationArtifactSchema,
    provenance: z.array(definitionProvenanceEntrySchema),
    dependencyOrder: z.array(namespacedKeySchema),
    resolvedDependencies: z.array(resolvedDefinitionSchema),
    resolutionFingerprint: fingerprintSchema,
    toolBundle: applicationToolBundleSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.toolBundle.applicationKey !== value.canonical.envelope.key)
      context.addIssue({
        code: "custom",
        path: ["toolBundle", "applicationKey"],
        message: "A release's tool bundle belongs to the application it was compiled from",
      });
  });

export const moduleCompilationOutputV3Schema = z
  .object({
    kind: z.literal("module"),
    validationContractVersion: z.literal("3.0.0"),
    canonical: moduleDraftV3Schema,
    artifact: compiledModuleArtifactSchema,
    provenance: z.array(definitionProvenanceEntrySchema),
    dependencyOrder: z.array(namespacedKeySchema),
    resolvedDependencies: z.array(resolvedDefinitionSchema),
    resolutionFingerprint: fingerprintSchema,
  })
  .strict();

export const definitionCompilationOutputSchema = z.union([
  moduleCompilationOutputV3Schema,
  applicationCompilationOutputV2Schema,
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

const publishedModuleHistoryEntrySchema = moduleVersionImpactHistoryEntryV3Schema;

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
  releaseCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  anchorReleaseRevision: revisionSchema.max(Number.MAX_SAFE_INTEGER).nullable(),
  validationContractVersions: z.array(semanticVersionSchema).max(3),
};

/**
 * Compact result of auditing immutable publication history. The runtime keeps
 * authenticity separately; this contract deliberately carries evidence facts,
 * not a caller-controlled `validated` flag or a fabricated one-row history.
 */
export const definitionPublicationHistoryEvidenceSchema = z
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
    const empty = value.releaseCount === 0;
    if (
      empty !== (value.anchorReleaseRevision === null) ||
      empty !== (value.latestRelease === null)
    )
      context.addIssue({
        code: "custom",
        message: "History evidence emptiness, anchor and latest release must agree",
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
export type DefinitionResolutionSnapshotV2 = z.infer<typeof definitionResolutionSnapshotV2Schema>;
export type DefinitionResolutionSnapshotV3 = z.infer<typeof definitionResolutionSnapshotV3Schema>;
export type DefinitionDraftMetadata = z.infer<typeof definitionDraftMetadataSchema>;
export type SavedConditionRevisionAssignment = z.infer<
  typeof savedConditionRevisionAssignmentSchema
>;
export type DefinitionCompilationRequest = z.input<typeof definitionCompilationRequestSchema>;
export type ModuleCompilationRequestV3 = z.input<typeof moduleCompilationRequestV3Schema>;
export type ApplicationCompilationRequestV2 = z.input<typeof applicationCompilationRequestV2Schema>;
export type DefinitionCompilationOutput = z.infer<typeof definitionCompilationOutputSchema>;
export type ModuleCompilationOutputV3 = z.infer<typeof moduleCompilationOutputV3Schema>;
export type ApplicationCompilationOutputV2 = z.infer<typeof applicationCompilationOutputV2Schema>;
export type ApplicationTool = z.infer<typeof applicationToolSchema>;
export type ApplicationToolBundle = z.infer<typeof applicationToolBundleSchema>;
/** The unbranded shape the compiler builds before the bundle contract validates it. */
export type ApplicationToolBundleInput = z.input<typeof applicationToolBundleSchema>;
export type ApplicationToolOperationReference = z.infer<
  typeof applicationToolOperationReferenceSchema
>;
export type ApplicationToolInputSchema = z.infer<typeof applicationToolInputSchema>;
export type ApplicationToolPermissionMeaning = z.infer<
  typeof applicationToolPermissionMeaningSchema
>;
export type CompiledDefinitionArtifact = z.infer<typeof compiledDefinitionArtifactSchema>;
export type PublishedDefinitionHistory = z.infer<typeof publishedDefinitionHistorySchema>;
export type DefinitionPublicationHistoryEvidence = z.infer<
  typeof definitionPublicationHistoryEvidenceSchema
>;
export type DefinitionPublicationContext = z.infer<typeof definitionPublicationContextSchema>;
export type DefinitionInstallCheckRequest = z.infer<typeof definitionInstallCheckRequestSchema>;
export type DefinitionInstallCheckResult = z.infer<typeof definitionInstallCheckResultSchema>;
export type DefinitionRuntimeCheckRequest = z.infer<typeof definitionRuntimeCheckRequestSchema>;
export type DefinitionRuntimeCheckResult = z.infer<typeof definitionRuntimeCheckResultSchema>;
