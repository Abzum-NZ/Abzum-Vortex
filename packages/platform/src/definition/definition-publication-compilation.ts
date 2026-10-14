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

export const compileCandidate = (
  candidate: DefinitionPublicationCandidate,
  dependencies: ResolvedDependencies,
  resolution: DefinitionResolution,
  final: boolean,
  permissions: PlatformPermissionSource,
): PublishableCompilationOutput => {
  const dependencyOutputs = [
    ...dependencies.modules.map((release) => release.compilationOutput),
    ...dependencies.connections.map((release) => release.compilationOutput),
  ].map((output) => definitionCompilationOutputSchema.parse(output));
  if (candidate.draft.source.kind === "application") {
    if (resolution.contractVersion !== "3.0.0" || dependencies.composition === undefined)
      return refuse("DEFINITION_COMPILATION_REFUSED");
    const request = {
      sourceContractVersion: "2.0.0" as const,
      validationContractVersion: "2.0.0" as const,
      source: candidate.draft.source,
      resolution,
      catalogueSnapshot: dependencies.composition,
      draftMetadata: draftMetadata(candidate.draft),
    };
    const output = compileParsedDefinition(
      parsedCompilationRequest(applicationCompilationRequestSchema, request),
      dependencyOutputs,
      permissions,
    );
    if (
      final &&
      (output.kind !== "application" ||
        output.platformCompatibilityVersion !== APPLICATION_PLATFORM_COMPATIBILITY_VERSION)
    )
      return refuse("DEFINITION_COMPILATION_REFUSED");
    if (final)
      assertFinalPublicationValidation(
        parsedCompilationRequest(applicationCompilationRequestSchema, request),
        output,
        dependencyOutputs,
        candidate.historyEvidence,
        permissions,
      );
    return output;
  }
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

export const validateCandidate = (
  context: SessionContext,
  candidateInput: DefinitionPublicationCandidate | undefined,
  command: PrepareDefinitionPublicationCommand,
): DefinitionPublicationCandidate => {
  if (candidateInput === undefined) return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  const supplied = candidateInput;
  const draft = storedDefinitionDraftSchema.safeParse(supplied.draft);
  if (!draft.success) return refuse("DEFINITION_HISTORY_INVALID");
  const candidate: DefinitionPublicationCandidate = {
    draft: draft.data,
    identities: supplied.identities,
    historyEvidence: supplied.historyEvidence,
    savedConditionHistory: supplied.savedConditionHistory,
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
    ...candidateValidationContractVersion(candidate.draft.source),
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
    ...candidateValidationContractVersion(candidate.draft.source),
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
