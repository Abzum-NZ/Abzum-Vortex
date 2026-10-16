import "server-only";

import { componentLabelsOf } from "./publication-component-labels";

import {
  moduleSourceDocumentSchema,
  translateDefinitionSchemaError,
  prepareDefinitionPublicationCommandSchema,
  prepareDefinitionPublicationResultSchema,
  publishDefinitionCommandSchema,
  publishDefinitionResultSchema,
  recordTypeIdSchema,
  fieldIdSchema,
  type ApplicationCompilationOutput,
  type DefinitionResolutionSnapshot,
  type ApplicationSourceDocument,
  type PrepareDefinitionPublicationCommand,
  type PublishDefinitionCommand,
  type PublishDefinitionResult,
  type SessionContext,
  type ModuleField,
  type Fingerprint,
  flowFormulaSchema,
  type Revision,
} from "../schema";
import { applicationModuleKeys } from "./application-module-sources";
import { APPLICATION_PLATFORM_COMPATIBILITY_VERSION } from "./platform-compatibility";
import {
  requireBuilderAuthority,
  type BuilderAuthority,
  type BuilderOperation,
} from "./builder-authority";
import { fingerprintCanonicalValue } from "./canonical-json-definition";
import { DefinitionCompilationError } from "./compilation-error";
import { extractModuleSourceIdentityRequirements } from "./source-identities";
import { validateDefinitionSource } from "./validation";
import {
  applicationDraftCompilationKey,
  readCachedApplicationDraftCompilation,
  retainApplicationDraftCompilation,
} from "./application-draft-compilation-cache";
import {
  type DefinitionResolution,
  refuse,
  type DefinitionPublicationCandidate,
  type ResolvableModuleRelease,
  type DefinitionPublicationCatalogue,
  type DefinitionPublicationRepository,
  type PreparedDefinitionPublication,
} from "./definition-publication-contracts";
import {
  type ModuleQueryFilterDraftResult,
  type ModuleQueryFilterValidationResult,
  moduleQueryFilterReadCommandSchema,
  moduleQueryFilterValidationCommandSchema,
  moduleValidationTranslationContext,
  moduleValidationFailure,
  moduleQueryChoices,
  definitionModuleReferenceFailures,
  moduleValidationFromFailures,
  compileCurrentModuleQueryFilterState,
} from "./module-query-filter-draft";
import {
  type ResolvedDependencies,
  resolveDependencies,
  assertNoCycle,
  buildResolution,
} from "./definition-dependency-resolution";
import {
  type CompiledModuleCandidate,
  compileModuleCandidate,
  compileCandidate,
  validateCandidate,
  prepareFromReader,
} from "./definition-publication-compilation";
import {
  type ModuleBeforeSaveConditionDraftResult,
  type ModuleBeforeSaveConditionValidationResult,
  beforeSaveReadSchema,
  beforeSaveValidationSchema,
  encodeBeforeSaveCondition,
  beforeSaveChoices,
  beforeSaveSemanticFailures,
  compileBeforeSaveState,
} from "./module-before-save-condition-draft";

export type ApplicationDraftCompilation = Readonly<{
  compilation: ApplicationCompilationOutput;
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
  readModuleBeforeSaveConditionDraft: async (
    context: SessionContext,
    input: unknown,
  ): Promise<ModuleBeforeSaveConditionDraftResult> => {
    const parsed = beforeSaveReadSchema.safeParse(input);
    if (!parsed.success) return refuse("INVALID_DEFINITION_PUBLICATION_COMMAND");
    await authorize(authority, context, { kind: "draft_change", rootId: parsed.data.rootId });
    return repository.read(context, async (reader) => {
      const state = await compileBeforeSaveState(context, reader, catalogue, parsed.data);
      if (state.kind !== "available") return state;
      const choices = beforeSaveChoices(state.state);
      if (parsed.data.flowAlias === undefined)
        return { kind: "available", flowChoices: choices.map((entry) => entry.choice) };
      const matches = choices.filter(
        (entry) =>
          entry.choice.alias === parsed.data.flowAlias &&
          entry.choice.taskId === parsed.data.taskId,
      );
      if (matches.length !== 1)
        return { kind: "unsupported_context", reason: "flow_target_unsupported" };
      return {
        kind: "available",
        flowChoices: choices.map((entry) => entry.choice),
        ...(matches[0]!.context === undefined ? {} : { selected: matches[0]!.context }),
      };
    });
  },
  validateModuleBeforeSaveConditionDraft: async (
    context: SessionContext,
    input: unknown,
  ): Promise<ModuleBeforeSaveConditionValidationResult> => {
    const parsed = beforeSaveValidationSchema.safeParse(input);
    if (!parsed.success) return refuse("INVALID_DEFINITION_PUBLICATION_COMMAND");
    const command = parsed.data;
    await authorize(authority, context, { kind: "draft_change", rootId: command.rootId });
    return repository.read(context, async (reader) => {
      const loaded = await compileBeforeSaveState(context, reader, catalogue, command);
      if (loaded.kind !== "available") return loaded;
      const state = loaded.state;
      const matches = beforeSaveChoices(state).filter(
        (entry) =>
          entry.choice.alias === command.flowAlias && entry.choice.taskId === command.taskId,
      );
      const current = matches.length === 1 ? matches[0]!.context : undefined;
      if (current === undefined)
        return {
          kind: "unsupported_context",
          reason: matches[0]?.choice.reason ?? "flow_target_unsupported",
        };
      if (
        current.resolutionFingerprint !== command.expectedResolutionFingerprint ||
        current.operandBindingFingerprint !== command.expectedOperandBindingFingerprint
      )
        return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
      const encoded = encodeBeforeSaveCondition(command.condition, current.fields);
      const formula = flowFormulaSchema.safeParse(encoded);
      if (!formula.success)
        return { kind: "unsupported_context", reason: "operand_context_unsupported" };
      const draft = state.candidate.draft;
      if (draft.kind !== "module" || draft.source.kind !== "module")
        return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
      if (
        fingerprintCanonicalValue(command.condition) ===
        fingerprintCanonicalValue(current.condition)
      )
        return {
          kind: "validated",
          source: draft.source,
          sourceFingerprint: draft.sourceFingerprint,
          context: current,
          noChange: true,
        };
      const source = structuredClone(draft.source);
      const flows = source.body.flows.filter(
        (entry) => entry.id === current.flow.alias && entry.key === current.flow.key,
      );
      const task = flows.length === 1 ? flows[0]!.tasks[current.task.path[1]] : undefined;
      if (task?.type !== "if" || !("condition" in task) || task.id !== current.task.id)
        return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
      task.condition = formula.data;
      if (
        fingerprintCanonicalValue(extractModuleSourceIdentityRequirements(source)) !==
        fingerprintCanonicalValue(extractModuleSourceIdentityRequirements(draft.source))
      )
        return refuse("DEFINITION_COMPILATION_REFUSED");
      const parsedSource = moduleSourceDocumentSchema.safeParse(source);
      if (!parsedSource.success)
        return {
          kind: "validation_failed",
          validation: translateDefinitionSchemaError(
            parsedSource.error,
            moduleValidationTranslationContext(draft.source, context.correlationId),
          ),
        };
      const shape = validateDefinitionSource(parsedSource.data, catalogue.permissions);
      if (!shape.valid)
        return {
          kind: "validation_failed",
          validation: moduleValidationFromFailures(shape.failures, source, context.correlationId),
        };
      const sourceFingerprint = fingerprintCanonicalValue(source);
      const candidate: DefinitionPublicationCandidate = {
        ...state.candidate,
        draft: { ...draft, source, sourceFingerprint },
      };
      try {
        const resolution = buildResolution(
          candidate,
          state.dependencies,
          candidate.historyEvidence.latestRelease?.publication.releaseVersion ?? "1.0.0",
        );
        if (resolution.contractVersion !== "3.0.0") return refuse("DEFINITION_COMPILATION_REFUSED");
        const compiled = compileModuleCandidate(
          candidate,
          state.dependencies,
          resolution,
          catalogue.permissions,
        );
        const failures = beforeSaveSemanticFailures(compiled, catalogue.permissions);
        if (failures.length > 0)
          return {
            kind: "validation_failed",
            validation: moduleValidationFromFailures(failures, source, context.correlationId),
          };
        const choices = beforeSaveChoices({ ...state, candidate, resolution, compiled });
        const next = choices.filter(
          (entry) =>
            entry.choice.alias === current.flow.alias && entry.choice.taskId === current.task.id,
        );
        const nextContext = next.length === 1 ? next[0]!.context : undefined;
        if (
          nextContext === undefined ||
          nextContext.resolutionFingerprint !== current.resolutionFingerprint ||
          fingerprintCanonicalValue(nextContext.condition) !==
            fingerprintCanonicalValue(command.condition)
        )
          return refuse("DEFINITION_COMPILATION_REFUSED");
        // Full compiled source is fixed except this existing node's predicate and authored flow predicate.
        const expected = structuredClone(state.compiled.output.canonical.content);
        const nextContent = compiled.output.canonical.content;
        const expectedFlow = expected.flows.find(
          (entry) => String(entry.id) === current.flow.flowId,
        );
        const nextFlow = nextContent.flows.find(
          (entry) => String(entry.id) === current.flow.flowId,
        );
        const expectedTask = expectedFlow?.tasks[current.task.path[1]];
        const nextTask = nextFlow?.tasks[current.task.path[1]];
        const expectedNode = expected.rules
          .find((entry) => String(entry.ruleId) === current.flow.flowId)
          ?.nodes.find((entry) => entry.nodeId === current.task.nodeId);
        const nextNode = nextContent.rules
          .find((entry) => String(entry.ruleId) === current.flow.flowId)
          ?.nodes.find((entry) => entry.nodeId === current.task.nodeId);
        if (
          expectedTask?.type !== "if" ||
          !("condition" in expectedTask) ||
          nextTask?.type !== "if" ||
          !("condition" in nextTask) ||
          expectedNode?.type !== "condition" ||
          nextNode?.type !== "condition"
        )
          return refuse("DEFINITION_COMPILATION_REFUSED");
        expectedTask.condition = nextTask.condition;
        expectedNode.condition = nextNode.condition;
        if (fingerprintCanonicalValue(expected) !== fingerprintCanonicalValue(nextContent))
          return refuse("DEFINITION_COMPILATION_REFUSED");
        return {
          kind: "validated",
          source,
          sourceFingerprint,
          context: nextContext,
          noChange: false,
        };
      } catch (error) {
        if (!(error instanceof DefinitionCompilationError)) throw error;
        return {
          kind: "validation_failed",
          validation: moduleValidationFailure(error, source, context.correlationId),
        };
      }
    });
  },
  readModuleQueryFilterDraft: async (
    context: SessionContext,
    input: unknown,
  ): Promise<ModuleQueryFilterDraftResult> => {
    const command = moduleQueryFilterReadCommandSchema.safeParse(input);
    if (!command.success) refuse("INVALID_DEFINITION_PUBLICATION_COMMAND");
    const parsed = command.data;
    await authorize(authority, context, { kind: "draft_change", rootId: parsed.rootId });
    return repository.read(context, async (reader) => {
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
    });
  },

  validateModuleQueryFilterDraft: async (
    context: SessionContext,
    input: unknown,
  ): Promise<ModuleQueryFilterValidationResult> => {
    const command = moduleQueryFilterValidationCommandSchema.safeParse(input);
    if (!command.success) refuse("INVALID_DEFINITION_PUBLICATION_COMMAND");
    const parsed = command.data;
    await authorize(authority, context, { kind: "draft_change", rootId: parsed.rootId });
    return repository.read(context, async (reader) => {
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
      const shapeValidation = validateDefinitionSource(source.data, catalogue.permissions);
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
      const candidate: DefinitionPublicationCandidate = {
        ...state.state.candidate,
        draft: { ...draft, source: source.data, sourceFingerprint },
      };
      let resolution: DefinitionResolutionSnapshot;
      let compiled: CompiledModuleCandidate;
      try {
        const ownVersion =
          candidate.historyEvidence.latestRelease?.publication.releaseVersion ?? "1.0.0";
        const nextResolution = buildResolution(candidate, state.state.dependencies, ownVersion);
        if (nextResolution.contractVersion !== "3.0.0")
          return refuse("DEFINITION_COMPILATION_REFUSED");
        resolution = nextResolution;
        compiled = compileModuleCandidate(
          candidate,
          state.state.dependencies,
          resolution,
          catalogue.permissions,
        );
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
        catalogue.permissions,
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
    });
  },

  prepare: async (
    context: SessionContext,
    input: unknown,
  ): Promise<PreparedDefinitionPublication> => {
    const command = prepareDefinitionPublicationCommandSchema.safeParse(input);
    if (!command.success) refuse("INVALID_DEFINITION_PUBLICATION_COMMAND");
    const parsedCommand = command.data as PrepareDefinitionPublicationCommand;
    await authorize(authority, context, { kind: "publication", rootId: parsedCommand.rootId });
    const { state, previousContent } = await repository.read(context, async (reader) => {
      const candidate = await reader.readCandidate(parsedCommand.rootId);
      return {
        state: await prepareFromReader(context, reader, catalogue, parsedCommand, candidate),
        previousContent: candidate?.historyEvidence.latestRelease?.content,
      };
    });
    return prepareDefinitionPublicationResultSchema.parse({
      confirmation: state.confirmation,
      componentLabels: componentLabelsOf(state.compilationOutput.canonical, previousContent),
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
      // The compile is a pure function of exactly what this key names, so the same draft revision
      // under the same resolved dependencies is compiled once. Authorisation, the candidate
      // validation and the dependency resolution above run on every call.
      const cacheKey = applicationDraftCompilationKey([
        candidate.draft.organizationId.toLowerCase(),
        candidate.draft.rootId.toLowerCase(),
        candidate.draft.draftRevision,
        candidate.draft.sourceFingerprint,
        candidate.draft.publishedRevision ?? null,
        currentVersion,
        resolution.fingerprint,
        dependencies.composition?.fingerprint ?? null,
        dependencies.modules.map((release) => [
          release.rootId,
          release.releaseRevision,
          release.contentFingerprint,
          release.resolutionFingerprint,
        ]),
        dependencies.connections.map((release) => [release.rootId, release.contentFingerprint]),
      ]);
      const cached = readCachedApplicationDraftCompilation(cacheKey);
      if (cached !== undefined) return cached;
      const compilation = compileCandidate(
        candidate,
        dependencies,
        resolution,
        false,
        catalogue.permissions,
      );
      if (
        compilation.kind !== "application" ||
        compilation.platformCompatibilityVersion !== APPLICATION_PLATFORM_COMPATIBILITY_VERSION
      )
        return refuse("DEFINITION_COMPILATION_REFUSED");
      return retainApplicationDraftCompilation(cacheKey, {
        compilation,
        conditionContexts: projectDraftConditionContexts(
          candidate.draft.source,
          candidate.draft.sourceFingerprint,
          dependencies,
          resolution,
        ),
        currentReleaseRevision: candidate.draft.publishedRevision ?? null,
      });
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
