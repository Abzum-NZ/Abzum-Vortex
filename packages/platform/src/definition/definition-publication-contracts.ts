import "server-only";

import type {
  DefinitionCompilationOutput,
  ApplicationCompilationOutput,
  DefinitionPublicationConfirmation,
  DefinitionPublicationHistoryEvidence,
  DefinitionResolutionSnapshot,
  ApplicationCompositionCatalogueSnapshot,
  BlockId,
  ExactDefinitionDependency,
  PrepareDefinitionPublicationResult,
  ModuleVersionImpactHistoryEntry,
  ModuleCompilationOutput,
  PublishDefinitionResult,
  SessionContext,
  ModuleSourceDocument,
  StoredDefinitionDraft,
  ConnectionTypeId,
  Fingerprint,
  ModuleRootId,
  OrganizationId,
  PlatformBlockRelease,
  PlatformId,
  PlatformThemeRelease,
  PlatformServiceOperationRelease,
  Revision,
  SemanticVersion,
} from "../schema";
import type { PlatformPermissionSource } from "../access/platform-permissions";
import type { SavedConditionLike } from "./saved-condition-revisions";
import { DefinitionError } from "./definition-error";
import type { ModuleExtensionPointUse } from "./module-extension-point-shape";

type SourceIdentityAssignments = DefinitionResolutionSnapshot["identities"];
export type ModuleOutput = Extract<DefinitionCompilationOutput, { kind: "module" }>;
type ConnectionOutput = Extract<DefinitionCompilationOutput, { kind: "connection_type" }>;
export type PublishableCompilationOutput = ApplicationCompilationOutput | ModuleCompilationOutput;
export type DefinitionResolution = DefinitionResolutionSnapshot;

export type DefinitionPublicationFailureCode =
  | "INVALID_DEFINITION_PUBLICATION_COMMAND"
  | "DEFINITION_DRAFT_STALE_OR_MISSING"
  | "DEFINITION_IDENTITY_RETIRED"
  | "DEFINITION_ORGANIZATION_MISMATCH"
  | "DEFINITION_PUBLICATION_AUTHORITY_UNAVAILABLE"
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

export function refuse(code: DefinitionPublicationFailureCode): never {
  throw new DefinitionError(code);
}

/** Read model needed to compile one current draft. Implementations must tenant-scope every method. */
export type DefinitionCandidateDraft = Readonly<{
  draft: StoredDefinitionDraft;
  identities: SourceIdentityAssignments;
}>;

/**
 * What compiling a draft for the builder needs: the draft, its identities and the version of its
 * current release, which the compile names as its own version. Unlike publication it does not
 * read or verify the published release itself.
 */
export type DefinitionDraftCandidate = DefinitionCandidateDraft &
  Readonly<{ currentReleaseVersion: SemanticVersion | null }>;

/**
 * Repositories return the latest release, which the database anchors as current, and for a
 * Module each saved condition's most recent published form (empty for an Application).
 */
export type DefinitionPublicationCandidate = DefinitionCandidateDraft &
  Readonly<{
    historyEvidence: DefinitionPublicationHistoryEvidence;
    savedConditionHistory: readonly SavedConditionLike[];
  }>;

/** Immutable organization-owned module release made available to a dependency compilation. */
export type ResolvableModuleRelease = Readonly<{
  organizationId: OrganizationId;
  key: string;
  rootId: ModuleRootId;
  releaseRevision: Revision;
  releaseVersion: SemanticVersion;
  contentFingerprint: Fingerprint;
  resolutionFingerprint: Fingerprint;
  sourceFingerprint: Fingerprint;
  published: ModuleVersionImpactHistoryEntry;
  compilationOutput: ModuleOutput;
  resolutionSnapshot: DefinitionResolutionSnapshot;
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
  compilationOutput: ConnectionOutput;
}>;

export interface DefinitionPublicationReader {
  readCandidate(rootId: string): Promise<DefinitionPublicationCandidate | undefined>;
  /** The internal Module roots one Application owns. */
  readOwnedModuleRoots(applicationRootId: string): Promise<readonly OwnedModuleRoot[]>;
  /** Published record and field keys, without materialising the owned Module releases. */
  readOwnedModulePublication(applicationRootId: string): Promise<
    Readonly<{
      recordTypes: readonly string[];
      fields: readonly string[];
      extensionPointUses: readonly ModuleExtensionPointUse[];
    }>
  >;
  /** The draft, its identities and its current release version, without the release itself. */
  readDraftCandidate(rootId: string): Promise<DefinitionDraftCandidate | undefined>;
  /** Rechecks a retained Application draft's revision, source and publication anchor only. */
  isApplicationDraftCurrent(candidate: DefinitionDraftCandidate): Promise<boolean>;
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
  /** Reads several exact releases in one call; the result lines up with the locators. */
  readModuleReleases(
    organizationId: OrganizationId,
    locators: readonly Readonly<{ rootId: ModuleRootId; releaseRevision: Revision }>[],
  ): Promise<readonly (ResolvableModuleRelease | undefined)[]>;
}

export interface DefinitionPublicationCatalogue {
  /** The shipped platform permission catalogue publication rules resolve platform keys against. */
  readonly permissions: PlatformPermissionSource;
  listConnectionTypeReleases(key: string): Promise<readonly ResolvableConnectionTypeRelease[]>;
  readConnectionTypeRelease(
    rootId: ConnectionTypeId,
    releaseVersion: string,
  ): Promise<ResolvableConnectionTypeRelease | undefined>;
  readPlatformBlockRelease(
    blockId: BlockId,
    releaseVersion: string,
  ): Promise<PlatformBlockRelease | undefined>;
  readPlatformThemeRelease(
    catalogueThemeId: PlatformId,
    releaseVersion: string,
  ): Promise<PlatformThemeRelease | undefined>;
  readApplicationCompositionCatalogueSnapshot(
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
  ): Promise<ApplicationCompositionCatalogueSnapshot | undefined>;
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
  reasons: DefinitionPublicationConfirmation["reasons"];
  dependencyManifest: readonly ExactDefinitionDependency[];
  resolutionSnapshot: DefinitionResolution;
  validationContractVersion: "3.0.0";
  releaseNote: string;
}>;

/** One internal Module root an Application owns, with its draft and current release revisions. */
export type OwnedModuleRoot = Readonly<{
  rootId: ModuleRootId;
  key: string;
  draftRevision: Revision;
  currentReleaseRevision: Revision | null;
  sourceFingerprint: Fingerprint;
}>;

export interface DefinitionPublicationTransaction extends DefinitionPublicationReader {
  /** Re-reads immediately before compilation; appendRelease owns the atomic row lock/check. */
  lockCandidate(rootId: string): Promise<DefinitionPublicationCandidate | undefined>;
  /** Creates the internal root of one of an Application's inline Modules, owned by it. */
  createOwnedModuleRoot(
    applicationRootId: string,
    source: ModuleSourceDocument,
  ): Promise<OwnedModuleRoot>;
  /** Stages the current lowering of an inline Module in its internal root, for this publication. */
  stageOwnedModuleSource(
    root: OwnedModuleRoot,
    source: ModuleSourceDocument,
  ): Promise<OwnedModuleRoot>;
  /** Appends one internal Module release inside its owning Application's publication. */
  appendModuleRelease(release: DefinitionReleaseAppend): Promise<PublishDefinitionResult>;
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

export type PreparedState = Readonly<{
  confirmation: DefinitionPublicationConfirmation;
  draft: StoredDefinitionDraft;
  compilationOutput: PublishableCompilationOutput;
  resolutionSnapshot: DefinitionResolution;
}>;

export type PreparedDefinitionPublication = PrepareDefinitionPublicationResult;
