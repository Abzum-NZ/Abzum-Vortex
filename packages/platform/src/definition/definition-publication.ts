import "server-only";

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
} from "./definition-publication-contracts";
import type { ResolvedDependencies } from "./definition-dependency-resolution";
import { validateDraftCandidate } from "./definition-publication-compilation";
import {
  applicationCandidate,
  materializeInlineModules,
  compileApplicationWithInlineModules,
  planApplicationPublication,
  rehearseApplicationPreview,
  type RehearsedPreviewRelease,
} from "./application-publication";

/** The internal Module releases a rehearsed preparation writes are rolled back with this note. */
const preparationReleaseNote = "Rehearsed by publication preparation";

export type ApplicationDraftCompilation = Readonly<{
  compilation: ApplicationCompilationOutput;
  /** The exact Module releases the draft compiled against, its own inline Modules held in memory. */
  moduleReleases: readonly ResolvableModuleRelease[];
  conditionContexts: readonly ApplicationDraftConditionContext[];
  /** The root's current published release revision; preview only labels it and never reads it. */
  currentReleaseRevision: Revision | null;
  /**
   * What the current published releases of the draft's own Modules hold, as qualified references:
   * every record type (`module:record`) and field (`module:record.field`). Their stored shape is
   * fixed, so Studio offers only the changes an upgrade accepts.
   */
  published: Readonly<{ recordTypes: readonly string[]; fields: readonly string[] }>;
  /**
   * The organisation's people directory, which a Person link points at: the Application that owns
   * it and the label people are shown by. Null when the organisation has no released directory.
   */
  peopleDirectory: PeopleDirectoryOwner | null;
}>;

/** The owner and person title of a release of the people directory Module. */
const peopleDirectoryOwnerOf = (release: ResolvableModuleRelease): PeopleDirectoryOwner | null => {
  const content = release.compilationOutput.canonical.content;
  const personKey = peopleDirectory.recordType.slice(peopleDirectory.recordType.lastIndexOf(":") + 1);
  const person = content.recordTypes.find((record) => record.key === personKey);
  const title = person?.fields.find((field) => String(field.fieldId) === String(person.titleFieldId));
  if (title === undefined) {
    console.error("[definition] the people directory release has no person title field: PEOPLE_DIRECTORY_UNREADABLE");
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
    // Preparation rehearses the whole publication and keeps only the inline Modules' internal
    // roots and drafts, whose permanent identities the confirmation is computed from.
    return repository.transaction(context, async (transaction) => {
      const candidate = applicationCandidate(
        context,
        await transaction.lockCandidate(parsedCommand.rootId),
        parsedCommand,
      );
      const roots = await materializeInlineModules(transaction, candidate);
      const state = await transaction.rehearse(() =>
        planApplicationPublication(
          context,
          transaction,
          catalogue,
          candidate,
          roots,
          preparationReleaseNote,
        ),
      );
      return prepareDefinitionPublicationResultSchema.parse({
        confirmation: state.confirmation,
        componentLabels: await componentLabelsOf(
          (blockId, releaseVersion) => catalogue.readPlatformBlockRelease(blockId, releaseVersion),
          state.compilationOutput.canonical,
          ...state.moduleOutputs.map((output) => output.canonical),
          candidate.historyEvidence.latestRelease?.content,
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
      // The compile is a pure function of the draft and the stored definitions it reads: its own
      // inline Modules' roots and the current release of every Module it uses. The same draft
      // revision over the same of those is compiled once; authorisation and the candidate
      // validation above run on every call.
      const source = candidate.draft.source;
      const inlineKeys = new Set(applicationModuleSources(source).map((module) => module.key));
      const overlay = createDraftModuleOverlay(reader, context, candidate.draft);
      const ownedRoots = await overlay.readOwnedModuleRoots(String(candidate.draft.rootId));
      const usedAnchors = [];
      for (const moduleKey of applicationModuleKeys(source).filter((key) => !inlineKeys.has(key))) {
        const page = await overlay.readModuleReleasePage(candidate.draft.organizationId, moduleKey);
        usedAnchors.push([moduleKey, page.rootId, page.anchorReleaseRevision]);
      }
      // A draft that does not use the people directory yet still names its current release, so
      // Studio can offer a Person link that adds the use.
      const directoryPage = applicationModuleKeys(source).includes(peopleDirectory.module) ? undefined
        : await overlay.readModuleReleasePage(candidate.draft.organizationId, peopleDirectory.module);
      const cacheKey = applicationDraftCompilationKey([
        candidate.draft.organizationId.toLowerCase(),
        candidate.draft.rootId.toLowerCase(),
        candidate.draft.draftRevision,
        candidate.draft.sourceFingerprint,
        candidate.draft.publishedRevision ?? null,
        candidate.currentReleaseVersion,
        ownedRoots.map((root) => [
          root.key,
          root.rootId,
          root.draftRevision,
          root.currentReleaseRevision,
          root.sourceFingerprint,
        ]),
        usedAnchors,
        directoryPage === undefined ? null : [directoryPage.rootId, directoryPage.anchorReleaseRevision],
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
      // The stored current release of each own Module (not the draft's, which the overlay holds).
      const published = { recordTypes: [] as string[], fields: [] as string[] };
      for (const root of ownedRoots) {
        if (root.currentReleaseRevision === null) continue;
        const release = await reader.readModuleRelease(candidate.draft.organizationId, root.rootId, root.currentReleaseRevision);
        if (release === undefined) return refuse("DEFINITION_COMPILATION_REFUSED");
        for (const record of release.compilationOutput.canonical.content.recordTypes as readonly {
          key: string; fields: readonly { key: string }[];
        }[]) {
          published.recordTypes.push(`${root.key}:${record.key}`);
          for (const field of record.fields) published.fields.push(`${root.key}:${record.key}.${field.key}`);
        }
      }
      if (
        compilation.kind !== "application" ||
        compilation.platformCompatibilityVersion !== APPLICATION_PLATFORM_COMPATIBILITY_VERSION
      )
        return refuse("DEFINITION_COMPILATION_REFUSED");
      let directory = compiled.dependencies.modules.find((release) => release.key === peopleDirectory.module);
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
        moduleReleases: compiled.dependencies.modules,
        conditionContexts: projectDraftConditionContexts(
          candidate.draft.source,
          candidate.draft.sourceFingerprint,
          compiled.dependencies,
          compiled.resolution,
        ),
        currentReleaseRevision: candidate.draft.publishedRevision ?? null,
        published,
        peopleDirectory: directory === undefined ? null : peopleDirectoryOwnerOf(directory),
      });
    });
  },

  /**
   * Rehearses the publication of the caller organisation's current Application draft at the
   * expected revision, exactly as publication runs it, and returns the release rows it wrote for
   * the Application and its inline Modules after undoing them. Only the inline Modules' internal
   * roots and drafts are kept, as preparation keeps them. A preview runs the returned rows.
   */
  rehearseApplicationPreview: async (
    context: SessionContext,
    input: unknown,
  ): Promise<readonly RehearsedPreviewRelease[]> => {
    const command = prepareDefinitionPublicationCommandSchema.safeParse(input);
    if (!command.success) refuse("INVALID_DEFINITION_PUBLICATION_COMMAND");
    const parsedCommand = command.data as PrepareDefinitionPublicationCommand;
    await authorize(authority, context, { kind: "publication", rootId: parsedCommand.rootId });
    return repository.transaction(context, async (transaction) => {
      const candidate = applicationCandidate(
        context,
        await transaction.lockCandidate(parsedCommand.rootId),
        parsedCommand,
      );
      const roots = await materializeInlineModules(transaction, candidate);
      return rehearseApplicationPreview(context, transaction, catalogue, candidate, roots);
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
      const roots = await materializeInlineModules(transaction, candidate);
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
