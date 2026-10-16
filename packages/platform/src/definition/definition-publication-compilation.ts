import "server-only";

import {
  applicationCompilationRequestSchema,
  definitionCompilationOutputSchema,
  definitionPublicationConfirmationSchema,
  moduleCompilationRequestSchema,
  savedConditionRevisionAssignmentSchema,
  storedDefinitionDraftSchema,
  type DefinitionCompilationOutput,
  type DefinitionPublicationHistoryEvidence,
  type ExactDefinitionDependency,
  type PrepareDefinitionPublicationCommand,
  type SavedConditionRevisionAssignment,
  type SessionContext,
  type StoredDefinitionDraft,
} from "../schema";
import { APPLICATION_PLATFORM_COMPATIBILITY_VERSION } from "./platform-compatibility";
import { applicationSourceContractVersion } from "./application-contract-versions";
import type { z } from "zod";
import { fingerprintCanonicalValue } from "./canonical-json-definition";
import { compileParsedDefinition } from "./compiler";
import type { PlatformPermissionSource } from "../access/platform-permissions";
import { DefinitionCompilationError } from "./compilation-error";
import { validateDefinitionSet } from "./validation";
import { compareDefinitionVersionImpactWithEvidence } from "./version-impact-definition";
import {
  deriveSavedConditionRevisions,
  type SavedConditionLike,
} from "./saved-condition-revisions";
import {
  type ModuleOutput,
  type PublishableCompilationOutput,
  type DefinitionResolution,
  refuse,
  type DefinitionCandidateDraft,
  type DefinitionDraftCandidate,
  type DefinitionPublicationCandidate,
  type DefinitionPublicationReader,
  type DefinitionPublicationCatalogue,
  type PreparedState,
} from "./definition-publication-contracts";
import {
  type ResolvedDependencies,
  resolveDependencies,
  assertNoCycle,
  manifestFor,
  buildResolution,
} from "./definition-dependency-resolution";

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
  candidate: DefinitionPublicationCandidate,
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
 * The request parse the compile entry performed for the requests this service
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
    | z.output<typeof applicationCompilationRequestSchema>
    | z.output<typeof moduleCompilationRequestSchema>,
  output: Exclude<DefinitionCompilationOutput, { kind: "connection_type" }>,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
  historyEvidence: DefinitionPublicationHistoryEvidence,
  permissions: PlatformPermissionSource,
): void => {
  const validation = validateDefinitionSet({
    permissions,
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

export type CompiledModuleCandidate = Readonly<{
  request: z.output<typeof moduleCompilationRequestSchema>;
  output: ModuleOutput;
  dependencyOutputs: readonly DefinitionCompilationOutput[];
}>;

const deriveSavedConditionRevisionsFromHistory = (
  candidate: DefinitionPublicationCandidate,
  conditions: readonly SavedConditionLike[],
): SavedConditionRevisionAssignment[] => {
  const evidence = candidate.historyEvidence;
  if (evidence.kind !== "module") return refuse("DEFINITION_HISTORY_INVALID");
  const latestReleaseIds = new Set(
    (evidence.latestRelease?.content.sharingConditions ?? []).map(
      (condition) => condition.conditionId,
    ),
  );
  return deriveSavedConditionRevisions({
    conditions,
    history: { lastSeen: candidate.savedConditionHistory, latestReleaseIds },
  });
};

export const compileModuleCandidate = (
  candidate: DefinitionPublicationCandidate,
  dependencies: ResolvedDependencies,
  resolution: DefinitionResolution,
  permissions: PlatformPermissionSource,
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
    parsedCompilationRequest(moduleCompilationRequestSchema, {
      ...common,
      savedConditionRevisions: provisionalSavedConditionRevisions(candidate),
    }),
    dependencyOutputs,
    permissions,
  );
  if (
    provisional.kind !== "module" ||
    !("validationContractVersion" in provisional) ||
    provisional.validationContractVersion !== "3.0.0"
  )
    return refuse("DEFINITION_COMPILATION_REFUSED");
  const savedConditionRevisions = deriveSavedConditionRevisionsFromHistory(
    candidate,
    provisional.canonical.content.sharingConditions,
  );
  const request = parsedCompilationRequest(moduleCompilationRequestSchema, {
    ...common,
    savedConditionRevisions,
  });
  const output = compileParsedDefinition(request, dependencyOutputs, permissions);
  if (
    output === undefined ||
    output.kind !== "module" ||
    !("validationContractVersion" in output) ||
    output.validationContractVersion !== "3.0.0"
  )
    return refuse("DEFINITION_COMPILATION_REFUSED");
  return { request, output, dependencyOutputs };
};

/**
 * The one Application compile: a draft and its resolved dependencies to compiled output. A draft
 * compile for the builder stops here; publication also judges the result as a release.
 */
export const compileApplicationCandidate = (
  candidate: DefinitionCandidateDraft,
  dependencies: ResolvedDependencies,
  resolution: DefinitionResolution,
  permissions: PlatformPermissionSource,
): Readonly<{
  request: z.output<typeof applicationCompilationRequestSchema>;
  output: PublishableCompilationOutput;
  dependencyOutputs: readonly DefinitionCompilationOutput[];
}> => {
  if (
    candidate.draft.source.kind !== "application" ||
    resolution.contractVersion !== "3.0.0" ||
    dependencies.composition === undefined
  )
    return refuse("DEFINITION_COMPILATION_REFUSED");
  const dependencyOutputs = [
    ...dependencies.modules.map((release) => release.compilationOutput),
    ...dependencies.connections.map((release) => release.compilationOutput),
  ].map((output) => definitionCompilationOutputSchema.parse(output));
  const request = parsedCompilationRequest(applicationCompilationRequestSchema, {
    sourceContractVersion: applicationSourceContractVersion,
    validationContractVersion: "3.0.0" as const,
    source: candidate.draft.source,
    resolution,
    catalogueSnapshot: dependencies.composition,
    draftMetadata: draftMetadata(candidate.draft),
  });
  return { request, output: compileParsedDefinition(request, dependencyOutputs, permissions), dependencyOutputs };
};

export const compileCandidate = (
  candidate: DefinitionPublicationCandidate,
  dependencies: ResolvedDependencies,
  resolution: DefinitionResolution,
  final: boolean,
  permissions: PlatformPermissionSource,
): PublishableCompilationOutput => {
  if (candidate.draft.source.kind === "application") {
    const { request, output, dependencyOutputs } =
      compileApplicationCandidate(candidate, dependencies, resolution, permissions);
    if (
      final &&
      (output.kind !== "application" ||
        output.platformCompatibilityVersion !== APPLICATION_PLATFORM_COMPATIBILITY_VERSION)
    )
      return refuse("DEFINITION_COMPILATION_REFUSED");
    if (final)
      assertFinalPublicationValidation(
        request,
        output as Exclude<DefinitionCompilationOutput, { kind: "connection_type" }>,
        dependencyOutputs,
        candidate.historyEvidence,
        permissions,
      );
    return output;
  }
  const dependencyOutputs = [
    ...dependencies.modules.map((release) => release.compilationOutput),
    ...dependencies.connections.map((release) => release.compilationOutput),
  ].map((output) => definitionCompilationOutputSchema.parse(output));
  if (candidate.draft.source.kind === "module") {
    if (final) {
      const compiled = compileModuleCandidate(candidate, dependencies, resolution, permissions);
      assertFinalPublicationValidation(
        compiled.request,
        compiled.output,
        compiled.dependencyOutputs,
        candidate.historyEvidence,
        permissions,
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
      parsedCompilationRequest(moduleCompilationRequestSchema, {
        ...common,
        savedConditionRevisions: provisionalSavedConditionRevisions(candidate),
      }),
      dependencyOutputs,
      permissions,
    );
    if (
      provisional.kind !== "module" ||
      !("validationContractVersion" in provisional) ||
      provisional.validationContractVersion !== "3.0.0"
    )
      return refuse("DEFINITION_COMPILATION_REFUSED");
    const savedConditionRevisions = deriveSavedConditionRevisionsFromHistory(
      candidate,
      provisional.canonical.content.sharingConditions,
    );
    const request = {
      ...common,
      savedConditionRevisions,
    };
    return compileParsedDefinition(
      parsedCompilationRequest(moduleCompilationRequestSchema, request),
      dependencyOutputs,
      permissions,
    );
  }
  // Only an Application or a Module is a customer-publishable definition, and each has exactly
  // one current source/validation contract pair. A stored draft of any other shape is refused.
  return refuse("DEFINITION_COMPILATION_REFUSED");
};

/** The stored draft re-read, of this organisation and at exactly the expected root and revision. */
const validatedDraft = (
  context: SessionContext,
  supplied: StoredDefinitionDraft,
  command: PrepareDefinitionPublicationCommand,
): StoredDefinitionDraft => {
  const draft = storedDefinitionDraftSchema.safeParse(supplied);
  if (!draft.success) return refuse("DEFINITION_HISTORY_INVALID");
  if (draft.data.organizationId !== context.organizationId)
    refuse("DEFINITION_ORGANIZATION_MISMATCH");
  if (
    String(draft.data.rootId) !== String(command.rootId) ||
    draft.data.draftRevision !== command.expectedDraftRevision
  )
    refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  if (draft.data.sourceFingerprint !== fingerprintCanonicalValue(draft.data.source))
    refuse("DEFINITION_SOURCE_EVIDENCE_MISMATCH");
  return draft.data;
};

/** A builder's draft compile: the draft as `validateCandidate` checks it, and its current version. */
export const validateDraftCandidate = (
  context: SessionContext,
  candidateInput: DefinitionDraftCandidate | undefined,
  command: PrepareDefinitionPublicationCommand,
): DefinitionDraftCandidate => {
  if (candidateInput === undefined) return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  const draft = validatedDraft(context, candidateInput.draft, command);
  if ((draft.publishedRevision === undefined) !== (candidateInput.currentReleaseVersion === null))
    refuse("DEFINITION_HISTORY_INVALID");
  return { draft, identities: candidateInput.identities, currentReleaseVersion: candidateInput.currentReleaseVersion };
};

export const validateCandidate = (
  context: SessionContext,
  candidateInput: DefinitionPublicationCandidate | undefined,
  command: PrepareDefinitionPublicationCommand,
): DefinitionPublicationCandidate => {
  if (candidateInput === undefined) return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  const supplied = candidateInput;
  const candidate: DefinitionPublicationCandidate = {
    draft: validatedDraft(context, supplied.draft, command),
    identities: supplied.identities,
    historyEvidence: supplied.historyEvidence,
    savedConditionHistory: supplied.savedConditionHistory,
  };
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

/** The one comparator contract every stored draft kind declares. */
const candidateValidationContractVersion = { validationContractVersion: "3.0.0" as const };

export const prepareFromReader = async (
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
  const provisional = compileCandidate(
    candidate,
    dependencies,
    provisionalResolution,
    false,
    catalogue.permissions,
  );
  const impact = compareDefinitionVersionImpactWithEvidence({
    kind: candidate.draft.kind,
    ...candidateValidationContractVersion,
    historyEvidence: candidate.historyEvidence,
    candidate: provisional.canonical,
  });
  if (impact.outcome === "no_change") refuse("DEFINITION_NO_CHANGE");
  const confirmableImpact = impact as Extract<typeof impact, { assignedVersion: string }>;
  const resolution = buildResolution(candidate, dependencies, confirmableImpact.assignedVersion);
  const compilationOutput = compileCandidate(
    candidate,
    dependencies,
    resolution,
    true,
    catalogue.permissions,
  );
  const confirmedImpact = compareDefinitionVersionImpactWithEvidence({
    kind: candidate.draft.kind,
    ...candidateValidationContractVersion,
    historyEvidence: candidate.historyEvidence,
    candidate: compilationOutput.canonical,
  });
  if (confirmedImpact.outcome === "no_change") refuse("DEFINITION_VERSION_REFUSED");
  const finalImpact = confirmedImpact as Extract<
    typeof confirmedImpact,
    { assignedVersion: string }
  >;
  if (finalImpact.assignedVersion !== confirmableImpact.assignedVersion)
    refuse("DEFINITION_VERSION_REFUSED");
  const confirmation = definitionPublicationConfirmationSchema.parse({
    outcome: finalImpact.outcome,
    rootId: candidate.draft.rootId,
    expectedDraftRevision: candidate.draft.draftRevision,
    sourceFingerprint: candidate.draft.sourceFingerprint,
    assignedVersion: finalImpact.assignedVersion,
    contentFingerprint: compilationOutput.artifact.contentFingerprint,
    resolutionFingerprint: compilationOutput.resolutionFingerprint,
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

/**
 * The authority decides for exactly one organisation. A context for any other organisation is
 * refused before the authority or any evidence is consulted.
 */
