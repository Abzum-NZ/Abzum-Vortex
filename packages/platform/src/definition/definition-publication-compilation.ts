import "server-only";

import {
  applicationCompilationRequestSchema,
  moduleCompilationRequestSchema,
  savedConditionRevisionAssignmentSchema,
  storedDefinitionDraftSchema,
  type DefinitionCompilationOutput,
  type DefinitionPublicationHistoryEvidence,
  type PrepareDefinitionPublicationCommand,
  type SavedConditionRevisionAssignment,
  type SessionContext,
  type StoredDefinitionDraft,
} from "../schema";
import { APPLICATION_PLATFORM_COMPATIBILITY_VERSION } from "./platform-compatibility";
import {
  applicationSourceContractVersion,
  applicationValidationContractVersion,
} from "./application-contract-versions";
import { moduleSourceContractVersion } from "./module-source-contracts";
import { moduleValidationContractVersion } from "./module-contracts";
import type { z } from "zod";
import { fingerprintCanonicalValue } from "./canonical-json-definition";
import { compileParsedDefinition } from "./compiler";
import type { PlatformPermissionSource } from "../access/platform-permissions";
import { DefinitionCompilationError } from "./compilation-error";
import { validateDefinitionSet } from "./validation";
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
} from "./definition-publication-contracts";
import type { ResolvedDependencies } from "./definition-dependency-resolution";

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
    throw new DefinitionCompilationError(
      first.ruleCode,
      first.family,
      first.location,
      first.code,
      first.sentence,
    );
  }
};

type CompiledModuleCandidate = Readonly<{
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

/** The one Module compile: a staged inline Module and its resolved dependencies to compiled output. */
export const compileModuleCandidate = (
  candidate: DefinitionPublicationCandidate,
  dependencies: ResolvedDependencies,
  resolution: DefinitionResolution,
  permissions: PlatformPermissionSource,
): CompiledModuleCandidate => {
  if (candidate.draft.source.kind !== "module" || resolution.contractVersion !== "3.0.0")
    return refuse("DEFINITION_COMPILATION_REFUSED");
  // Dependency resolution authenticated these outputs and checked that they parse, but passes them
  // as stored: schema defaults (such as a Module's empty `queries`) are not filled in here.
  const dependencyOutputs = [
    ...dependencies.modules.map((release) => release.compilationOutput),
    ...dependencies.connections.map((release) => release.compilationOutput),
  ];
  const common = {
    sourceContractVersion: moduleSourceContractVersion,
    validationContractVersion: moduleValidationContractVersion,
    source: candidate.draft.source,
    resolution,
    draftMetadata: draftMetadata(candidate.draft),
  };
  const provisionalAssignments = provisionalSavedConditionRevisions(candidate);
  const provisionalRequest = parsedCompilationRequest(moduleCompilationRequestSchema, {
    ...common,
    savedConditionRevisions: provisionalAssignments,
  });
  const provisional = compileParsedDefinition(provisionalRequest, dependencyOutputs, permissions);
  if (
    provisional.kind !== "module" ||
    !("validationContractVersion" in provisional) ||
    provisional.validationContractVersion !== moduleValidationContractVersion
  )
    return refuse("DEFINITION_COMPILATION_REFUSED");
  const savedConditionRevisions = deriveSavedConditionRevisionsFromHistory(
    candidate,
    provisional.canonical.content.sharingConditions,
  );
  // When the first request already has the final assignments, its output is the final output.
  if (
    savedConditionRevisions.length === provisionalAssignments.length &&
    savedConditionRevisions.every((assignment, index) => {
      const provisional = provisionalAssignments[index]!;
      return (
        assignment.conditionId === provisional.conditionId &&
        assignment.revision === provisional.revision
      );
    })
  )
    return { request: provisionalRequest, output: provisional, dependencyOutputs };
  const request = parsedCompilationRequest(moduleCompilationRequestSchema, {
    ...common,
    savedConditionRevisions,
  });
  const output = compileParsedDefinition(request, dependencyOutputs, permissions);
  if (
    output === undefined ||
    output.kind !== "module" ||
    !("validationContractVersion" in output) ||
    output.validationContractVersion !== moduleValidationContractVersion
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
  // Dependency resolution authenticated these outputs and checked that they parse, but passes them
  // as stored: schema defaults (such as a Module's empty `queries`) are not filled in here.
  const dependencyOutputs = [
    ...dependencies.modules.map((release) => release.compilationOutput),
    ...dependencies.connections.map((release) => release.compilationOutput),
  ];
  const request = parsedCompilationRequest(applicationCompilationRequestSchema, {
    sourceContractVersion: applicationSourceContractVersion,
    validationContractVersion: applicationValidationContractVersion,
    source: candidate.draft.source,
    resolution,
    catalogueSnapshot: dependencies.composition,
    draftMetadata: draftMetadata(candidate.draft),
  });
  return {
    request,
    output: compileParsedDefinition(request, dependencyOutputs, permissions),
    dependencyOutputs,
  };
};

/**
 * Judges one compiled Application or Module as a release against its published history: the
 * Application's platform compatibility and the publication rules. A compile is produced once;
 * whatever releases it (publication, preview) judges that same output here.
 */
export const assertReleasable = (
  compiled: Readonly<{
    request:
      | z.output<typeof applicationCompilationRequestSchema>
      | z.output<typeof moduleCompilationRequestSchema>;
    output: PublishableCompilationOutput;
    dependencyOutputs: readonly DefinitionCompilationOutput[];
  }>,
  historyEvidence: DefinitionPublicationHistoryEvidence,
  permissions: PlatformPermissionSource,
): void => {
  const output = compiled.output;
  if (
    output.kind === "application" &&
    output.platformCompatibilityVersion !== APPLICATION_PLATFORM_COMPATIBILITY_VERSION
  )
    return refuse("DEFINITION_COMPILATION_REFUSED");
  assertFinalPublicationValidation(
    compiled.request,
    output,
    compiled.dependencyOutputs,
    historyEvidence,
    permissions,
  );
};

/** A parsed draft of this organisation, at exactly the expected root and revision, with its source's own fingerprint. */
const checkedDraft = (
  context: SessionContext,
  draft: StoredDefinitionDraft,
  command: PrepareDefinitionPublicationCommand,
): StoredDefinitionDraft => {
  if (draft.organizationId !== context.organizationId) refuse("DEFINITION_ORGANIZATION_MISMATCH");
  if (
    String(draft.rootId) !== String(command.rootId) ||
    draft.draftRevision !== command.expectedDraftRevision
  )
    refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  if (draft.sourceFingerprint !== fingerprintCanonicalValue(draft.source))
    refuse("DEFINITION_SOURCE_EVIDENCE_MISMATCH");
  return draft;
};

/** A draft supplied by a caller is parsed here, since nothing has parsed it yet. */
const validatedDraft = (
  context: SessionContext,
  supplied: StoredDefinitionDraft,
  command: PrepareDefinitionPublicationCommand,
): StoredDefinitionDraft => {
  const draft = storedDefinitionDraftSchema.safeParse(supplied);
  if (!draft.success) return refuse("DEFINITION_HISTORY_INVALID");
  return checkedDraft(context, draft.data, command);
};

/** A builder's draft compile: the draft as `validateCandidate` checks it, and its current version. */
export const validateDraftCandidate = (
  context: SessionContext,
  candidateInput: DefinitionDraftCandidate | undefined,
  command: PrepareDefinitionPublicationCommand,
): DefinitionDraftCandidate => {
  if (candidateInput === undefined) return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  // The reader parsed this draft with the stored-draft schema when it read it; it is not parsed again.
  const draft = checkedDraft(context, candidateInput.draft, command);
  if ((draft.publishedRevision === undefined) !== (candidateInput.currentReleaseVersion === null))
    refuse("DEFINITION_HISTORY_INVALID");
  return {
    draft,
    identities: candidateInput.identities,
    currentReleaseVersion: candidateInput.currentReleaseVersion,
  };
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
  // validatedDraft already authenticated this source's fingerprint.
  if (candidate.draft.publishedRevision !== latest?.publication.revision)
    refuse("DEFINITION_HISTORY_INVALID");
  return candidate;
};
