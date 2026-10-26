import "server-only";
import type { ModuleExtensionPointUse } from "./module-extension-point-shape";

import { planApplicationPreview } from "./preview-release-plan";
import { componentLabelsOf } from "./publication-component-labels";

import type { SessionContext } from "../access/identity-access";
import {
  recordTypeIdSchema,
  fieldIdSchema,
  type Fingerprint,
  type Revision,
} from "../catalogue/identifiers";
import type {
  ApplicationCompilationOutput,
  DefinitionPublicationHistoryEvidence,
} from "./definition-compilation-contracts";
import type { ApplicationSourceDocument } from "./definition-source";
import {
  prepareDefinitionPublicationCommandSchema,
  prepareDefinitionPublicationResultSchema,
  publishDefinitionCommandSchema,
  publishDefinitionResultSchema,
  type PrepareDefinitionPublicationCommand,
  type PublishDefinitionCommand,
  type PublishDefinitionResult,
} from "./definition-store-contracts";
import type { ModuleField } from "./module-contracts";
import { applicationModuleKeys } from "./application-module-sources";
import { peopleDirectory, type PeopleDirectoryOwner } from "./module-links";
import { selectCurrentModuleRelease } from "./definition-dependency-resolution";
import { DefinitionError } from "./definition-error";
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
  compileApplicationDraftOnce,
  retainApplicationDraftCompilation,
  readRetainedApplicationDraftCandidate,
  readRetainedApplicationPublicationHistory,
  retainApplicationDraftPublicationHistory,
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
  type DefinitionPublicationReader,
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
  candidate: DefinitionDraftCandidate;
  publicationHistory: DefinitionPublicationHistoryEvidence | undefined;
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
  extensionPointUses: readonly ModuleExtensionPointUse[];
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
  "choice",
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
const compileDraftSnapshotOver = async (
  context: SessionContext,
  overlay: DefinitionPublicationTransaction,
  catalogue: DefinitionPublicationCatalogue,
  candidate: DefinitionDraftCandidate | DefinitionPublicationCandidate,
): Promise<ApplicationDraftCompilation> => {
  const source = candidate.draft.source;
  if (source.kind !== "application") return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  const inlineKeys = new Set(source.body.modules.map((module) => module.key));
  const ownedRoots = await overlay.readOwnedModuleRoots(String(candidate.draft.rootId));
  const usedKeys = applicationModuleKeys(source).filter((key) => !inlineKeys.has(key));
  const needsDirectory = !applicationModuleKeys(source).includes(peopleDirectory.module);
  const pages = await overlay.readModuleReleaseAnchors(candidate.draft.organizationId, [
    ...usedKeys,
    ...(needsDirectory ? [peopleDirectory.module] : []),
  ]);
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
  return compileApplicationDraftOnce(cacheKey, async () => {
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
      candidate: {
        draft: candidate.draft,
        identities: candidate.identities,
        currentReleaseVersion: latestReleaseVersion(
          candidate,
        ) as DefinitionDraftCandidate["currentReleaseVersion"],
      },
      publicationHistory: readRetainedApplicationPublicationHistory(candidate),
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
  });
};

/**
 * The compile of a saved Application revision over the overlay, or over a fresh one when preview
 * preparation staged the draft's inline Modules between the compile's reads of their roots and
 * drafts (the reads see each commit): that refusal is a moved snapshot, not a stale draft, so the
 * compile reads them once more. A second refusal is the answer.
 */
const compileDraftSnapshot = async (
  context: SessionContext,
  reader: DefinitionPublicationReader,
  overlay: DefinitionPublicationTransaction,
  catalogue: DefinitionPublicationCatalogue,
  candidate: DefinitionDraftCandidate | DefinitionPublicationCandidate,
): Promise<ApplicationDraftCompilation> => {
  try {
    return await compileDraftSnapshotOver(context, overlay, catalogue, candidate);
  } catch (error) {
    if (!(error instanceof DefinitionError) || error.code !== "DEFINITION_DRAFT_STALE_OR_MISSING")
      throw error;
    console.info(
      "[definition] inline Modules were staged during the draft compile: DEFINITION_DRAFT_COMPILE_RESTAGED",
    );
    return compileDraftSnapshotOver(
      context,
      createDraftModuleOverlay(reader, context, candidate.draft),
      catalogue,
      candidate,
    );
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
      const previousFields = new Set(
        previousModules.flatMap((release) =>
          release!.compilationOutput.canonical.content.recordTypes.flatMap((record) =>
            record.fields.map((field) => `${release!.key}:${record.key}.${field.key}`),
          ),
        ),
      );
      const source = candidate.draft.source as ApplicationSourceDocument;
      return prepareDefinitionPublicationResultSchema.parse({
        confirmation: state.confirmation,
        addedFields: source.body.modules.flatMap((module) =>
          module.record_types.flatMap((record) =>
            record.fields.flatMap((field) => {
              const reference = `${module.key}:${record.key}.${field.key}`;
              return previousFields.has(reference) ? [] : [reference];
            }),
          ),
        ),
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
        reader,
        createDraftModuleOverlay(reader, context, candidate.draft),
        catalogue,
        candidate,
      );
    });
  },

  /**
   * Published field facts and compilation share one request-scoped definition snapshot. It reads
   * the draft once and returns it beside the compile; a caller that omits the expected revision
   * takes the saved one, so no caller reads the same draft a second time.
   */
  readApplicationDraftSnapshot: async (
    context: SessionContext,
    input: unknown,
    resources: Readonly<{ publication: boolean }>,
  ) => {
    const command = prepareDefinitionPublicationCommandSchema
      .partial({ expectedDraftRevision: true })
      .safeParse(input);
    if (!command.success) return refuse("INVALID_DEFINITION_PUBLICATION_COMMAND");
    await authorize(authority, context, { kind: "draft_change", rootId: command.data.rootId });
    return repository.read(context, async (reader) => {
      const stored = await reader.readDraftCandidate(command.data.rootId);
      if (stored === undefined) return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
      const candidate = validateDraftCandidate(context, stored, {
        rootId: command.data.rootId,
        expectedDraftRevision: command.data.expectedDraftRevision ?? stored.draft.draftRevision,
      });
      if (candidate.draft.kind !== "application" || candidate.draft.source.kind !== "application")
        return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
      const overlay = createDraftModuleOverlay(reader, context, candidate.draft);
      const publication: ApplicationDraftPublication | null = resources.publication
        ? await overlay.readOwnedModulePublication(String(candidate.draft.rootId))
        : null;
      try {
        return {
          draft: candidate.draft,
          publication,
          compilation: await compileDraftSnapshot(context, reader, overlay, catalogue, candidate),
          failure: undefined,
        };
      } catch (failure) {
        return { draft: candidate.draft, publication, compilation: null, failure };
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
      const retained = readRetainedApplicationDraftCandidate(
        context.organizationId,
        command.data.rootId,
        command.data.expectedDraftRevision,
      );
      const candidate =
        retained !== undefined && (await reader.isApplicationDraftCurrent(retained))
          ? retained
          : validateDraftCandidate(
              context,
              await reader.readDraftCandidate(command.data.rootId),
              command.data,
            );
      if (candidate.draft.source.kind !== "application")
        return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
      const overlay = createDraftModuleOverlay(reader, context, candidate.draft);
      // The revision the builder already compiled is released as it was compiled.
      return planApplicationPreview(
        context,
        overlay,
        candidate,
        catalogue.permissions,
        async () => {
          const compilation = await compileDraftSnapshot(
            context,
            reader,
            overlay,
            catalogue,
            candidate,
          );
          const historyEvidence =
            compilation.publicationHistory ??
            applicationCandidate(
              context,
              await reader.readCandidate(command.data.rootId),
              command.data,
            ).historyEvidence;
          if (historyEvidence.anchorReleaseRevision !== (candidate.draft.publishedRevision ?? null))
            return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
          retainApplicationDraftPublicationHistory(compilation, historyEvidence);
          return { releasePlan: compilation.releasePlan, historyEvidence };
        },
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
