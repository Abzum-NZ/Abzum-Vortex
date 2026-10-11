import "server-only";

import {
  applicationCompilationRequestV2Schema,
  applicationCompositionCatalogueSnapshotV2Schema,
  assertModuleContractPair,
  protectedOperationReferenceSchema,
  customComponentPlacementAllowedV2,
  definitionCompilationOutputSchema,
  definitionPublicationConfirmationSchema,
  definitionResolutionSnapshotV3Schema,
  moduleCompilationRequestV3Schema,
  moduleRootIdSchema,
  moduleSourceDocumentSchema,
  sourceConditionSchema,
  queryIdSchema,
  conditionNodeSchema,
  fingerprintSchema,
  revisionSchema,
  platformIdSchema,
  translateDefinitionRuleFailures,
  translateDefinitionSchemaError,
  prepareDefinitionPublicationCommandSchema,
  prepareDefinitionPublicationResultSchema,
  publishDefinitionCommandSchema,
  publishDefinitionResultSchema,
  savedConditionRevisionAssignmentSchema,
  stableDefinitionReleaseVersionSchema,
  storedDefinitionDraftSchema,
  storedModuleCompilationOutputV3Schema,
  sourceIdentityKindV2Schema,
  recordTypeIdSchema,
  fieldIdSchema,
  type DefinitionCompilationOutput,
  type ApplicationCompilationOutputV2,
  type DefinitionPublicationConfirmation,
  type DefinitionPublicationHistoryEvidence,
  type DefinitionResolutionSnapshot,
  type DefinitionResolutionSnapshotV2,
  type DefinitionResolutionSnapshotV3,
  type ApplicationCompositionCatalogueSnapshotV2,
  type ApplicationSourceDocumentV2,
  type BlockId,
  type ExactDefinitionDependency,
  type PrepareDefinitionPublicationCommand,
  type PrepareDefinitionPublicationResult,
  type PublishDefinitionCommand,
  type ModuleVersionImpactHistoryEntryV3,
  type ModuleCompilationOutputV3,
  type PublishDefinitionResult,
  type SavedConditionRevisionAssignment,
  type SessionContext,
  type ConditionNode,
  type ModuleSourceDocument,
  type ModuleFieldV3,
  type DefinitionValidationResult,
  type DefinitionValidationLocation,
  type DefinitionValidationTranslationContext,
  type DefinitionRuleFailure,
  type QueryId,
  type RecordTypeId,
  type StoredDefinitionDraft,
  type VersionRequirement,
  type ConnectionTypeId,
  type Fingerprint,
  type FlowDefinition,
  type ModuleRootId,
  type OrganizationId,
  type PlatformBlockReleaseV2,
  type PlatformId,
  type PlatformThemeReleaseV2,
  type PlatformServiceOperationRelease,
  type ProtectedOperationReference,
  type Revision,
  type SemanticVersion,
} from "@vortex/contracts";
import { APPLICATION_PLATFORM_COMPATIBILITY_VERSION } from "@vortex/contracts/platform-compatibility";
import { compare, satisfies } from "semver";
import { z } from "zod";
import {
  requireBuilderAuthority,
  type BuilderAuthority,
  type BuilderOperation,
} from "./builder-authority";
import { compareCanonicalStrings, fingerprintCanonicalValue } from "./canonical-json";
import { createApplicationResolutionSnapshotV2 } from "./application-v2-resolution";
import { compileParsedDefinition } from "./compiler";
import {
  flowOperationReferencesByNode,
  platformOperationsCalledBy,
  type ProtectedOperationReferenceLookups,
} from "./flow-operation-calls";
import { DefinitionCompilationError } from "./compilation-error";
import { definitionSemanticRules, validateDefinitionSet, validateDefinitionSource } from "./validation";
import {
  compareDefinitionVersionImpactWithEvidence,
  deriveSavedConditionRevisionsFromHistoryEvidence,
  isVerifiedDefinitionPublicationHistoryEvidence,
} from "./version-impact";
import { DefinitionVersionImpactError } from "./version-impact-error";

type SourceIdentityAssignments = DefinitionResolutionSnapshotV3["identities"];
type ModuleSourceQuery = ModuleSourceDocument["body"]["queries"][number];
type SourceCondition = NonNullable<ModuleSourceQuery["filter"]>;
type ModuleOutput = Extract<DefinitionCompilationOutput, { kind: "module" }>;
type ConnectionOutput = Extract<DefinitionCompilationOutput, { kind: "connection_type" }>;
type PublishableCompilationOutput = ApplicationCompilationOutputV2 | ModuleCompilationOutputV3;
type DefinitionResolution =
  DefinitionResolutionSnapshot | DefinitionResolutionSnapshotV2 | DefinitionResolutionSnapshotV3;

export type DefinitionPublicationFailureCode =
  | "INVALID_DEFINITION_PUBLICATION_COMMAND"
  | "DEFINITION_DRAFT_STALE_OR_MISSING"
  | "DEFINITION_ORGANIZATION_MISMATCH"
  | "DEFINITION_SOURCE_EVIDENCE_MISMATCH"
  | "DEFINITION_HISTORY_INVALID"
  | "DEFINITION_DEPENDENCY_MISSING"
  | "DEFINITION_DEPENDENCY_PRERELEASE_ONLY"
  | "DEFINITION_DEPENDENCY_INCOMPATIBLE"
  | "DEFINITION_DEPENDENCY_AMBIGUOUS"
  | "DEFINITION_DEPENDENCY_SUBSTITUTED"
  | "DEFINITION_DEPENDENCY_CYCLE"
  | "DEFINITION_COMPILATION_REFUSED"
  | "DEFINITION_VERSION_REFUSED"
  | "DEFINITION_NO_CHANGE"
  | "DEFINITION_CONFIRMATION_MISMATCH"
  | "DEFINITION_PUBLICATION_FAILED";

export class DefinitionPublicationError extends Error {
  readonly code: DefinitionPublicationFailureCode;

  constructor(code: DefinitionPublicationFailureCode) {
    super(code);
    this.name = "DefinitionPublicationError";
    this.code = code;
  }
}

function refuse(code: DefinitionPublicationFailureCode): never {
  throw new DefinitionPublicationError(code);
}

/** Read model needed to compile one current draft. Implementations must tenant-scope every method. */
type DefinitionPublicationCandidateCommon = Readonly<{
  draft: StoredDefinitionDraft;
  identities: SourceIdentityAssignments;
}>;

/**
 * Repositories return verified, incrementally folded history evidence before
 * any publication policy consumes it.
 */
export type DefinitionPublicationCandidate = DefinitionPublicationCandidateCommon &
  Readonly<{ historyEvidence: DefinitionPublicationHistoryEvidence }>;

type ValidatedDefinitionPublicationCandidate = DefinitionPublicationCandidateCommon &
  Readonly<{ historyEvidence: DefinitionPublicationHistoryEvidence }>;

/** Immutable organization-owned module release made available to a dependency compilation. */
export type ResolvableModuleRelease = Readonly<{
  organizationId: OrganizationId;
  key: string;
  rootId: ModuleRootId;
  releaseRevision: Revision;
  releaseVersion: SemanticVersion;
  contentFingerprint: Fingerprint;
  resolutionFingerprint: Fingerprint;
  published: ModuleVersionImpactHistoryEntryV3;
  compilationOutput: ModuleOutput;
  resolutionSnapshot: DefinitionResolutionSnapshotV3;
}>;

export type ModuleReleasePageCursor = Readonly<{
  rootId: ModuleRootId;
  anchorReleaseRevision: Revision;
  afterReleaseRevision: Revision;
}>;

export type ResolvableModuleReleasePage = Readonly<{
  rootId: ModuleRootId | null;
  anchorReleaseRevision: Revision | null;
  entries: readonly Readonly<{
    previousReleaseRevision: Revision | null;
    release: ResolvableModuleRelease;
  }>[];
  nextAfterReleaseRevision: Revision | null;
}>;

export type ResolvableConnectionTypeRelease = Readonly<{
  key: string;
  rootId: ConnectionTypeId;
  releaseVersion: SemanticVersion;
  contentFingerprint: Fingerprint;
  catalogueFingerprint: Fingerprint;
  compilationOutput: ConnectionOutput;
}>;

export interface DefinitionPublicationReader {
  readCandidate(rootId: string): Promise<DefinitionPublicationCandidate | undefined>;
  readModuleReleasePage(
    organizationId: OrganizationId,
    key: string,
    cursor?: ModuleReleasePageCursor,
  ): Promise<ResolvableModuleReleasePage>;
  readModuleRelease(
    organizationId: OrganizationId,
    rootId: ModuleRootId,
    releaseRevision: Revision,
  ): Promise<ResolvableModuleRelease | undefined>;
}

export interface DefinitionPublicationCatalogue {
  listConnectionTypeReleases(key: string): Promise<readonly ResolvableConnectionTypeRelease[]>;
  readConnectionTypeRelease(
    rootId: ConnectionTypeId,
    releaseVersion: string,
  ): Promise<ResolvableConnectionTypeRelease | undefined>;
  readPlatformBlockReleaseV2(
    blockId: BlockId,
    releaseVersion: string,
  ): Promise<PlatformBlockReleaseV2 | undefined>;
  readPlatformThemeReleaseV2(
    catalogueThemeId: PlatformId,
    releaseVersion: string,
  ): Promise<PlatformThemeReleaseV2 | undefined>;
  readApplicationCompositionCatalogueSnapshotV2(
    selection: Readonly<{
      platformBlocks: readonly Readonly<{
        blockId: BlockId;
        releaseVersion: SemanticVersion;
      }>[];
      platformTheme: Readonly<{
        catalogueThemeId: PlatformId;
        releaseVersion: SemanticVersion;
      }>;
      customComponentPlacement?: Readonly<{
        applicationKey: string;
        boundModuleReleases: readonly Readonly<{
          moduleKey: string;
          releaseVersion: string;
        }>[];
      }>;
    }>,
  ): Promise<ApplicationCompositionCatalogueSnapshotV2 | undefined>;
  readPlatformServiceOperationRelease?(
    serviceId: string,
    operationId: string,
    releaseVersion: string,
  ): Promise<PlatformServiceOperationRelease | undefined>;
}

export type DefinitionReleaseAppend = Readonly<{
  draft: StoredDefinitionDraft;
  compilationOutput: PublishableCompilationOutput;
  assignedVersion: string;
  comparisonFingerprint: string;
  reasons: DefinitionPublicationConfirmation["reasons"];
  dependencyManifest: readonly ExactDefinitionDependency[];
  resolutionSnapshot: DefinitionResolution;
  validationContractVersion: "2.0.0" | "3.0.0";
  releaseNote: string;
}>;

export interface DefinitionPublicationTransaction extends DefinitionPublicationReader {
  /** Re-reads immediately before compilation; appendRelease owns the atomic row lock/check. */
  lockCandidate(rootId: string): Promise<DefinitionPublicationCandidate | undefined>;
  /** Must append the release and manifest and advance only this root's pointer atomically. */
  appendRelease(release: DefinitionReleaseAppend): Promise<PublishDefinitionResult>;
}

export interface DefinitionPublicationRepository {
  read<Result>(
    context: SessionContext,
    operation: (reader: DefinitionPublicationReader) => Promise<Result>,
  ): Promise<Result>;
  transaction<Result>(
    context: SessionContext,
    operation: (transaction: DefinitionPublicationTransaction) => Promise<Result>,
  ): Promise<Result>;
}

type PreparedState = Readonly<{
  confirmation: DefinitionPublicationConfirmation;
  draft: StoredDefinitionDraft;
  compilationOutput: PublishableCompilationOutput;
  resolutionSnapshot: DefinitionResolution;
}>;

export type PreparedDefinitionPublication = PrepareDefinitionPublicationResult;

export type ModuleQueryFilterParameterType =
  | "text"
  | "number"
  | "decimal_number"
  | "money"
  | "boolean"
  | "date"
  | "date_time";

export type ModuleQueryFilterDraftContext = Readonly<{
  organizationId: OrganizationId;
  rootId: ModuleRootId;
  definitionKey: string;
  draftRevision: Revision;
  savedSourceFingerprint: Fingerprint;
  resolutionFingerprint: Fingerprint;
  operandBindingFingerprint: Fingerprint;
  query: Readonly<{
    alias: string;
    key: string;
    queryId: QueryId;
    recordAlias: string;
    recordKey: string;
    recordTypeId: RecordTypeId;
  }>;
  fields: readonly Readonly<{
    sourceAlias: string;
    sourceKey: string;
    field: ModuleFieldV3;
  }>[];
  parameters: readonly Readonly<{ key: string; type: ModuleQueryFilterParameterType }>[];
  filter: ConditionNode | null;
}>;

type ModuleQueryFilterOperandBinding = Pick<
  ModuleQueryFilterDraftContext,
  | "organizationId"
  | "rootId"
  | "definitionKey"
  | "draftRevision"
  | "savedSourceFingerprint"
  | "resolutionFingerprint"
  | "query"
  | "fields"
  | "parameters"
>;

export const fingerprintModuleQueryFilterOperandBinding = (
  binding: ModuleQueryFilterOperandBinding,
): Fingerprint => fingerprintCanonicalValue({
  domain: "vortex.module_query_filter_operand_binding.v1",
  organizationId: binding.organizationId,
  rootId: binding.rootId,
  definitionKey: binding.definitionKey,
  draftRevision: binding.draftRevision,
  savedSourceFingerprint: binding.savedSourceFingerprint,
  resolutionFingerprint: binding.resolutionFingerprint,
  query: {
    alias: binding.query.alias,
    key: binding.query.key,
    queryId: binding.query.queryId,
  },
  record: {
    alias: binding.query.recordAlias,
    key: binding.query.recordKey,
    recordTypeId: binding.query.recordTypeId,
  },
  fields: binding.fields,
  parameters: binding.parameters,
});

export type ModuleQueryFilterQueryChoice = Readonly<{
  alias: string;
  key: string;
  label?: string;
  eligible: boolean;
  reason?: "query_target_unsupported" | "operand_context_unsupported" | "retained_filter_unsupported";
}>;

export type ModuleQueryFilterDraftResult =
  | Readonly<{
      kind: "available";
      queryChoices: readonly ModuleQueryFilterQueryChoice[];
      selected?: ModuleQueryFilterDraftContext;
    }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
  | Readonly<{
      kind: "unsupported_context";
      reason: "query_target_unsupported" | "operand_context_unsupported" | "retained_filter_unsupported";
    }>;

export type ModuleQueryFilterValidationResult =
  | Readonly<{
      kind: "validated";
      source: ModuleSourceDocument;
      sourceFingerprint: Fingerprint;
      context: ModuleQueryFilterDraftContext;
      noChange: boolean;
    }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
  | Readonly<{
      kind: "unsupported_context";
      reason: "query_target_unsupported" | "operand_context_unsupported" | "retained_filter_unsupported";
    }>;

/** One current Application draft compiled at its exact revision, for exact-draft preview. */
export type ApplicationDraftCompilation = Readonly<{
  compilation: ApplicationCompilationOutputV2;
  conditionContexts: readonly ApplicationDraftConditionContext[];
  /** The root's current published release revision; preview only labels it and never reads it. */
  currentReleaseRevision: Revision | null;
}>;

/** Authoring metadata from the very same verified dependency resolution as compilation. */
export type ApplicationDraftConditionContext = Readonly<{
  sourceFingerprint: Fingerprint;
  bindingsSignature: string;
  pageAlias: string;
  recordReference: string;
  fieldRecordReference: string;
  recordTypeId: string;
  module: Readonly<Pick<ResolvableModuleRelease, "organizationId" | "key" | "rootId" |
    "releaseRevision" | "releaseVersion" | "contentFingerprint" | "resolutionFingerprint">>;
  fields: readonly Readonly<{ field: ModuleFieldV3; aliases: readonly string[];
    preferredAlias: string; componentOwner: string }>[];
}>;

const conditionFieldTypes = new Set(["text", "long_text", "whole_number", "yes_no", "date", "date_time"]);

const projectDraftConditionContexts = (
  source: ApplicationSourceDocumentV2,
  sourceFingerprint: Fingerprint,
  dependencies: ResolvedDependencies,
  resolution: DefinitionResolution,
): ApplicationDraftConditionContext[] => {
  const contexts: ApplicationDraftConditionContext[] = [];
  for (const page of source.body.pages) {
    if (page.type !== "detail") continue;
    const split = page.record_type.lastIndexOf(":");
    const moduleKey = page.record_type.slice(0, split);
    const recordAlias = page.record_type.slice(split + 1);
    const releases = dependencies.modules.filter((release) => release.key === moduleKey);
    const identities = resolution.identities.filter((identity) => identity.definitionKey === moduleKey);
    const records = identities.filter((identity) => identity.kind === "record_type" &&
      identity.scope === "content" && identity.alias === recordAlias);
    const release = releases[0];
    const recordIdentity = records[0];
    if (releases.length !== 1 || records.length !== 1 || release === undefined || recordIdentity === undefined)
      continue;
    const recordIdentifier = recordTypeIdSchema.safeParse(recordIdentity.identifier);
    if (!recordIdentifier.success) continue;
    const canonicalRecords = release.compilationOutput.canonical.content.recordTypes.filter(
      (record) => record.recordTypeId === recordIdentifier.data,
    );
    const record = canonicalRecords[0];
    if (canonicalRecords.length !== 1 || record === undefined) continue;
    const recordAliases = identities.filter((identity) => identity.kind === "record_type" &&
      identity.scope === "content" && identity.identifier === recordIdentity.identifier);
    if (!recordAliases.some((identity) => identity.alias === record.key) ||
      recordAliases.some((identity) => identity.componentOwner !== recordIdentity.componentOwner)) continue;
    const fields: ApplicationDraftConditionContext["fields"][number][] = [];
    let valid = true;
    for (const field of record.fields) {
      if (!conditionFieldTypes.has(field.type)) continue;
      const group = identities.filter((identity) => {
        if (identity.kind !== "field" || identity.scope !== `record:${record.key}`) return false;
        const identifier = fieldIdSchema.safeParse(identity.identifier);
        return identifier.success && identifier.data === field.fieldId;
      });
      const owners = new Set(group.map((identity) => identity.componentOwner));
      const aliases = group.map((identity) => identity.alias);
      if (owners.size !== 1 || aliases.length === 0 || new Set(aliases).size !== aliases.length ||
        !aliases.includes(field.key) || group.some((entry) => identities.some((other) =>
          other.kind === "field" && other.scope === entry.scope && other.alias === entry.alias &&
          (other.identifier !== entry.identifier || other.componentOwner !== entry.componentOwner))) ||
        group.some((entry) => identities.some((other) => other.kind === "field" && other.scope === entry.scope &&
          other.componentOwner === entry.componentOwner && other.identifier !== entry.identifier))) {
        valid = false;
        break;
      }
      fields.push({ field, aliases, preferredAlias: field.key, componentOwner: group[0]!.componentOwner });
    }
    if (!valid) continue;
    contexts.push({ sourceFingerprint, bindingsSignature: JSON.stringify(source.body.module_bindings),
      pageAlias: page.id, recordReference: page.record_type,
      fieldRecordReference: `${moduleKey}:${record.key}`,
      recordTypeId: record.recordTypeId, module: { organizationId: release.organizationId,
        key: release.key, rootId: release.rootId, releaseRevision: release.releaseRevision,
        releaseVersion: release.releaseVersion, contentFingerprint: release.contentFingerprint,
        resolutionFingerprint: release.resolutionFingerprint }, fields });
  }
  return contexts;
};

type Requirement = Readonly<{ key: string; version: VersionRequirement }>;

type ResolvedDependencies = Readonly<{
  modules: readonly ResolvableModuleRelease[];
  connections: readonly ResolvableConnectionTypeRelease[];
  compositionV2?: ApplicationCompositionCatalogueSnapshotV2;
  platformOperations: readonly PlatformServiceOperationRelease[];
}>;

const stable = (version: string): boolean =>
  stableDefinitionReleaseVersionSchema.safeParse(version).success;

const moduleOutputContractVersion = (output: ModuleOutput): "3.0.0" =>
  output.validationContractVersion;

const accepts = (requirements: readonly VersionRequirement[], version: string): boolean =>
  requirements.every((requirement) =>
    requirement.selection === "exact"
      ? requirement.version === version
      : satisfies(version, requirement.expression, { includePrerelease: false }),
  );

const groupRequirements = (requirements: readonly Requirement[]) => {
  const grouped = new Map<string, VersionRequirement[]>();
  for (const requirement of requirements)
    grouped.set(requirement.key, [...(grouped.get(requirement.key) ?? []), requirement.version]);
  return [...grouped].sort(([left], [right]) => compareCanonicalStrings(left, right));
};

const chooseStableRelease = <Release extends { releaseVersion: string }>(
  releases: readonly Release[],
  requirements: readonly VersionRequirement[],
): Release => {
  if (releases.length === 0) return refuse("DEFINITION_DEPENDENCY_MISSING");
  const stableReleases = releases.filter((release) => stable(release.releaseVersion));
  if (stableReleases.length === 0) return refuse("DEFINITION_DEPENDENCY_PRERELEASE_ONLY");
  const compatible = stableReleases.filter((release) =>
    accepts(requirements, release.releaseVersion),
  );
  if (compatible.length === 0) return refuse("DEFINITION_DEPENDENCY_INCOMPATIBLE");
  const highestVersion = compatible
    .map((release) => release.releaseVersion)
    .sort(compare)
    .at(-1)!;
  const highest = compatible.filter((release) => release.releaseVersion === highestVersion);
  if (highest.length !== 1) return refuse("DEFINITION_DEPENDENCY_AMBIGUOUS");
  return highest[0]!;
};

type ModuleSelectionFold = {
  sawRelease: boolean;
  sawStable: boolean;
  sawCompatible: boolean;
  best: ResolvableModuleRelease | undefined;
  bestMultiplicity: number;
};

const createModuleSelectionFold = (): ModuleSelectionFold => ({
  sawRelease: false,
  sawStable: false,
  sawCompatible: false,
  best: undefined,
  bestMultiplicity: 0,
});

const foldModuleSelection = (
  fold: ModuleSelectionFold,
  release: ResolvableModuleRelease,
  requirements: readonly VersionRequirement[],
): void => {
  fold.sawRelease = true;
  if (!stable(release.releaseVersion)) return;
  fold.sawStable = true;
  if (!accepts(requirements, release.releaseVersion)) return;
  fold.sawCompatible = true;
  if (fold.best === undefined || compare(release.releaseVersion, fold.best.releaseVersion) > 0) {
    fold.best = release;
    fold.bestMultiplicity = 1;
  } else if (release.releaseVersion === fold.best.releaseVersion) {
    fold.bestMultiplicity += 1;
  }
};

const completeModuleSelection = (fold: ModuleSelectionFold): ResolvableModuleRelease => {
  if (!fold.sawRelease) return refuse("DEFINITION_DEPENDENCY_MISSING");
  if (!fold.sawStable) return refuse("DEFINITION_DEPENDENCY_PRERELEASE_ONLY");
  if (!fold.sawCompatible || fold.best === undefined)
    return refuse("DEFINITION_DEPENDENCY_INCOMPATIBLE");
  if (fold.bestMultiplicity !== 1) return refuse("DEFINITION_DEPENDENCY_AMBIGUOUS");
  return fold.best;
};

const moduleRequirements = (draft: StoredDefinitionDraft): Requirement[] => {
  const dependencies =
    draft.source.kind === "module"
      ? draft.source.body.dependencies
      : draft.source.body.module_bindings;
  return dependencies.map((entry) => ({ key: entry.module, version: entry.version }));
};

const connectionRequirements = (draft: StoredDefinitionDraft): Requirement[] =>
  draft.source.kind === "application"
    ? draft.source.body.connection_bindings.map((entry) => ({
        key: entry.connection_type,
        version: entry.version,
      }))
    : [];

const subjectOf = (dependency: ExactDefinitionDependency): string =>
  dependency.kind === "platform_theme"
    ? `${dependency.kind}:${dependency.catalogueThemeId}`
    : dependency.kind === "platform_block"
      ? `${dependency.kind}:${dependency.blockId}@${dependency.releaseVersion}`
      : dependency.kind === "application_flow"
          ? `${dependency.kind}:${dependency.applicationRootId}:${dependency.flowId}`
          : dependency.kind === "application_flow_node"
            ? `${dependency.kind}:${dependency.applicationRootId}:${dependency.flowId}:${dependency.nodeId}`
            : dependency.kind === "application_query"
              ? `${dependency.kind}:${dependency.applicationRootId}:${dependency.queryId}`
              : dependency.kind === "module_query"
                ? `${dependency.kind}:${dependency.moduleRootId}:${dependency.queryId}`
                : dependency.kind === "application_form"
                  ? `${dependency.kind}:${dependency.applicationRootId}:${dependency.formId}`
                    : dependency.kind === "application_workflow"
                      ? `${dependency.kind}:${dependency.applicationRootId}:${dependency.workflowId}`
                      : dependency.kind === "application_action"
                        ? `${dependency.kind}:${dependency.applicationRootId}:${dependency.actionId}`
                    : dependency.kind === "protected_operation"
                      ? `${dependency.kind}:${dependency.operation.owner.kind}:${
                          dependency.operation.owner.kind === "application"
                            ? dependency.operation.owner.applicationRootId
                            : dependency.operation.owner.kind === "module"
                              ? dependency.operation.owner.moduleRootId
                              : dependency.operation.owner.serviceId
                        }:${dependency.operation.operationId}`
      : `${dependency.kind}:${dependency.key}`;

const sortedManifest = (
  dependencies: readonly ExactDefinitionDependency[],
): ExactDefinitionDependency[] =>
  [...dependencies].sort((left, right) =>
    compareCanonicalStrings(subjectOf(left), subjectOf(right)),
  );

const verifyParsedModuleRelease = (
  candidate: ValidatedDefinitionPublicationCandidate,
  expectedKey: string,
  release: ResolvableModuleRelease,
  parsedOutput: ReturnType<typeof definitionCompilationOutputSchema.safeParse>,
): void => {
  const publication = release.published.publication;
  try {
    assertModuleContractPair(
      moduleOutputContractVersion(release.compilationOutput),
      publication.validationContractVersion,
    );
  } catch {
    return refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
  }
  const parsedResolution = definitionResolutionSnapshotV3Schema.safeParse(
    release.resolutionSnapshot,
  );
  const ownResolution = parsedResolution.success
    ? parsedResolution.data.definitions.filter(
        (definition) =>
          definition.kind === "module" &&
          definition.key === release.key &&
          definition.rootId === release.rootId &&
          definition.exactVersion === release.releaseVersion,
      )
    : [];
  const authenticResolutionFingerprint = parsedResolution.success
    ? fingerprintCanonicalValue({
        contractVersion: parsedResolution.data.contractVersion,
        definitions: parsedResolution.data.definitions,
        identities: parsedResolution.data.identities,
      })
    : undefined;
  if (
    release.organizationId !== candidate.draft.organizationId ||
    release.key !== expectedKey ||
    !parsedOutput.success ||
    parsedOutput.data.kind !== "module" ||
    !parsedResolution.success ||
    moduleOutputContractVersion(parsedOutput.data) !== publication.validationContractVersion ||
    ownResolution.length !== 1 ||
    authenticResolutionFingerprint !== release.resolutionFingerprint ||
    publication.kind !== "module" ||
    publication.rootId !== release.rootId ||
    publication.revision !== release.releaseRevision ||
    publication.releaseVersion !== release.releaseVersion ||
    publication.contentFingerprint !== release.contentFingerprint ||
    release.compilationOutput.artifact.rootId !== release.rootId ||
    release.compilationOutput.canonical.envelope.key !== release.key ||
    release.compilationOutput.artifact.exactVersion !== release.releaseVersion ||
    release.compilationOutput.artifact.contentFingerprint !== release.contentFingerprint ||
    release.resolutionSnapshot.fingerprint !== release.resolutionFingerprint ||
    release.compilationOutput.artifact.resolutionFingerprint !== release.resolutionFingerprint ||
    release.compilationOutput.resolutionFingerprint !== release.resolutionFingerprint ||
    fingerprintCanonicalValue(release.published.content) !== release.contentFingerprint
  )
    refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
};

/** Every selected, pinned or transitive dependency must satisfy the current Module contract. */
const verifyModuleRelease = (
  candidate: ValidatedDefinitionPublicationCandidate,
  expectedKey: string,
  release: ResolvableModuleRelease,
): void =>
  verifyParsedModuleRelease(
    candidate,
    expectedKey,
    release,
    definitionCompilationOutputSchema.safeParse(release.compilationOutput),
  );

/** Historical enumeration preserves stored semantics before current dependency selection. */
const verifyHistoricalModuleRelease = (
  candidate: ValidatedDefinitionPublicationCandidate,
  expectedKey: string,
  release: ResolvableModuleRelease,
): void =>
  verifyParsedModuleRelease(
    candidate,
    expectedKey,
    release,
    storedModuleCompilationOutputV3Schema.safeParse(release.compilationOutput),
  );

const sameModuleReleaseLocator = (
  left: ResolvableModuleRelease,
  right: ResolvableModuleRelease,
): boolean =>
  left.organizationId === right.organizationId &&
  left.key === right.key &&
  left.rootId === right.rootId &&
  left.releaseRevision === right.releaseRevision &&
  left.releaseVersion === right.releaseVersion &&
  left.contentFingerprint === right.contentFingerprint &&
  left.resolutionFingerprint === right.resolutionFingerprint;

const selectModuleRelease = async (
  reader: DefinitionPublicationReader,
  candidate: ValidatedDefinitionPublicationCandidate,
  key: string,
  requirements: readonly VersionRequirement[],
): Promise<ResolvableModuleRelease> => {
  const selection = createModuleSelectionFold();
  let cursor: ModuleReleasePageCursor | undefined;
  let anchoredRootId: ModuleRootId | undefined;
  let anchoredRevision: Revision | undefined;
  let previousReleaseRevision: Revision | null = null;
  while (true) {
    const page = await reader.readModuleReleasePage(candidate.draft.organizationId, key, cursor);
    if (page.entries.length > 100) refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
    if (cursor === undefined) {
      if (page.rootId === null || page.anchorReleaseRevision === null) {
        if (
          page.rootId !== null ||
          page.anchorReleaseRevision !== null ||
          page.entries.length !== 0 ||
          page.nextAfterReleaseRevision !== null
        )
          refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
        break;
      }
      anchoredRootId = page.rootId;
      anchoredRevision = page.anchorReleaseRevision;
    } else if (
      page.rootId !== cursor.rootId ||
      page.anchorReleaseRevision !== cursor.anchorReleaseRevision
    ) {
      refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
    }
    if (
      anchoredRootId === undefined ||
      anchoredRevision === undefined ||
      page.rootId !== anchoredRootId ||
      page.anchorReleaseRevision !== anchoredRevision ||
      page.entries.length === 0
    )
      refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
    const currentRootId = anchoredRootId as ModuleRootId;
    const currentAnchorRevision = anchoredRevision as Revision;
    for (const entry of page.entries) {
      const release = entry.release;
      if (
        entry.previousReleaseRevision !== previousReleaseRevision ||
        release.rootId !== currentRootId ||
        release.releaseRevision <= (previousReleaseRevision ?? 0) ||
        release.releaseRevision > currentAnchorRevision
      )
        refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
      verifyHistoricalModuleRelease(candidate, key, release);
      foldModuleSelection(selection, release, requirements);
      previousReleaseRevision = release.releaseRevision;
    }
    const last = previousReleaseRevision;
    if (page.nextAfterReleaseRevision === null) {
      if (last !== currentAnchorRevision) refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
      break;
    }
    if (
      last === null ||
      page.nextAfterReleaseRevision !== last ||
      page.nextAfterReleaseRevision >= currentAnchorRevision
    )
      refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
    cursor = {
      rootId: currentRootId,
      anchorReleaseRevision: currentAnchorRevision,
      afterReleaseRevision: page.nextAfterReleaseRevision,
    };
  }
  const selected = completeModuleSelection(selection);
  const exact = await reader.readModuleRelease(
    candidate.draft.organizationId,
    selected.rootId,
    selected.releaseRevision,
  );
  if (exact === undefined || !sameModuleReleaseLocator(selected, exact))
    return refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
  verifyModuleRelease(candidate, key, exact as ResolvableModuleRelease);
  return exact as ResolvableModuleRelease;
};

const verifyConnectionRelease = (
  expectedKey: string,
  release: ResolvableConnectionTypeRelease,
): void => {
  const output = definitionCompilationOutputSchema.safeParse(release.compilationOutput);
  if (
    release.key !== expectedKey ||
    !stable(release.releaseVersion) ||
    !output.success ||
    output.data.kind !== "connection_type" ||
    output.data.canonical.key !== release.key ||
    output.data.artifact.rootId !== release.rootId ||
    output.data.artifact.exactVersion !== release.releaseVersion ||
    output.data.artifact.contentFingerprint !== release.contentFingerprint ||
    fingerprintCanonicalValue(output.data.canonical) !== release.contentFingerprint
  )
    refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
};

const findPinned = <Kind extends ExactDefinitionDependency["kind"]>(
  manifest: readonly ExactDefinitionDependency[],
  kind: Kind,
  subject: string,
  releaseVersion?: string,
): Extract<ExactDefinitionDependency, { kind: Kind }> => {
  const matches = manifest.filter(
    (entry) =>
      entry.kind === kind &&
      (entry.kind === "platform_theme"
        ? entry.catalogueThemeId === subject
        : entry.kind === "platform_block"
          ? entry.blockId === subject &&
            (releaseVersion === undefined || entry.releaseVersion === releaseVersion)
          : entry.kind === "protected_operation"
            ? entry.operation.operationId === subject
            : entry.kind === "module" || entry.kind === "connection_type"
              ? entry.key === subject
              : false),
  );
  if (matches.length !== 1) return refuse("DEFINITION_CONFIRMATION_MISMATCH");
  return matches[0] as Extract<ExactDefinitionDependency, { kind: Kind }>;
};

const resolveApplicationCompositionV2 = async (
  source: ApplicationSourceDocumentV2,
  catalogue: DefinitionPublicationCatalogue,
  modules: readonly ResolvableModuleRelease[],
  pinned?: readonly ExactDefinitionDependency[],
): Promise<ApplicationCompositionCatalogueSnapshotV2> => {
  const customComponentPlacement = {
    applicationKey: source.key,
    boundModuleReleases: modules.map((module) => ({
      moduleKey: module.key,
      releaseVersion: module.releaseVersion,
    })),
  };
  const selection = {
    platformBlocks: source.body.platform_block_dependencies.map((dependency) => ({
      blockId: dependency.block_id,
      releaseVersion: dependency.release_version,
    })),
    platformTheme: {
      catalogueThemeId: source.body.theme.base.catalogue_theme_id,
      releaseVersion: source.body.theme.base.release_version,
    },
    customComponentPlacement,
  };
  const candidate = await catalogue.readApplicationCompositionCatalogueSnapshotV2(selection);
  if (candidate === undefined) return refuse("DEFINITION_DEPENDENCY_MISSING");
  const parsed = applicationCompositionCatalogueSnapshotV2Schema.safeParse(candidate);
  if (!parsed.success) return refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
  const snapshot = parsed.data;
  // A custom component is placeable only by its owning application or by an application that binds
  // the exact owning module release; the catalogue already filters, and this re-checks the returned
  // snapshot so a substituted catalogue can never introduce a foreign component.
  for (const release of snapshot.platformBlocks.releases) {
    const custom = release.customComponent;
    if (
      custom !== undefined &&
      !customComponentPlacementAllowedV2(custom.owner, customComponentPlacement)
    )
      return refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
  }
  const fingerprint = fingerprintCanonicalValue({
    contractVersion: snapshot.contractVersion,
    platformBlocks: snapshot.platformBlocks,
    platformTheme: snapshot.platformTheme,
  });
  if (snapshot.fingerprint !== fingerprint) refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
  const blocks = new Map(
    snapshot.platformBlocks.releases.map((release) => [
      `${release.blockId}@${release.releaseVersion}`,
      release,
    ] as const),
  );
  if (blocks.size !== source.body.platform_block_dependencies.length)
    refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
  for (const authored of source.body.platform_block_dependencies) {
    const release = blocks.get(`${authored.block_id}@${authored.release_version}`);
    if (
      release === undefined ||
      !stable(release.releaseVersion) ||
      release.releaseVersion !== authored.release_version ||
      release.contentFingerprint !== authored.content_fingerprint ||
      release.catalogueFingerprint !== authored.catalogue_fingerprint
    )
      return refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
    if (pinned !== undefined) {
      const exact = findPinned(
        pinned,
        "platform_block",
        String(authored.block_id),
        String(authored.release_version),
      );
      if (
        exact.releaseVersion !== release.releaseVersion ||
        exact.contentFingerprint !== release.contentFingerprint ||
        exact.catalogueFingerprint !== release.catalogueFingerprint
      )
        refuse("DEFINITION_CONFIRMATION_MISMATCH");
    }
  }
  const base = source.body.theme.base;
  if (
    snapshot.platformTheme.catalogueThemeId !== base.catalogue_theme_id ||
    snapshot.platformTheme.releaseVersion !== base.release_version ||
    snapshot.platformTheme.contentFingerprint !== base.content_fingerprint ||
    snapshot.platformTheme.catalogueFingerprint !== base.catalogue_fingerprint ||
    !stable(snapshot.platformTheme.releaseVersion)
  )
    refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
  if (pinned !== undefined) {
    const exact = findPinned(pinned, "platform_theme", String(base.catalogue_theme_id));
    if (
      exact.releaseVersion !== snapshot.platformTheme.releaseVersion ||
      exact.contentFingerprint !== snapshot.platformTheme.contentFingerprint ||
      exact.catalogueFingerprint !== snapshot.platformTheme.catalogueFingerprint
    )
      refuse("DEFINITION_CONFIRMATION_MISMATCH");
  }
  return snapshot;
};

const resolveDependencies = async (
  reader: DefinitionPublicationReader,
  catalogue: DefinitionPublicationCatalogue,
  candidate: ValidatedDefinitionPublicationCandidate,
  pinned?: readonly ExactDefinitionDependency[],
): Promise<ResolvedDependencies> => {
  const modules: ResolvableModuleRelease[] = [];
  for (const [key, requirements] of groupRequirements(moduleRequirements(candidate.draft))) {
    let release: ResolvableModuleRelease | undefined;
    if (pinned === undefined) {
      release = await selectModuleRelease(reader, candidate, key, requirements);
    } else {
      const exact = findPinned(pinned, "module", key);
      if (!accepts(requirements, exact.releaseVersion)) refuse("DEFINITION_CONFIRMATION_MISMATCH");
      release = await reader.readModuleRelease(
        candidate.draft.organizationId,
        exact.rootId,
        exact.releaseRevision,
      );
      if (
        release === undefined ||
        release.releaseVersion !== exact.releaseVersion ||
        release.contentFingerprint !== exact.contentFingerprint ||
        release.resolutionFingerprint !== exact.resolutionFingerprint
      )
        refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
    }
    if (release === undefined) refuse("DEFINITION_DEPENDENCY_MISSING");
    const resolvedRelease = release as ResolvableModuleRelease;
    verifyModuleRelease(candidate, key, resolvedRelease);
    modules.push(resolvedRelease);
  }

  const connections: ResolvableConnectionTypeRelease[] = [];
  for (const [key, requirements] of groupRequirements(connectionRequirements(candidate.draft))) {
    let release: ResolvableConnectionTypeRelease | undefined;
    if (pinned === undefined) {
      release = chooseStableRelease(await catalogue.listConnectionTypeReleases(key), requirements);
    } else {
      const exact = findPinned(pinned, "connection_type", key);
      if (!accepts(requirements, exact.releaseVersion)) refuse("DEFINITION_CONFIRMATION_MISMATCH");
      release = await catalogue.readConnectionTypeRelease(exact.rootId, exact.releaseVersion);
      if (
        release === undefined ||
        release.contentFingerprint !== exact.contentFingerprint ||
        release.catalogueFingerprint !== exact.catalogueFingerprint
      )
        refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
    }
    if (release === undefined) refuse("DEFINITION_DEPENDENCY_MISSING");
    const resolvedRelease = release as ResolvableConnectionTypeRelease;
    verifyConnectionRelease(key, resolvedRelease);
    connections.push(resolvedRelease);
  }

  let compositionV2: ApplicationCompositionCatalogueSnapshotV2 | undefined;
  if (candidate.draft.source.kind === "application")
    compositionV2 = await resolveApplicationCompositionV2(
      candidate.draft.source,
      catalogue,
      modules,
      pinned,
    );

  const platformOperations: PlatformServiceOperationRelease[] = [];
  const platformOperationSubjects = new Set<string>();
  if (candidate.draft.source.kind === "application") {
    // A flow names a platform-service operation only by its key, so the release the catalogue holds
    // for that operation is what publication pins.
    for (const operation of platformOperationsCalledBy(candidate.draft.source.body.flows)) {
      const registered = operation.release;
      const release = await catalogue.readPlatformServiceOperationRelease?.(
        registered.serviceId,
        registered.operationId,
        registered.releaseVersion,
      );
      if (
        release === undefined ||
        release.serviceId !== registered.serviceId ||
        release.operationId !== registered.operationId ||
        release.releaseVersion !== registered.releaseVersion
      )
        refuse(
          release === undefined
            ? "DEFINITION_DEPENDENCY_MISSING"
            : "DEFINITION_DEPENDENCY_SUBSTITUTED",
        );
      if (pinned !== undefined) {
        const exact = pinned.flatMap((dependency) =>
          dependency.kind === "protected_operation" &&
          dependency.operation.owner.kind === "platform_service" &&
          dependency.operation.owner.serviceId === registered.serviceId &&
          dependency.operation.operationId === registered.operationId
            ? [dependency]
            : [],
        );
        if (exact.length !== 1) refuse("DEFINITION_CONFIRMATION_MISMATCH");
        const pinnedOperation = exact[0]!;
        if (
          pinnedOperation.releaseVersion !== release.releaseVersion ||
          pinnedOperation.contentFingerprint !== release.contentFingerprint ||
          pinnedOperation.catalogueFingerprint !== release.catalogueFingerprint
        )
          refuse("DEFINITION_CONFIRMATION_MISMATCH");
      }
      const subject = `${release.serviceId}:${release.operationId}:${release.releaseVersion}`;
      if (!platformOperationSubjects.has(subject)) {
        platformOperationSubjects.add(subject);
        platformOperations.push(release);
      }
    }
  }

  const expectedSubjects = [
    ...modules.map((release) => `module:${release.key}`),
    ...connections.map((release) => `connection_type:${release.key}`),
    ...(compositionV2 === undefined
      ? []
      : [
          ...compositionV2.platformBlocks.releases.map(
            (release) => `platform_block:${release.blockId}@${release.releaseVersion}`,
          ),
          `platform_theme:${compositionV2.platformTheme.catalogueThemeId}`,
        ]),
  ].sort(compareCanonicalStrings);
  if (
    pinned !== undefined &&
    JSON.stringify(
      [...pinned]
        .filter((dependency) =>
          ["module", "connection_type", "platform_block", "platform_theme"].includes(
            dependency.kind,
          ),
        )
        .map(subjectOf)
        .sort(compareCanonicalStrings),
    ) !==
      JSON.stringify(expectedSubjects)
  )
    refuse("DEFINITION_CONFIRMATION_MISMATCH");
  return {
    modules,
    connections,
    platformOperations,
    ...(compositionV2 === undefined ? {} : { compositionV2 }),
  };
};

const assertNoCycle = async (
  reader: DefinitionPublicationReader,
  candidate: ValidatedDefinitionPublicationCandidate,
  modules: readonly ResolvableModuleRelease[],
): Promise<void> => {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = async (release: ResolvableModuleRelease): Promise<void> => {
    if (String(release.rootId) === String(candidate.draft.rootId))
      refuse("DEFINITION_DEPENDENCY_CYCLE");
    const reference = `${release.rootId}:${release.releaseRevision}`;
    if (visiting.has(reference)) refuse("DEFINITION_DEPENDENCY_CYCLE");
    if (visited.has(reference)) return;
    visiting.add(reference);
    for (const dependency of release.published.dependencyManifest) {
      if (dependency.kind !== "module") refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
      const moduleDependency = dependency as Extract<
        (typeof release.published.dependencyManifest)[number],
        { kind: "module" }
      >;
      const child = await reader.readModuleRelease(
        candidate.draft.organizationId,
        moduleDependency.rootId,
        moduleDependency.revision,
      );
      if (
        child === undefined ||
        child.releaseVersion !== moduleDependency.releaseVersion ||
        child.contentFingerprint !== moduleDependency.contentFingerprint
      )
        refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
      if (child === undefined) refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
      const resolvedChild = child as ResolvableModuleRelease;
      verifyModuleRelease(candidate, resolvedChild.key, resolvedChild);
      await visit(resolvedChild);
    }
    visiting.delete(reference);
    visited.add(reference);
  };
  for (const module of modules) await visit(module);
};

/**
 * Pins each contained Application flow and protected Record or Query node, with the canonical
 * operation set resolved from that publication's exact definitions and dependencies. Platform
 * operations called by flows keep their own exact catalogue release entries.
 */
const protectedOperationReferenceLookups = (
  resolution: DefinitionResolution,
  dependencies: ResolvedDependencies,
): ProtectedOperationReferenceLookups => {
  const definitionsByKey = new Map<string, typeof resolution.definitions>();
  for (const definition of resolution.definitions)
    definitionsByKey.set(definition.key, [
      ...(definitionsByKey.get(definition.key) ?? []),
      definition,
    ]);

  const recordTypesById = new Map<string, ProtectedOperationReference>();
  const queriesById = new Map<string, ProtectedOperationReference>();
  const ownerReferenceFor = (
    definitionKey: string,
    operationId: string,
  ): ProtectedOperationReference => {
    const owners = (definitionsByKey.get(definitionKey) ?? []).filter(
      (definition) => definition.kind === "application" || definition.kind === "module",
    );
    if (owners.length !== 1) return refuse("DEFINITION_COMPILATION_REFUSED");
    const owner = owners[0]!;
    return protectedOperationReferenceSchema.parse({
      owner:
        owner.kind === "application"
          ? { kind: "application", applicationRootId: owner.rootId }
          : { kind: "module", moduleRootId: owner.rootId },
      operationId,
    });
  };
  for (const identity of resolution.identities) {
    if (identity.kind !== "record_type" && identity.kind !== "query") continue;
    const reference = ownerReferenceFor(identity.definitionKey, identity.identifier);
    const references = identity.kind === "record_type" ? recordTypesById : queriesById;
    const key = identity.identifier.toLowerCase();
    const prior = references.get(key);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(reference))
      return refuse("DEFINITION_COMPILATION_REFUSED");
    references.set(key, reference);
  }

  const relationshipRecordTypeIdsById = new Map<string, readonly string[]>();
  for (const release of dependencies.modules) {
    const moduleOutput = release.compilationOutput;
    if (moduleOutput.kind !== "module") return refuse("DEFINITION_COMPILATION_REFUSED");
    for (const recordType of moduleOutput.canonical.content.recordTypes)
      for (const relationship of recordType.relationships) {
        const targets = relationship.toRecordType
          ? [relationship.toRecordType]
          : relationship.toRecordTypes ?? [];
        const resolvedTargets = targets.filter((target) => target.state === "resolved");
        const recordTypeIds =
          targets.length > 0 && resolvedTargets.length === targets.length
            ? [String(relationship.fromRecordTypeId), ...resolvedTargets.map((target) => String(target.recordTypeId))]
            : [];
        const key = String(relationship.relationshipId).toLowerCase();
        const prior = relationshipRecordTypeIdsById.get(key);
        if (
          prior !== undefined &&
          JSON.stringify([...prior].map((id) => id.toLowerCase()).sort(compareCanonicalStrings)) !==
            JSON.stringify([...recordTypeIds].map((id) => id.toLowerCase()).sort(compareCanonicalStrings))
        )
          return refuse("DEFINITION_COMPILATION_REFUSED");
        relationshipRecordTypeIdsById.set(key, recordTypeIds);
      }
  }

  return { recordTypesById, queriesById, relationshipRecordTypeIdsById };
};

const flowTargetManifestFor = (
  dependencies: ResolvedDependencies,
  output: Exclude<DefinitionCompilationOutput, { kind: "connection_type" }>,
  resolution: DefinitionResolution,
): ExactDefinitionDependency[] => {
  if (output.kind !== "application") return [];
  const flows = output.canonical.content.flows as unknown as FlowDefinition[];
  const nodeReferences = flowOperationReferencesByNode(
    flows,
    protectedOperationReferenceLookups(resolution, dependencies),
  );
  const flowEntries: ExactDefinitionDependency[] = flows.map((flow) => ({
    kind: "application_flow" as const,
    applicationRootId: output.artifact.rootId,
    flowId: flow.id,
    releaseVersion: output.artifact.exactVersion,
    contentFingerprint: output.artifact.contentFingerprint,
    resolutionFingerprint: output.resolutionFingerprint,
  }));
  const flowNodeEntries: ExactDefinitionDependency[] = nodeReferences.map((node) => ({
    kind: "application_flow_node" as const,
    applicationRootId: output.artifact.rootId,
    flowId: node.flowId,
    nodeId: node.nodeId,
    operations: [...node.operations],
    grantable: node.operations.length > 0,
    releaseVersion: output.artifact.exactVersion,
    contentFingerprint: output.artifact.contentFingerprint,
    resolutionFingerprint: output.resolutionFingerprint,
  }));
  const platformOperationEntries: ExactDefinitionDependency[] =
    dependencies.platformOperations.map((release) => ({
      kind: "protected_operation" as const,
      operation: {
        owner: { kind: "platform_service" as const, serviceId: release.serviceId },
        operationId: release.operationId,
      },
      releaseVersion: release.releaseVersion,
      contentFingerprint: release.contentFingerprint,
      resolutionFingerprint: output.resolutionFingerprint,
      catalogueFingerprint: release.catalogueFingerprint,
    }));
  return [...flowEntries, ...flowNodeEntries, ...platformOperationEntries];
};

const manifestFor = (
  dependencies: ResolvedDependencies,
  output: Exclude<DefinitionCompilationOutput, { kind: "connection_type" }>,
  resolution: DefinitionResolution,
): ExactDefinitionDependency[] =>
  sortedManifest([
    ...dependencies.modules.map((release) => ({
      kind: "module" as const,
      key: release.key,
      rootId: release.rootId,
      releaseRevision: release.releaseRevision,
      releaseVersion: release.releaseVersion,
      contentFingerprint: release.contentFingerprint,
      resolutionFingerprint: release.resolutionFingerprint,
    })),
    ...dependencies.connections.map((release) => ({
      kind: "connection_type" as const,
      key: release.key,
      rootId: release.rootId,
      releaseVersion: release.releaseVersion,
      contentFingerprint: release.contentFingerprint,
      catalogueFingerprint: release.catalogueFingerprint,
    })),
    ...(dependencies.compositionV2 === undefined
      ? []
      : [
          ...dependencies.compositionV2.platformBlocks.releases.map((release) => ({
            kind: "platform_block" as const,
            blockId: release.blockId,
            releaseVersion: release.releaseVersion,
            contentFingerprint: release.contentFingerprint,
            catalogueFingerprint: release.catalogueFingerprint,
          })),
          {
            kind: "platform_theme" as const,
            catalogueThemeId: dependencies.compositionV2.platformTheme.catalogueThemeId,
            releaseVersion: dependencies.compositionV2.platformTheme.releaseVersion,
            contentFingerprint: dependencies.compositionV2.platformTheme.contentFingerprint,
            catalogueFingerprint: dependencies.compositionV2.platformTheme.catalogueFingerprint,
          },
        ]),
    ...flowTargetManifestFor(dependencies, output, resolution),
  ]);

const buildResolution = (
  candidate: ValidatedDefinitionPublicationCandidate,
  dependencies: ResolvedDependencies,
  ownVersion: string,
): DefinitionResolution => {
  const ownDefinition: DefinitionResolutionSnapshotV2["definitions"][number] =
    candidate.draft.kind === "module"
      ? {
          kind: "module",
          key: candidate.draft.key,
          rootId: candidate.draft.rootId,
          exactVersion: ownVersion,
        }
      : {
          kind: "application",
          key: candidate.draft.key,
          rootId: candidate.draft.rootId,
          exactVersion: ownVersion,
        };
  const definitions: DefinitionResolutionSnapshotV2["definitions"] = [
    ownDefinition,
    ...dependencies.modules.map((release) => ({
      kind: "module" as const,
      key: release.key,
      rootId: release.rootId,
      exactVersion: release.releaseVersion,
    })),
    ...dependencies.connections.map((release) => ({
      kind: "connection_type" as const,
      key: release.key,
      rootId: release.rootId,
      exactVersion: release.releaseVersion,
      operationKeys: release.compilationOutput.canonical.operations.map(
        (operation) => operation.key,
      ),
    })),
  ].sort((left, right) =>
    compareCanonicalStrings(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`),
  );
  const allIdentities = [
    ...candidate.identities,
    ...dependencies.modules.flatMap((release) =>
      release.resolutionSnapshot.identities.filter(
        (identity) => identity.definitionKey === release.key,
      ),
    ),
  ].sort((left, right) =>
    compareCanonicalStrings(
      JSON.stringify([
        left.definitionKey,
        left.scope,
        left.kind,
        left.componentOwner,
        left.alias,
        left.identifier,
      ]),
      JSON.stringify([
        right.definitionKey,
        right.scope,
        right.kind,
        right.componentOwner,
        right.alias,
        right.identifier,
      ]),
    ),
  );
  if (candidate.draft.source.kind === "module") {
    const evidence = { contractVersion: "3.0.0" as const, definitions, identities: allIdentities };
    return definitionResolutionSnapshotV3Schema.parse({
      ...evidence,
      fingerprint: fingerprintCanonicalValue(evidence),
    });
  }
  return createApplicationResolutionSnapshotV2({
    definitions,
    identities: allIdentities.filter(
      (identity): identity is DefinitionResolutionSnapshotV2["identities"][number] =>
        sourceIdentityKindV2Schema.safeParse(identity.kind).success,
    ),
  });
};

const draftMetadata = (draft: StoredDefinitionDraft) => ({
  organizationId: draft.organizationId,
  draftRevision: draft.draftRevision,
  ...(draft.publishedRevision === undefined ? {} : { publishedRevision: draft.publishedRevision }),
  createdAt: draft.createdAt,
  createdBy: draft.createdBy,
  updatedAt: draft.updatedAt,
  updatedBy: draft.updatedBy,
});

const provisionalSavedConditionRevisions = (
  candidate: ValidatedDefinitionPublicationCandidate,
): SavedConditionRevisionAssignment[] => {
  if (candidate.draft.kind !== "module") return [];
  const conditions = candidate.draft.source.body.sharing_conditions;
  return conditions.map((condition) => {
    const matches = candidate.identities.filter(
      (identity) =>
        identity.definitionKey === candidate.draft.key &&
        identity.kind === "sharing_condition" &&
        identity.componentOwner === condition.id,
    );
    const identifiers = [...new Set(matches.map((identity) => identity.identifier))];
    if (identifiers.length !== 1) refuse("DEFINITION_COMPILATION_REFUSED");
    return savedConditionRevisionAssignmentSchema.parse({
      conditionId: identifiers[0]!,
      revision: 1,
    });
  });
};

/**
 * The request parse compileDefinitionWithContext performed for the requests this service
 * assembles. compileParsedDefinition takes a parsed request, so the parse happens here, with the
 * schema that entry point would have selected, and refuses in the same way.
 */
const parsedCompilationRequest = <Schema extends z.ZodType>(
  schema: Schema,
  request: unknown,
): z.output<Schema> => {
  const parsed = schema.safeParse(request);
  if (!parsed.success)
    throw new DefinitionCompilationError(
      "vortex.definition.invalid_compilation_request",
      "invalid_value",
    );
  return parsed.data;
};

const assertFinalPublicationValidation = (
  request:
    | z.output<typeof applicationCompilationRequestV2Schema>
    | z.output<typeof moduleCompilationRequestV3Schema>,
  output: Exclude<DefinitionCompilationOutput, { kind: "connection_type" }>,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
  historyEvidence: DefinitionPublicationHistoryEvidence,
): void => {
  const validation = validateDefinitionSet({
    requests: [request],
    outputs: [output],
    dependencyOutputs,
    publishedHistoryEvidence: [historyEvidence],
  });
  if (!validation.valid) {
    const first = validation.failures[0]!;
    throw new DefinitionCompilationError(first.ruleCode, first.family, first.location);
  }
};

type CompiledModuleCandidate = Readonly<{
  request: z.output<typeof moduleCompilationRequestV3Schema>;
  output: ModuleOutput;
  dependencyOutputs: readonly DefinitionCompilationOutput[];
}>;

const compileModuleCandidate = (
  candidate: ValidatedDefinitionPublicationCandidate,
  dependencies: ResolvedDependencies,
  resolution: DefinitionResolution,
): CompiledModuleCandidate => {
  if (candidate.draft.source.kind !== "module" || resolution.contractVersion !== "3.0.0")
    return refuse("DEFINITION_COMPILATION_REFUSED");
  const dependencyOutputs = [
    ...dependencies.modules.map((release) => release.compilationOutput),
    ...dependencies.connections.map((release) => release.compilationOutput),
  ].map((output) => definitionCompilationOutputSchema.parse(output));
  const common = {
    sourceContractVersion: "3.0.0" as const,
    validationContractVersion: "3.0.0" as const,
    source: candidate.draft.source,
    resolution,
    draftMetadata: draftMetadata(candidate.draft),
  };
  const provisional = compileParsedDefinition(
    parsedCompilationRequest(moduleCompilationRequestV3Schema, {
      ...common,
      savedConditionRevisions: provisionalSavedConditionRevisions(candidate),
    }),
    dependencyOutputs,
  );
  if (
    provisional.kind !== "module" ||
    !("validationContractVersion" in provisional) ||
    provisional.validationContractVersion !== "3.0.0"
  )
    return refuse("DEFINITION_COMPILATION_REFUSED");
  if (candidate.historyEvidence.kind !== "module") return refuse("DEFINITION_HISTORY_INVALID");
  const savedConditionRevisions = deriveSavedConditionRevisionsFromHistoryEvidence(
    candidate.historyEvidence,
    candidate.draft.rootId,
    provisional.canonical.content.sharingConditions,
  );
  const request = parsedCompilationRequest(moduleCompilationRequestV3Schema, {
    ...common,
    savedConditionRevisions,
  });
  const output = compileParsedDefinition(request, dependencyOutputs);
  if (
    output === undefined ||
    output.kind !== "module" ||
    !("validationContractVersion" in output) ||
    output.validationContractVersion !== "3.0.0"
  )
    return refuse("DEFINITION_COMPILATION_REFUSED");
  return { request, output, dependencyOutputs };
};

const compileCandidate = (
  candidate: ValidatedDefinitionPublicationCandidate,
  dependencies: ResolvedDependencies,
  resolution: DefinitionResolution,
  final: boolean,
): PublishableCompilationOutput => {
  const dependencyOutputs = [
    ...dependencies.modules.map((release) => release.compilationOutput),
    ...dependencies.connections.map((release) => release.compilationOutput),
  ].map((output) => definitionCompilationOutputSchema.parse(output));
  if (candidate.draft.source.kind === "application") {
    if (resolution.contractVersion !== "2.0.0" || dependencies.compositionV2 === undefined)
      return refuse("DEFINITION_COMPILATION_REFUSED");
    const request = {
      sourceContractVersion: "2.0.0" as const,
      validationContractVersion: "2.0.0" as const,
      source: candidate.draft.source,
      resolution,
      catalogueSnapshot: dependencies.compositionV2,
      draftMetadata: draftMetadata(candidate.draft),
    };
    const output = compileParsedDefinition(
      parsedCompilationRequest(applicationCompilationRequestV2Schema, request),
      dependencyOutputs,
    );
    if (
      final &&
      (output.kind !== "application" ||
        output.platformCompatibilityVersion !== APPLICATION_PLATFORM_COMPATIBILITY_VERSION)
    )
      return refuse("DEFINITION_COMPILATION_REFUSED");
    if (final)
      assertFinalPublicationValidation(
        parsedCompilationRequest(applicationCompilationRequestV2Schema, request),
        output,
        dependencyOutputs,
        candidate.historyEvidence,
      );
    return output;
  }
  if (candidate.draft.source.kind === "module") {
    if (final) {
      const compiled = compileModuleCandidate(candidate, dependencies, resolution);
      assertFinalPublicationValidation(
        compiled.request,
        compiled.output,
        compiled.dependencyOutputs,
        candidate.historyEvidence,
      );
      return compiled.output;
    }
    if (resolution.contractVersion !== "3.0.0") return refuse("DEFINITION_COMPILATION_REFUSED");
    const common = {
      sourceContractVersion: "3.0.0" as const,
      validationContractVersion: "3.0.0" as const,
      source: candidate.draft.source,
      resolution,
      draftMetadata: draftMetadata(candidate.draft),
    };
    const provisional = compileParsedDefinition(
      parsedCompilationRequest(moduleCompilationRequestV3Schema, {
        ...common,
        savedConditionRevisions: provisionalSavedConditionRevisions(candidate),
      }),
      dependencyOutputs,
    );
    if (
      provisional.kind !== "module" ||
      !("validationContractVersion" in provisional) ||
      provisional.validationContractVersion !== "3.0.0"
    )
      return refuse("DEFINITION_COMPILATION_REFUSED");
    if (candidate.historyEvidence.kind !== "module") return refuse("DEFINITION_HISTORY_INVALID");
    const savedConditionRevisions = deriveSavedConditionRevisionsFromHistoryEvidence(
      candidate.historyEvidence,
      candidate.draft.rootId,
      provisional.canonical.content.sharingConditions,
    );
    const request = {
      ...common,
      savedConditionRevisions,
    };
    return compileParsedDefinition(
      parsedCompilationRequest(moduleCompilationRequestV3Schema, request),
      dependencyOutputs,
    );
  }
  // Only an Application or a Module is a customer-publishable definition, and each has exactly
  // one current source/validation contract pair. A stored draft of any other shape is refused.
  return refuse("DEFINITION_COMPILATION_REFUSED");
};

const validateCandidate = (
  context: SessionContext,
  candidateInput: DefinitionPublicationCandidate | undefined,
  command: PrepareDefinitionPublicationCommand,
): ValidatedDefinitionPublicationCandidate => {
  if (candidateInput === undefined) return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  const supplied = candidateInput;
  const draft = storedDefinitionDraftSchema.safeParse(supplied.draft);
  if (!draft.success || !isVerifiedDefinitionPublicationHistoryEvidence(supplied.historyEvidence))
    return refuse("DEFINITION_HISTORY_INVALID");
  const candidate: ValidatedDefinitionPublicationCandidate = {
    draft: draft.data,
    identities: supplied.identities,
    historyEvidence: supplied.historyEvidence,
  };
  if (candidate.draft.organizationId !== context.organizationId)
    refuse("DEFINITION_ORGANIZATION_MISMATCH");
  if (
    String(candidate.draft.rootId) !== String(command.rootId) ||
    candidate.draft.draftRevision !== command.expectedDraftRevision
  )
    refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  if (
    candidate.historyEvidence.kind !== candidate.draft.kind ||
    candidate.historyEvidence.definitionKey !== candidate.draft.key ||
    String(candidate.historyEvidence.rootId) !== String(candidate.draft.rootId)
  )
    refuse("DEFINITION_HISTORY_INVALID");
  const latest = candidate.historyEvidence.latestRelease;
  if (
    candidate.draft.publishedRevision !== latest?.publication.revision ||
    candidate.draft.sourceFingerprint !== fingerprintCanonicalValue(candidate.draft.source)
  )
    refuse(
      candidate.draft.sourceFingerprint !== fingerprintCanonicalValue(candidate.draft.source)
        ? "DEFINITION_SOURCE_EVIDENCE_MISMATCH"
        : "DEFINITION_HISTORY_INVALID",
    );
  return candidate;
};

/** The one explicit comparator contract each stored draft kind declares. */
const candidateValidationContractVersion = (
  source: StoredDefinitionDraft["source"],
): Readonly<{ validationContractVersion: "2.0.0" | "3.0.0" }> => ({
  validationContractVersion: source.kind === "module" ? "3.0.0" : "2.0.0",
});

const prepareFromReader = async (
  context: SessionContext,
  reader: DefinitionPublicationReader,
  catalogue: DefinitionPublicationCatalogue,
  command: PrepareDefinitionPublicationCommand,
  candidateInput: DefinitionPublicationCandidate | undefined,
  pinned?: readonly ExactDefinitionDependency[],
): Promise<PreparedState> => {
  const candidate = validateCandidate(context, candidateInput, command);
  const dependencies = await resolveDependencies(reader, catalogue, candidate, pinned);
  await assertNoCycle(reader, candidate, dependencies.modules);
  const provisionalVersion =
    candidate.historyEvidence.latestRelease?.publication.releaseVersion ?? "1.0.0";
  const provisionalResolution = buildResolution(candidate, dependencies, provisionalVersion);
  const provisional = compileCandidate(candidate, dependencies, provisionalResolution, false);
  const impact = compareDefinitionVersionImpactWithEvidence({
    kind: candidate.draft.kind,
    ...candidateValidationContractVersion(candidate.draft.source),
    historyEvidence: candidate.historyEvidence,
    candidate: provisional.canonical,
  });
  if (impact.outcome === "no_change") refuse("DEFINITION_NO_CHANGE");
  const confirmableImpact = impact as Extract<typeof impact, { assignedVersion: string }>;
  const resolution = buildResolution(candidate, dependencies, confirmableImpact.assignedVersion);
  const compilationOutput = compileCandidate(candidate, dependencies, resolution, true);
  const confirmedImpact = compareDefinitionVersionImpactWithEvidence({
    kind: candidate.draft.kind,
    ...candidateValidationContractVersion(candidate.draft.source),
    historyEvidence: candidate.historyEvidence,
    candidate: compilationOutput.canonical,
  });
  if (confirmedImpact.outcome === "no_change") refuse("DEFINITION_VERSION_REFUSED");
  const finalImpact = confirmedImpact as Extract<
    typeof confirmedImpact,
    { assignedVersion: string }
  >;
  if (
    finalImpact.assignedVersion !== confirmableImpact.assignedVersion
  )
    refuse("DEFINITION_VERSION_REFUSED");
  const confirmation = definitionPublicationConfirmationSchema.parse({
    outcome: finalImpact.outcome,
    rootId: candidate.draft.rootId,
    expectedDraftRevision: candidate.draft.draftRevision,
    sourceFingerprint: candidate.draft.sourceFingerprint,
    assignedVersion: finalImpact.assignedVersion,
    contentFingerprint: compilationOutput.artifact.contentFingerprint,
    resolutionFingerprint: compilationOutput.resolutionFingerprint,
    comparisonFingerprint: finalImpact.comparisonFingerprint,
    dependencyManifest: manifestFor(dependencies, compilationOutput, resolution),
    reasons: finalImpact.reasons,
    ...(finalImpact.outcome === "release_required" ? { impact: finalImpact.impact } : {}),
  });
  return {
    confirmation,
    draft: candidate.draft,
    compilationOutput,
    resolutionSnapshot: resolution,
  };
};

const safely = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DefinitionPublicationError) throw error;
    if (error instanceof DefinitionCompilationError) refuse("DEFINITION_COMPILATION_REFUSED");
    if (error instanceof DefinitionVersionImpactError) refuse("DEFINITION_VERSION_REFUSED");
    return refuse("DEFINITION_PUBLICATION_FAILED");
  }
};

/**
 * The authority decides for exactly one organisation. A context for any other organisation is
 * refused before the authority or any evidence is consulted.
 */
const authorize = async (
  authority: BuilderAuthority,
  context: SessionContext,
  operation: BuilderOperation,
): Promise<void> => {
  if (
    typeof context?.organizationId !== "string" ||
    context.organizationId.toLowerCase() !== authority.organizationId.toLowerCase()
  )
    refuse("DEFINITION_PUBLICATION_FAILED");
  await requireBuilderAuthority(authority, operation);
};

const moduleQueryFilterReadCommandSchema = z
  .object({
    rootId: platformIdSchema,
    expectedDraftRevision: revisionSchema,
    expectedSavedSourceFingerprint: fingerprintSchema,
    queryAlias: z.string().min(1).max(160).optional(),
  })
  .strict();

const moduleQueryFilterValidationCommandSchema = z
  .object({
    rootId: platformIdSchema,
    expectedDraftRevision: revisionSchema,
    expectedSavedSourceFingerprint: fingerprintSchema,
    expectedResolutionFingerprint: fingerprintSchema,
    expectedOperandBindingFingerprint: fingerprintSchema,
    queryAlias: z.string().min(1).max(160),
    filter: z.union([z.null(), sourceConditionSchema]),
  })
  .strict();

const moduleQueryFieldTypes = new Set<ModuleFieldV3["type"]>([
  "text",
  "long_text",
  "whole_number",
  "yes_no",
  "date",
  "date_time",
]);
const isModuleQueryFilterParameterType = (value: string): value is ModuleQueryFilterParameterType =>
  value === "text" ||
  value === "number" ||
  value === "decimal_number" ||
  value === "money" ||
  value === "boolean" ||
  value === "date" ||
  value === "date_time";

const moduleValidationRoot = (source: ModuleSourceDocument): DefinitionValidationLocation => ({
  documentKind: "module",
  documentKey: source.key,
  segments: [{ kind: "module", key: source.key }],
});

const moduleValidationPathMap = (
  source: ModuleSourceDocument,
): DefinitionValidationTranslationContext["pathMap"] => {
  const rootLocation = moduleValidationRoot(source);
  const pathMap: NonNullable<DefinitionValidationTranslationContext["pathMap"]> = [];
  source.body.record_types.forEach((record, recordIndex) => {
    const recordLocation: DefinitionValidationLocation = {
      ...rootLocation,
      segments: [...rootLocation.segments, { kind: "record_type", key: record.key }],
    };
    pathMap.push({ sourcePath: ["body", "record_types", recordIndex], location: recordLocation });
    record.fields.forEach((field, fieldIndex) => {
      pathMap.push({
        sourcePath: ["body", "record_types", recordIndex, "fields", fieldIndex],
        location: {
          ...recordLocation,
          segments: [...recordLocation.segments, { kind: "field", key: field.key }],
        },
      });
    });
  });
  source.body.queries.forEach((query, queryIndex) => {
    pathMap.push({
      sourcePath: ["body", "queries", queryIndex],
      location: {
        ...rootLocation,
        segments: [...rootLocation.segments, { kind: "query", key: query.key }],
      },
    });
  });
  return pathMap;
};

const moduleValidationTranslationContext = (
  source: ModuleSourceDocument,
  correlationId: string,
): DefinitionValidationTranslationContext => ({
  correlationId,
  rootLocation: moduleValidationRoot(source),
  pathMap: moduleValidationPathMap(source),
});

const moduleValidationFailure = (
  error: DefinitionCompilationError,
  source: ModuleSourceDocument,
  correlationId: string,
): DefinitionValidationResult =>
  translateDefinitionRuleFailures(
    [
      {
        ruleCode: error.ruleCode,
        family: error.family,
        ...(error.location === undefined ? {} : { location: error.location }),
      } satisfies DefinitionRuleFailure,
    ],
    { correlationId, rootLocation: moduleValidationRoot(source) },
  );

const sameIdentifier = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const currentOwnedIdentity = (
  identities: SourceIdentityAssignments,
  definitionKey: string,
  kind: "query" | "record_type" | "field",
  scope: string,
  componentOwner: string,
  aliases: readonly string[],
): string | undefined => {
  const requestedAliases = [...new Set(aliases)];
  const found = requestedAliases.map((alias) => {
    const matches = identities.filter(
      (identity) =>
        identity.definitionKey === definitionKey &&
        identity.kind === kind &&
        identity.scope === scope &&
        identity.componentOwner === componentOwner &&
        identity.alias === alias,
    );
    return matches.length === 1 ? matches[0]!.identifier : undefined;
  });
  if (found.length === 0 || found.some((identifier) => identifier === undefined)) return undefined;
  const identifier = found[0];
  return identifier !== undefined && found.every((value) => value === identifier)
    ? identifier
    : undefined;
};

const conditionUsesOnlyCurrentOperands = (
  condition: ConditionNode | null,
  fields: readonly ModuleQueryFilterDraftContext["fields"][number][],
  parameters: readonly ModuleQueryFilterDraftContext["parameters"][number][],
): boolean => {
  if (condition === null) return true;
  const fieldIds = new Set(fields.map((entry) => entry.field.fieldId.toLowerCase()));
  const parameterKeys = new Set(parameters.map((entry) => entry.key));
  const visit = (node: ConditionNode): boolean => {
    if (node.kind === "not") return visit(node.condition);
    if (node.kind === "all" || node.kind === "any") return node.conditions.every(visit);
    if (node.kind !== "comparison") return false;
    const allowed = (operand: Extract<ConditionNode, { kind: "comparison" }> ["left"]): boolean =>
      operand.source === "value" ||
      (operand.source === "field" && fieldIds.has(operand.fieldId.toLowerCase())) ||
      (operand.source === "parameter" && parameterKeys.has(operand.key));
    return allowed(node.left) && (node.right === undefined || allowed(node.right));
  };
  return visit(condition);
};

type EligibleModuleQuery = Readonly<{
  choice: ModuleQueryFilterQueryChoice;
  context?: ModuleQueryFilterDraftContext;
  source: ModuleSourceQuery;
}>;

const moduleQueryChoices = (
  candidate: ValidatedDefinitionPublicationCandidate,
  resolution: DefinitionResolutionSnapshotV3,
  output: ModuleOutput,
): readonly EligibleModuleQuery[] => {
  if (candidate.draft.kind !== "module" || candidate.draft.source.kind !== "module")
    return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  const parsedModuleRootId = moduleRootIdSchema.safeParse(candidate.draft.rootId);
  if (!parsedModuleRootId.success) return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  const source = candidate.draft.source;
  const moduleOutput = output.canonical;
  return source.body.queries.map((query): EligibleModuleQuery => {
    const queryChoiceBase = {
      alias: query.id,
      key: query.key,
      ...(query.label === undefined ? {} : { label: query.label }),
    };
    const queryIdentity = currentOwnedIdentity(
      resolution.identities,
      source.key,
      "query",
      "content",
      query.id,
      [query.id, query.key],
    );
    const parsedQueryId = queryIdentity === undefined ? undefined : queryIdSchema.safeParse(queryIdentity);
    const compiledQueries = moduleOutput.content.queries.filter(
      (entry) => entry.key === query.key && parsedQueryId?.success === true && entry.queryId === parsedQueryId.data,
    );
    if (parsedQueryId?.success !== true || compiledQueries.length !== 1)
      return { source: query, choice: { ...queryChoiceBase, eligible: false, reason: "query_target_unsupported" } };
    if (query.record_type.includes(":"))
      return { source: query, choice: { ...queryChoiceBase, eligible: false, reason: "query_target_unsupported" } };
    const records = source.body.record_types.filter((record) => record.key === query.record_type);
    const compiledQuery = compiledQueries[0]!;
    if (
      records.length !== 1 ||
      compiledQuery.recordType.state !== "resolved" ||
      !sameIdentifier(compiledQuery.recordType.moduleRootId, parsedModuleRootId.data)
    )
      return { source: query, choice: { ...queryChoiceBase, eligible: false, reason: "query_target_unsupported" } };
    const record = records[0]!;
    const recordIdentity = currentOwnedIdentity(
      resolution.identities,
      source.key,
      "record_type",
      "content",
      record.id,
      [record.id, record.key],
    );
    const parsedRecordTypeId = recordIdentity === undefined ? undefined : recordTypeIdSchema.safeParse(recordIdentity);
    const compiledRecords = moduleOutput.content.recordTypes.filter(
      (entry) => parsedRecordTypeId?.success === true && entry.recordTypeId === parsedRecordTypeId.data,
    );
    if (
      parsedRecordTypeId?.success !== true ||
      compiledRecords.length !== 1 ||
      compiledQuery.recordType.recordTypeId !== parsedRecordTypeId.data
    )
      return { source: query, choice: { ...queryChoiceBase, eligible: false, reason: "query_target_unsupported" } };

    const fields: ModuleQueryFilterDraftContext["fields"][number][] = [];
    const compiledRecord = compiledRecords[0]!;
    for (const sourceField of record.fields) {
      const identity = currentOwnedIdentity(
        resolution.identities,
        source.key,
        "field",
        `record:${record.key}`,
        sourceField.id,
        [sourceField.id, sourceField.key],
      );
      const parsedFieldId = identity === undefined ? undefined : fieldIdSchema.safeParse(identity);
      const compiledFields = compiledRecord.fields.filter(
        (field) => parsedFieldId?.success === true && field.fieldId === parsedFieldId.data,
      );
      const field = compiledFields[0];
      if (parsedFieldId?.success !== true || compiledFields.length !== 1 || field === undefined) continue;
      if (!moduleQueryFieldTypes.has(field.type) || !field.filterable) continue;
      fields.push({ sourceAlias: sourceField.id, sourceKey: sourceField.key, field });
    }
    const parameters = query.inputs.flatMap((input) =>
      isModuleQueryFilterParameterType(input.type)
        ? [{ key: input.key, type: input.type }]
        : [],
    );
    const parameterKeys = parameters.map((input) => input.key);
    if (
      fields.length === 0 ||
      parameters.length !== query.inputs.length ||
      new Set(parameterKeys).size !== parameterKeys.length
    )
      return { source: query, choice: { ...queryChoiceBase, eligible: false, reason: "operand_context_unsupported" } };

    let filter: ConditionNode | null = null;
    if (compiledQuery.filter !== undefined && compiledQuery.filter !== null) {
      const filterParsed = conditionNodeSchema.safeParse(compiledQuery.filter);
      if (!filterParsed.success)
        return { source: query, choice: { ...queryChoiceBase, eligible: false, reason: "retained_filter_unsupported" } };
      filter = filterParsed.data;
    }
    if (!conditionUsesOnlyCurrentOperands(filter, fields, parameters))
      return { source: query, choice: { ...queryChoiceBase, eligible: false, reason: "retained_filter_unsupported" } };
    const operandBinding = {
      organizationId: candidate.draft.organizationId,
      rootId: parsedModuleRootId.data,
      definitionKey: source.key,
      draftRevision: candidate.draft.draftRevision,
      savedSourceFingerprint: candidate.draft.sourceFingerprint,
      resolutionFingerprint: output.resolutionFingerprint,
      query: {
        alias: query.id,
        key: query.key,
        queryId: parsedQueryId.data,
        recordAlias: record.id,
        recordKey: record.key,
        recordTypeId: parsedRecordTypeId.data,
      },
      fields,
      parameters,
    };
    const operandBindingFingerprint = fingerprintModuleQueryFilterOperandBinding(operandBinding);
    const context: ModuleQueryFilterDraftContext = {
      organizationId: operandBinding.organizationId,
      rootId: operandBinding.rootId,
      definitionKey: operandBinding.definitionKey,
      draftRevision: operandBinding.draftRevision,
      savedSourceFingerprint: operandBinding.savedSourceFingerprint,
      resolutionFingerprint: operandBinding.resolutionFingerprint,
      operandBindingFingerprint,
      query: operandBinding.query,
      fields: operandBinding.fields,
      parameters: operandBinding.parameters,
      filter,
    };
    return { source: query, context, choice: { ...queryChoiceBase, eligible: true } };
  });
};

const definitionModuleReferenceFailures = (
  request: z.output<typeof moduleCompilationRequestV3Schema>,
  output: ModuleOutput,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
): readonly DefinitionRuleFailure[] => {
  const rule = definitionSemanticRules.find(
    (entry) => entry.ruleId === "vortex.definition.module_references",
  );
  if (rule === undefined) return refuse("DEFINITION_COMPILATION_REFUSED");
  return rule.run({ requests: [request], outputs: [output], dependencyOutputs });
};

type CurrentModuleQueryFilterState = Readonly<{
  candidate: ValidatedDefinitionPublicationCandidate;
  dependencies: ResolvedDependencies;
  resolution: DefinitionResolutionSnapshotV3;
  compiled: CompiledModuleCandidate;
  eligibleQueries: readonly EligibleModuleQuery[];
}>;

const moduleValidationFromFailures = (
  failures: readonly DefinitionRuleFailure[],
  source: ModuleSourceDocument,
  correlationId: string,
): DefinitionValidationResult =>
  translateDefinitionRuleFailures(failures, {
    correlationId,
    rootLocation: moduleValidationRoot(source),
  });

const compileCurrentModuleQueryFilterState = async (
  context: SessionContext,
  reader: DefinitionPublicationReader,
  catalogue: DefinitionPublicationCatalogue,
  command: Readonly<{
    rootId: PlatformId;
    expectedDraftRevision: Revision;
    expectedSavedSourceFingerprint: Fingerprint;
  }>,
): Promise<
  | Readonly<{ kind: "available"; state: CurrentModuleQueryFilterState }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
> => {
  const candidate = validateCandidate(
    context,
    await reader.readCandidate(command.rootId),
    { rootId: command.rootId, expectedDraftRevision: command.expectedDraftRevision },
  );
  if (candidate.draft.kind !== "module" || candidate.draft.source.kind !== "module")
    refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  if (candidate.draft.sourceFingerprint !== command.expectedSavedSourceFingerprint)
    refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  const source = moduleSourceDocumentSchema.safeParse(candidate.draft.source);
  if (!source.success)
    return {
      kind: "validation_failed",
      validation: translateDefinitionSchemaError(
        source.error,
        moduleValidationTranslationContext(candidate.draft.source, context.correlationId),
      ),
    };
  const shapeValidation = validateDefinitionSource(source.data);
  if (!shapeValidation.valid)
    return {
      kind: "validation_failed",
      validation: moduleValidationFromFailures(
        shapeValidation.failures,
        source.data,
        context.correlationId,
      ),
    };
  try {
    const dependencies = await resolveDependencies(reader, catalogue, candidate);
    await assertNoCycle(reader, candidate, dependencies.modules);
    const ownVersion = candidate.historyEvidence.latestRelease?.publication.releaseVersion ?? "1.0.0";
    const resolution = buildResolution(candidate, dependencies, ownVersion);
    if (resolution.contractVersion !== "3.0.0") return refuse("DEFINITION_COMPILATION_REFUSED");
    const compiled = compileModuleCandidate(candidate, dependencies, resolution);
    const moduleReferenceFailures = definitionModuleReferenceFailures(
      compiled.request,
      compiled.output,
      compiled.dependencyOutputs,
    );
    if (moduleReferenceFailures.length > 0)
      return {
        kind: "validation_failed",
        validation: moduleValidationFromFailures(
          moduleReferenceFailures,
          source.data,
          context.correlationId,
        ),
      };
    return {
      kind: "available",
      state: {
        candidate,
        dependencies,
        resolution,
        compiled,
        eligibleQueries: moduleQueryChoices(candidate, resolution, compiled.output),
      },
    };
  } catch (error) {
    if (!(error instanceof DefinitionCompilationError)) throw error;
    return {
      kind: "validation_failed",
      validation: moduleValidationFailure(error, source.data, context.correlationId),
    };
  }
};

/**
 * Publication orchestration over private injected stores. Preparation exposes only safe JSON
 * evidence; every byte that matters is recomputed inside the publish transaction.
 *
 * Every operation is decided by the builder authority before any evidence is read, and only for
 * the authority's own organisation: a context for any other organisation is refused. Publication
 * preparation and publication need `definition_releases.manage`, and compiling a draft for preview
 * needs `definition_drafts.manage` (each with `system_applications.manage` for a system
 * application). The authority is a required argument, so the designer, the API and MCP all pass
 * the same server-side check and none can publish without it.
 */
export const createDefinitionPublicationService = (
  repository: DefinitionPublicationRepository,
  catalogue: DefinitionPublicationCatalogue,
  authority: BuilderAuthority,
) => ({
  readModuleQueryFilterDraft: async (
    context: SessionContext,
    input: unknown,
  ): Promise<ModuleQueryFilterDraftResult> => {
    const command = moduleQueryFilterReadCommandSchema.safeParse(input);
    if (!command.success) refuse("INVALID_DEFINITION_PUBLICATION_COMMAND");
    const parsed = command.data;
    await authorize(authority, context, { kind: "draft_change", rootId: parsed.rootId });
    return safely(async () =>
      repository.read(context, async (reader) => {
        const state = await compileCurrentModuleQueryFilterState(context, reader, catalogue, parsed);
        if (state.kind !== "available") return state;
        const queryChoices = state.state.eligibleQueries.map((entry) => entry.choice);
        if (parsed.queryAlias === undefined) return { kind: "available", queryChoices };
        const selected = state.state.eligibleQueries.filter(
          (entry) => entry.source.id === parsed.queryAlias,
        );
        if (selected.length !== 1)
          return { kind: "unsupported_context", reason: "query_target_unsupported" };
        const selectedContext = selected[0]!.context;
        return {
          kind: "available",
          queryChoices,
          ...(selectedContext === undefined ? {} : { selected: selectedContext }),
        };
      }),
    );
  },

  validateModuleQueryFilterDraft: async (
    context: SessionContext,
    input: unknown,
  ): Promise<ModuleQueryFilterValidationResult> => {
    const command = moduleQueryFilterValidationCommandSchema.safeParse(input);
    if (!command.success) refuse("INVALID_DEFINITION_PUBLICATION_COMMAND");
    const parsed = command.data;
    await authorize(authority, context, { kind: "draft_change", rootId: parsed.rootId });
    return safely(async () =>
      repository.read(context, async (reader) => {
        const state = await compileCurrentModuleQueryFilterState(context, reader, catalogue, parsed);
        if (state.kind !== "available") return state;
        const selected = state.state.eligibleQueries.filter(
          (entry) => entry.source.id === parsed.queryAlias,
        );
        if (selected.length !== 1)
          return { kind: "unsupported_context", reason: "query_target_unsupported" };
        const current = selected[0]!.context;
        if (current === undefined)
          return {
            kind: "unsupported_context",
            reason: selected[0]!.choice.reason ?? "operand_context_unsupported",
          };
        if (
          current.resolutionFingerprint !== parsed.expectedResolutionFingerprint ||
          current.operandBindingFingerprint !== parsed.expectedOperandBindingFingerprint
        )
          refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
        const draft = state.state.candidate.draft;
        if (draft.kind !== "module" || draft.source.kind !== "module")
          refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
        const sourceCandidate = structuredClone(draft.source);
        const sourceQueries = sourceCandidate.body.queries.filter(
          (query) => query.id === current.query.alias && query.key === current.query.key,
        );
        if (sourceQueries.length !== 1) refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
        sourceQueries[0]!.filter = parsed.filter;
        const source = moduleSourceDocumentSchema.safeParse(sourceCandidate);
        if (!source.success)
          return {
            kind: "validation_failed",
            validation: translateDefinitionSchemaError(
              source.error,
              moduleValidationTranslationContext(draft.source, context.correlationId),
            ),
          };
        const shapeValidation = validateDefinitionSource(source.data);
        if (!shapeValidation.valid)
          return {
            kind: "validation_failed",
            validation: moduleValidationFromFailures(
              shapeValidation.failures,
              source.data,
              context.correlationId,
            ),
          };
        const sourceFingerprint = fingerprintCanonicalValue(source.data);
        const candidate: ValidatedDefinitionPublicationCandidate = {
          ...state.state.candidate,
          draft: { ...draft, source: source.data, sourceFingerprint },
        };
        let resolution: DefinitionResolutionSnapshotV3;
        let compiled: CompiledModuleCandidate;
        try {
          const ownVersion = candidate.historyEvidence.latestRelease?.publication.releaseVersion ?? "1.0.0";
          const nextResolution = buildResolution(candidate, state.state.dependencies, ownVersion);
          if (nextResolution.contractVersion !== "3.0.0") return refuse("DEFINITION_COMPILATION_REFUSED");
          resolution = nextResolution;
          compiled = compileModuleCandidate(candidate, state.state.dependencies, resolution);
        } catch (error) {
          if (!(error instanceof DefinitionCompilationError)) throw error;
          return {
            kind: "validation_failed",
            validation: moduleValidationFailure(error, source.data, context.correlationId),
          };
        }
        const moduleReferenceFailures = definitionModuleReferenceFailures(
          compiled.request,
          compiled.output,
          compiled.dependencyOutputs,
        );
        if (moduleReferenceFailures.length > 0)
          return {
            kind: "validation_failed",
            validation: moduleValidationFromFailures(
              moduleReferenceFailures,
              source.data,
              context.correlationId,
            ),
          };
        const nextQueries = moduleQueryChoices(candidate, resolution, compiled.output);
        const nextMatches = nextQueries.filter((entry) => entry.source.id === parsed.queryAlias);
        if (nextMatches.length !== 1 || nextMatches[0]!.context === undefined)
          return {
            kind: "unsupported_context",
            reason: nextMatches[0]?.choice.reason ?? "query_target_unsupported",
          };
        const nextContext = nextMatches[0]!.context;
        if (nextContext.resolutionFingerprint !== current.resolutionFingerprint)
          refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
        const noChange =
          fingerprintCanonicalValue(nextContext.filter) === fingerprintCanonicalValue(current.filter);
        return {
          kind: "validated",
          source: noChange ? draft.source : source.data,
          sourceFingerprint: noChange ? draft.sourceFingerprint : sourceFingerprint,
          context: noChange ? current : nextContext,
          noChange,
        };
      }),
    );
  },

  prepare: async (
    context: SessionContext,
    input: unknown,
  ): Promise<PreparedDefinitionPublication> => {
    const command = prepareDefinitionPublicationCommandSchema.safeParse(input);
    if (!command.success) refuse("INVALID_DEFINITION_PUBLICATION_COMMAND");
    const parsedCommand = command.data as PrepareDefinitionPublicationCommand;
    await authorize(authority, context, { kind: "publication", rootId: parsedCommand.rootId });
    return safely(async () => {
      const state = await repository.read(context, async (reader) =>
        prepareFromReader(
          context,
          reader,
          catalogue,
          parsedCommand,
          await reader.readCandidate(parsedCommand.rootId),
        ),
      );
      return prepareDefinitionPublicationResultSchema.parse({
        confirmation: state.confirmation,
      });
    });
  },

  /**
   * Compiles the caller organisation's current Application draft at the expected revision through
   * the same candidate validation, exact dependency resolution and compilation as preparation. It
   * is a read for exact-draft preview (#597): it assigns no version, produces no confirmation and
   * writes nothing, and a draft identical to its current release still compiles.
   */
  compileApplicationDraft: async (
    context: SessionContext,
    input: unknown,
  ): Promise<ApplicationDraftCompilation> => {
    const command = prepareDefinitionPublicationCommandSchema.safeParse(input);
    if (!command.success) refuse("INVALID_DEFINITION_PUBLICATION_COMMAND");
    const parsedCommand = command.data as PrepareDefinitionPublicationCommand;
    await authorize(authority, context, { kind: "draft_change", rootId: parsedCommand.rootId });
    return safely(async () =>
      repository.read(context, async (reader) => {
        const candidate = validateCandidate(
          context,
          await reader.readCandidate(parsedCommand.rootId),
          parsedCommand,
        );
        // Another definition kind at this root is refused exactly like a missing draft.
        if (candidate.draft.kind !== "application" || candidate.draft.source.kind !== "application")
          refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
        const dependencies = await resolveDependencies(reader, catalogue, candidate);
        await assertNoCycle(reader, candidate, dependencies.modules);
        const currentVersion =
          candidate.historyEvidence.latestRelease?.publication.releaseVersion ?? "1.0.0";
        const resolution = buildResolution(candidate, dependencies, currentVersion);
        const compilation = compileCandidate(
          candidate,
          dependencies,
          resolution,
          false,
        );
        if (
          compilation.kind !== "application" ||
          compilation.platformCompatibilityVersion !== APPLICATION_PLATFORM_COMPATIBILITY_VERSION
        )
          return refuse("DEFINITION_COMPILATION_REFUSED");
        return {
          compilation,
          conditionContexts: projectDraftConditionContexts(candidate.draft.source,
            candidate.draft.sourceFingerprint, dependencies, resolution),
          currentReleaseRevision: candidate.draft.publishedRevision ?? null,
        };
      }),
    );
  },

  publish: async (context: SessionContext, input: unknown): Promise<PublishDefinitionResult> => {
    const command = publishDefinitionCommandSchema.safeParse(input);
    if (!command.success) refuse("INVALID_DEFINITION_PUBLICATION_COMMAND");
    const parsedCommand = command.data as PublishDefinitionCommand;
    await authorize(authority, context, {
      kind: "publication",
      rootId: parsedCommand.confirmation.rootId,
    });
    return safely(async () =>
      repository.transaction(context, async (transaction) => {
        const confirmation = parsedCommand.confirmation;
        const recomputed = await prepareFromReader(
          context,
          transaction,
          catalogue,
          {
            rootId: confirmation.rootId,
            expectedDraftRevision: confirmation.expectedDraftRevision,
          },
          await transaction.lockCandidate(confirmation.rootId),
          confirmation.dependencyManifest,
        );
        if (
          fingerprintCanonicalValue(recomputed.confirmation) !==
          fingerprintCanonicalValue(confirmation)
        )
          refuse("DEFINITION_CONFIRMATION_MISMATCH");
        if (
          recomputed.compilationOutput.kind === "application" &&
          recomputed.compilationOutput.platformCompatibilityVersion !==
            APPLICATION_PLATFORM_COMPATIBILITY_VERSION
        )
          refuse("DEFINITION_COMPILATION_REFUSED");
        const result = await transaction.appendRelease({
          draft: recomputed.draft,
          compilationOutput: recomputed.compilationOutput,
          assignedVersion: confirmation.assignedVersion,
          comparisonFingerprint: confirmation.comparisonFingerprint,
          reasons: confirmation.reasons,
          dependencyManifest: confirmation.dependencyManifest,
          resolutionSnapshot: recomputed.resolutionSnapshot,
          validationContractVersion: recomputed.draft.source.source_contract_version,
          releaseNote: parsedCommand.releaseNote,
        });
        const parsed = publishDefinitionResultSchema.safeParse(result);
        if (!parsed.success) refuse("DEFINITION_PUBLICATION_FAILED");
        const published = parsed.data as PublishDefinitionResult;
        if (
          published.rootId !== confirmation.rootId ||
          published.releaseRevision !== confirmation.expectedDraftRevision ||
          published.releaseVersion !== confirmation.assignedVersion ||
          published.contentFingerprint !== confirmation.contentFingerprint ||
          published.resolutionFingerprint !== confirmation.resolutionFingerprint ||
          published.comparisonFingerprint !== confirmation.comparisonFingerprint ||
          fingerprintCanonicalValue(published.dependencyManifest) !==
            fingerprintCanonicalValue(confirmation.dependencyManifest)
        )
          refuse("DEFINITION_PUBLICATION_FAILED");
        return published;
      }),
    );
  },
});
