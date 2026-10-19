import "server-only";

import { planApplicationPreview } from "./preview-release-plan";
import { componentLabelsOf } from "./publication-component-labels";

import {
  prepareDefinitionPublicationCommandSchema,
  prepareDefinitionPublicationResultSchema,
  publishDefinitionCommandSchema,
  publishDefinitionResultSchema,
  recordTypeIdSchema,
  fieldIdSchema,
  type ApplicationCompilationOutput,
  type ApplicationSourceDocument,
  type PrepareDefinitionPublicationCommand,
  type PublishDefinitionCommand,
  type PublishDefinitionResult,
  type SessionContext,
  type ModuleField,
  type Fingerprint,
  type Revision,
} from "../schema";
import { applicationModuleKeys } from "./application-module-sources";
import { peopleDirectory, type PeopleDirectoryOwner } from "./module-links";
import { selectCurrentModuleRelease } from "./definition-dependency-resolution";
import { DefinitionError } from "./definition-error";
import { applicationModuleSources } from "./application-module-lowering";
import { createDraftModuleOverlay } from "./publication/draft-module-overlay";
import { APPLICATION_PLATFORM_COMPATIBILITY_VERSION } from "./platform-compatibility";
import {
  requireBuilderAuthority,
  type BuilderAuthority,
  type BuilderOperation,
} from "./builder-authority";
import { fingerprintCanonicalValue } from "./canonical-json-definition";
import {
  applicationDraftCompilationKey,
  readCachedApplicationDraftCompilation,
  retainApplicationDraftCompilation,
} from "./application-draft-compilation-cache";
import {
  type DefinitionResolution,
  refuse,
  type ResolvableModuleRelease,
  type DefinitionPublicationCatalogue,
  type DefinitionPublicationRepository,
  type PreparedDefinitionPublication,
  type DefinitionDraftCandidate,
  type DefinitionPublicationCandidate,
  type DefinitionPublicationTransaction,
} from "./definition-publication-contracts";
import type { ResolvedDependencies } from "./definition-dependency-resolution";
import { validateDraftCandidate } from "./definition-publication-compilation";
import {
  applicationCandidate,
  materializeInlineModules,
  releasedUnchangedModules,
  compileApplicationWithInlineModules,
  planApplicationPublication,
  latestReleaseVersion,
  stagedOwnedModuleRoots,
  type ApplicationReleasePlan,
} from "./application-publication";

/** A preparation labels its in-memory Module plans with this note. */
const preparationReleaseNote = "Planned by publication preparation";

export type ApplicationDraftCompilation = Readonly<{
  compilation: ApplicationCompilationOutput;
  /**
   * The one compile of this revision as a release plan: the Application with its request and
   * dependency outputs, and each inline Module release. Preview planning releases exactly this.
   */
  releasePlan: ApplicationReleasePlan;
  /** The exact Module releases the draft compiled against, its own inline Modules held in memory. */
  moduleReleases: readonly ResolvableModuleRelease[];
  conditionContexts: readonly ApplicationDraftConditionContext[];
  /** The root's current published release revision; preview only labels it and never reads it. */
  currentReleaseRevision: Revision | null;
  /**
   * The organisation's people directory, which a Person link points at: the Application that owns
   * it and the label people are shown by. Null when the organisation has no released directory.
   */
  peopleDirectory: PeopleDirectoryOwner | null;
}>;

/** The record types (`module:record`) and fields (`module:record.field`) the draft's own Modules have published. */
export type ApplicationDraftPublication = Readonly<{
  recordTypes: readonly string[];
  fields: readonly string[];
}>;

/** The owner and person title of a release of the people directory Module. */
const peopleDirectoryOwnerOf = (release: ResolvableModuleRelease): PeopleDirectoryOwner | null => {
  const content = release.compilationOutput.canonical.content;
  const personKey = peopleDirectory.recordType.slice(
    peopleDirectory.recordType.lastIndexOf(":") + 1,
  );
  const person = content.recordTypes.find((record) => record.key === personKey);
  const title = person?.fields.find(
    (field) => String(field.fieldId) === String(person.titleFieldId),
  );
  if (title === undefined) {
    console.error(
      "[definition] the people directory release has no person title field: PEOPLE_DIRECTORY_UNREADABLE",
    );
    return null;
  }
  return { application: content.ownerApplication, titleLabel: title.label };
};

/** Authoring metadata from the very same verified dependency resolution as compilation. */
export type ApplicationDraftConditionContext = Readonly<{
  sourceFingerprint: Fingerprint;
  bindingsSignature: string;
  pageAlias: string;
  recordReference: string;
  fieldRecordReference: string;
  recordTypeId: string;
  module: Readonly<
    Pick<
      ResolvableModuleRelease,
      | "organizationId"
      | "key"
      | "rootId"
      | "releaseRevision"
      | "releaseVersion"
      | "contentFingerprint"
      | "resolutionFingerprint"
    >
  >;
  fields: readonly Readonly<{
    field: ModuleField;
    aliases: readonly string[];
    preferredAlias: string;
    componentOwner: string;
  }>[];
}>;

const conditionFieldTypes = new Set([
  "text",
  "long_text",
  "whole_number",
  "yes_no",
  "date",
  "date_time",
]);

const projectDraftConditionContexts = (
  source: ApplicationSourceDocument,
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
    const identities = resolution.identities.filter(
      (identity) => identity.definitionKey === moduleKey,
    );
    const records = identities.filter(
      (identity) =>
        identity.kind === "record_type" &&
        identity.scope === "content" &&
        identity.alias === recordAlias,
    );
    const release = releases[0];
    const recordIdentity = records[0];
    if (
      releases.length !== 1 ||
      records.length !== 1 ||
      release === undefined ||
      recordIdentity === undefined
    )
      continue;
    const recordIdentifier = recordTypeIdSchema.safeParse(recordIdentity.identifier);
    if (!recordIdentifier.success) continue;
    const canonicalRecords = release.compilationOutput.canonical.content.recordTypes.filter(
      (record) => record.recordTypeId === recordIdentifier.data,
    );
    const record = canonicalRecords[0];
    if (canonicalRecords.length !== 1 || record === undefined) continue;
    const recordAliases = identities.filter(
      (identity) =>
        identity.kind === "record_type" &&
        identity.scope === "content" &&
        identity.identifier === recordIdentity.identifier,
    );
    if (
      !recordAliases.some((identity) => identity.alias === record.key) ||
      recordAliases.some((identity) => identity.componentOwner !== recordIdentity.componentOwner)
    )
      continue;
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
      if (
        owners.size !== 1 ||
        aliases.length === 0 ||
        new Set(aliases).size !== aliases.length ||
        !aliases.includes(field.key) ||
        group.some((entry) =>
          identities.some(
            (other) =>
              other.kind === "field" &&
              other.scope === entry.scope &&
              other.alias === entry.alias &&
              (other.identifier !== entry.identifier ||
                other.componentOwner !== entry.componentOwner),
          ),
        ) ||
        group.some((entry) =>
          identities.some(
            (other) =>
              other.kind === "field" &&
              other.scope === entry.scope &&
              other.componentOwner === entry.componentOwner &&
              other.identifier !== entry.identifier,
          ),
        )
      ) {
        valid = false;
        break;
      }
      fields.push({
        field,
        aliases,
        preferredAlias: field.key,
        componentOwner: group[0]!.componentOwner,
      });
    }
    if (!valid) continue;
    contexts.push({
      sourceFingerprint,
      bindingsSignature: JSON.stringify(applicationModuleKeys(source)),
      pageAlias: page.id,
      recordReference: page.record_type,
      fieldRecordReference: `${moduleKey}:${record.key}`,
      recordTypeId: record.recordTypeId,
      module: {
        organizationId: release.organizationId,
        key: release.key,
        rootId: release.rootId,
        releaseRevision: release.releaseRevision,
        releaseVersion: release.releaseVersion,
        contentFingerprint: release.contentFingerprint,
        resolutionFingerprint: release.resolutionFingerprint,
      },
      fields,
    });
  }
  return contexts;
};

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

/**
 * The one compile of a saved Application revision, shared by the builder's canvas, the preview
 * plan and its retention. It is a pure function of the draft and the stored definitions it reads:
 * its own inline Modules' roots as staging leaves them and the current release of every Module it
 * uses. The same draft revision over the same of those is compiled once, whichever of the builder
 * or preview planning asks first; authorisation and the candidate validation run on every call.
 */
const compileDraftSnapshot = async (
  context: SessionContext,
  overlay: DefinitionPublicationTransaction,
  catalogue: DefinitionPublicationCatalogue,
  candidate: DefinitionDraftCandidate | DefinitionPublicationCandidate,
): Promise<ApplicationDraftCompilation> => {
  const source = candidate.draft.source;
  if (source.kind !== "application") return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  const inlineKeys = new Set(applicationModuleSources(source).map((module) => module.key));
  const ownedRoots = await overlay.readOwnedModuleRoots(String(candidate.draft.rootId));
  const usedKeys = applicationModuleKeys(source).filter((key) => !inlineKeys.has(key));
  const needsDirectory = !applicationModuleKeys(source).includes(peopleDirectory.module);
  const pages = await Promise.all(
    [...usedKeys, ...(needsDirectory ? [peopleDirectory.module] : [])].map((moduleKey) =>
      overlay.readModuleReleasePage(candidate.draft.organizationId, moduleKey),
    ),
  );
  const usedAnchors = usedKeys.map((moduleKey, index) => [
    moduleKey,
    pages[index]!.rootId,
    pages[index]!.anchorReleaseRevision,
  ]);
  // An unused directory's release still supplies the Person-link choice.
  const directoryPage = needsDirectory ? pages[usedKeys.length] : undefined;
  const cacheKey = applicationDraftCompilationKey([
    candidate.draft.organizationId.toLowerCase(),
    candidate.draft.rootId.toLowerCase(),
    candidate.draft.draftRevision,
    candidate.draft.sourceFingerprint,
    candidate.draft.publishedRevision ?? null,
    latestReleaseVersion(candidate),
    stagedOwnedModuleRoots(candidate, ownedRoots),
    usedAnchors,
    directoryPage === undefined
      ? null
      : [directoryPage.rootId, directoryPage.anchorReleaseRevision],
  ]);
  const cached = readCachedApplicationDraftCompilation(cacheKey);
  if (cached !== undefined) return cached;
  // The draft's own inline Modules are compiled from the draft, in memory, by the
  // publication's own steps; nothing is written.
  const compiled = await compileApplicationWithInlineModules(
    context,
    overlay,
    catalogue,
    candidate,
  );
  const compilation = compiled.output;
  if (
    compilation.kind !== "application" ||
    compilation.platformCompatibilityVersion !== APPLICATION_PLATFORM_COMPATIBILITY_VERSION
  )
    return refuse("DEFINITION_COMPILATION_REFUSED");
  let directory = compiled.dependencies.modules.find(
    (release) => release.key === peopleDirectory.module,
  );
  if (directory === undefined && directoryPage !== undefined && directoryPage.rootId !== null) {
    try {
      directory = await selectCurrentModuleRelease(overlay, candidate, peopleDirectory.module);
    } catch (error) {
      if (!(error instanceof DefinitionError)) throw error;
      console.error(`[definition] the people directory release could not be read: ${error.code}`);
    }
  }
  return retainApplicationDraftCompilation(cacheKey, {
    compilation,
    releasePlan: compiled,
    moduleReleases: compiled.dependencies.modules,
    conditionContexts: projectDraftConditionContexts(
      source,
      candidate.draft.sourceFingerprint,
      compiled.dependencies,
      compiled.resolution,
    ),
    currentReleaseRevision: candidate.draft.publishedRevision ?? null,
    peopleDirectory: directory === undefined ? null : peopleDirectoryOwnerOf(directory),
  });
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
  prepare: async (
    context: SessionContext,
    input: unknown,
  ): Promise<PreparedDefinitionPublication> => {
    const command = prepareDefinitionPublicationCommandSchema.safeParse(input);
    if (!command.success) refuse("INVALID_DEFINITION_PUBLICATION_COMMAND");
    const parsedCommand = command.data as PrepareDefinitionPublicationCommand;
    await authorize(authority, context, { kind: "publication", rootId: parsedCommand.rootId });
    // Permanent inline identities are established before planning; release rows stay in memory.
    return repository.transaction(context, async (transaction) => {
      const candidate = applicationCandidate(
        context,
        await transaction.lockCandidate(parsedCommand.rootId),
        parsedCommand,
      );
      const ownedRoots = await transaction.readOwnedModuleRoots(String(candidate.draft.rootId));
      const roots = await materializeInlineModules(transaction, candidate, ownedRoots);
      // Publication labels also need fields removed from the current candidate.
      const previousModules = await transaction.readModuleReleases(
        context.organizationId,
        (candidate.historyEvidence.latestRelease?.dependencyManifest ?? [])
          .filter((dependency) => dependency.kind === "module")
          .map((dependency) => ({
            rootId: dependency.rootId,
            releaseRevision: dependency.revision,
          })),
      );
      if (previousModules.some((release) => release === undefined))
        refuse("DEFINITION_DEPENDENCY_MISSING");
      const state = await planApplicationPublication(
        context,
        transaction,
        catalogue,
        candidate,
        roots,
        preparationReleaseNote,
      );
      const inlineRootIds = new Set(
        state.moduleOutputs.map((output) => String(output.canonical.envelope.rootId)),
      );
      const usedModules = await transaction.readModuleReleases(
        context.organizationId,
        state.confirmation.dependencyManifest
          .filter(
            (dependency) =>
              dependency.kind === "module" && !inlineRootIds.has(String(dependency.rootId)),
          )
          .map((dependency) => {
            if (dependency.kind !== "module") return refuse("DEFINITION_DEPENDENCY_MISSING");
            return { rootId: dependency.rootId, releaseRevision: dependency.releaseRevision };
          }),
      );
      if (usedModules.some((release) => release === undefined))
        refuse("DEFINITION_DEPENDENCY_MISSING");
      return prepareDefinitionPublicationResultSchema.parse({
        confirmation: state.confirmation,
        componentLabels: await componentLabelsOf(
          (blockId, releaseVersion) => catalogue.readPlatformBlockRelease(blockId, releaseVersion),
          state.compilationOutput.canonical,
          ...state.moduleOutputs.map((output) => output.canonical),
          ...usedModules.map((release) => release!.compilationOutput.canonical),
          candidate.historyEvidence.latestRelease?.content,
          ...previousModules.map((release) => release!.compilationOutput.canonical),
        ),
      });
    });
  },

  /**
   * Compiles the caller organisation's current Application draft at the expected revision through
   * the same candidate validation, exact dependency resolution and compilation as preparation. It
   * is a read for exact-draft preview: it assigns no version, produces no confirmation and
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
    return repository.read(context, async (reader) => {
      // The draft and its current release's version; the published release itself is read and
      // verified by preparation and publication, which judge the draft against it.
      const candidate = validateDraftCandidate(
        context,
        await reader.readDraftCandidate(parsedCommand.rootId),
        parsedCommand,
      );
      // Another definition kind at this root is refused exactly like a missing draft.
      if (candidate.draft.kind !== "application" || candidate.draft.source.kind !== "application")
        refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
      return compileDraftSnapshot(
        context,
        createDraftModuleOverlay(reader, context, candidate.draft),
        catalogue,
        candidate,
      );
    });
  },

  /** Published field facts and compilation share one request-scoped definition snapshot. */
  readApplicationDraftSnapshot: async (
    context: SessionContext,
    input: unknown,
    resources: Readonly<{ publication: boolean }>,
  ) => {
    const command = prepareDefinitionPublicationCommandSchema.safeParse(input);
    if (!command.success) return refuse("INVALID_DEFINITION_PUBLICATION_COMMAND");
    await authorize(authority, context, { kind: "draft_change", rootId: command.data.rootId });
    return repository.read(context, async (reader) => {
      const candidate = validateDraftCandidate(
        context,
        await reader.readDraftCandidate(command.data.rootId),
        command.data,
      );
      if (candidate.draft.kind !== "application" || candidate.draft.source.kind !== "application")
        return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
      const overlay = createDraftModuleOverlay(reader, context, candidate.draft);
      const publication: ApplicationDraftPublication | null = resources.publication
        ? await overlay.readOwnedModulePublication(String(candidate.draft.rootId))
        : null;
      try {
        return {
          publication,
          compilation: await compileDraftSnapshot(context, overlay, catalogue, candidate),
          failure: undefined,
        };
      } catch (failure) {
        return { publication, compilation: null, failure };
      }
    });
  },

  /** Establish permanent inline identities in a short authorised write phase. */
  prepareApplicationPreview: async (context: SessionContext, input: unknown): Promise<void> => {
    const command = prepareDefinitionPublicationCommandSchema.safeParse(input);
    if (!command.success) return refuse("INVALID_DEFINITION_PUBLICATION_COMMAND");
    await authorize(authority, context, { kind: "publication", rootId: command.data.rootId });
    await repository.transaction(context, async (transaction) => {
      const candidate = validateDraftCandidate(
        context,
        await transaction.readDraftCandidate(command.data.rootId),
        command.data,
      );
      if (candidate.draft.kind !== "application" || candidate.draft.source.kind !== "application")
        return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
      if (candidate.draft.publishedRevision === candidate.draft.draftRevision) return;
      const ownedRoots = await transaction.readOwnedModuleRoots(String(candidate.draft.rootId));
      const unchanged = await releasedUnchangedModules(transaction, candidate, ownedRoots);
      await materializeInlineModules(transaction, candidate, ownedRoots, unchanged);
    });
  },

  planApplicationPreview: async (context: SessionContext, input: unknown) => {
    const command = prepareDefinitionPublicationCommandSchema.safeParse(input);
    if (!command.success) return refuse("INVALID_DEFINITION_PUBLICATION_COMMAND");
    await authorize(authority, context, { kind: "publication", rootId: command.data.rootId });
    return repository.read(context, async (reader) => {
      const candidate = applicationCandidate(
        context,
        await reader.readCandidate(command.data.rootId),
        command.data,
      );
      const overlay = createDraftModuleOverlay(reader, context, candidate.draft);
      // The revision the builder already compiled is released as it was compiled.
      return planApplicationPreview(
        context,
        overlay,
        candidate,
        catalogue.permissions,
        async () =>
          (await compileDraftSnapshot(context, overlay, catalogue, candidate)).releasePlan,
      );
    });
  },

  publish: async (context: SessionContext, input: unknown): Promise<PublishDefinitionResult> => {
    const command = publishDefinitionCommandSchema.safeParse(input);
    if (!command.success) refuse("INVALID_DEFINITION_PUBLICATION_COMMAND");
    const parsedCommand = command.data as PublishDefinitionCommand;
    await authorize(authority, context, {
      kind: "publication",
      rootId: parsedCommand.confirmation.rootId,
    });
    return repository.transaction(context, async (transaction) => {
      const confirmation = parsedCommand.confirmation;
      const candidate = applicationCandidate(
        context,
        await transaction.lockCandidate(confirmation.rootId),
        { rootId: confirmation.rootId, expectedDraftRevision: confirmation.expectedDraftRevision },
      );
      const ownedRoots = await transaction.readOwnedModuleRoots(String(candidate.draft.rootId));
      const roots = await materializeInlineModules(transaction, candidate, ownedRoots);
      // The inline Modules that changed are released here, before the Application, which is last.
      const recomputed = await planApplicationPublication(
        context,
        transaction,
        catalogue,
        candidate,
        roots,
        parsedCommand.releaseNote,
        confirmation.dependencyManifest,
      );
      if (
        fingerprintCanonicalValue(recomputed.confirmation) !==
        fingerprintCanonicalValue(confirmation)
      )
        refuse("DEFINITION_CONFIRMATION_MISMATCH");
      if (
        recomputed.compilationOutput.kind !== "application" ||
        recomputed.compilationOutput.platformCompatibilityVersion !==
          APPLICATION_PLATFORM_COMPATIBILITY_VERSION
      )
        refuse("DEFINITION_COMPILATION_REFUSED");
      for (const release of recomputed.moduleReleases)
        await transaction.appendModuleRelease(release);
      const result = await transaction.appendRelease({
        draft: recomputed.draft,
        compilationOutput: recomputed.compilationOutput,
        assignedVersion: confirmation.assignedVersion,
        reasons: confirmation.reasons,
        dependencyManifest: confirmation.dependencyManifest,
        resolutionSnapshot: recomputed.resolutionSnapshot,
        validationContractVersion: recomputed.compilationOutput.validationContractVersion,
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
        fingerprintCanonicalValue(published.dependencyManifest) !==
          fingerprintCanonicalValue(confirmation.dependencyManifest)
      )
        refuse("DEFINITION_PUBLICATION_FAILED");
      return published;
    });
  },
});
