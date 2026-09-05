import "server-only";

import {
  definitionReleaseHistoryCommandSchema,
  definitionReleaseHistoryResultSchema,
  definitionReleaseMetadataCommandSchema,
  definitionReleaseMetadataResultSchema,
  definitionSourceDocumentSchema,
  fingerprintSchema,
  restoreDefinitionDraftCommandSchema,
  selectApplicationContractPair,
  selectStoredApplicationSourceContract,
  sessionContextSchema,
  sourceIdentityAssignmentSchema,
  storedDefinitionDraftSchema,
  type DefinitionReleaseHistoryCommand,
  type DefinitionReleaseHistoryResult,
  type DefinitionReleaseMetadataCommand,
  type DefinitionReleaseMetadataResult,
  type RestoreDefinitionDraftCommand,
  type SessionContext,
  type StoredDefinitionDraft,
} from "@vortex/contracts";
import { z } from "zod";
import { fingerprintCanonicalValue } from "./canonical-json";
import {
  definitionReleaseManifestMatchesCanonicalContent,
  definitionReleaseModuleTargetsMatch,
  isDefinitionContextFailure,
  isLiveDefinitionSystemContext,
  storedConsumerReleaseEvidenceSchema,
  verifyDefinitionCatalogueDependencies,
  type StoredConsumerReleaseEvidence,
} from "./definition-consumer-read";
import { hasAuthenticStoredCustomerDefinitionRelease } from "./definition-release-integrity";
import type { DefinitionPublicationCatalogue } from "./definition-publication";
import { extractSourceIdentityRequirements } from "./source-identities";
import { validateDefinitionSource } from "./validation";

export const definitionHistoryErrorCodes = [
  "INVALID_DEFINITION_HISTORY_COMMAND",
  "INVALID_DEFINITION_RESTORE_COMMAND",
  "INVALID_DEFINITION_HISTORY_RESULT",
  "DEFINITION_HISTORY_NOT_FOUND",
  "DEFINITION_RELEASE_NOT_FOUND",
  "DEFINITION_DRAFT_STALE_OR_MISSING",
  "DEFINITION_CONTEXT_REFUSED",
  "DEFINITION_RELEASE_INTEGRITY_FAILED",
  "DEFINITION_HISTORY_FAILED",
  "DEFINITION_RESTORE_FAILED",
] as const;

export type DefinitionHistoryErrorCode = (typeof definitionHistoryErrorCodes)[number];

export class DefinitionHistoryError extends Error {
  readonly code: DefinitionHistoryErrorCode;

  constructor(code: DefinitionHistoryErrorCode) {
    super(code);
    this.name = "DefinitionHistoryError";
    this.code = code;
  }
}

const currentIdentityEvidenceSchema = sourceIdentityAssignmentSchema
  .extend({ ownerScope: z.string().min(1).max(500) })
  .strict();

type RestoreEvidence = StoredConsumerReleaseEvidence & {
  authoredSource: z.infer<typeof definitionSourceDocumentSchema>;
  sourceFingerprint: z.infer<typeof fingerprintSchema>;
  sourceContractVersion: "1.0.0";
  identityEvidence: readonly z.infer<typeof currentIdentityEvidenceSchema>[];
};

const restoreEvidenceSchema = storedConsumerReleaseEvidenceSchema
  .extend({
    authoredSource: definitionSourceDocumentSchema,
    sourceFingerprint: fingerprintSchema,
    sourceContractVersion: z.literal("1.0.0"),
    identityEvidence: z.array(currentIdentityEvidenceSchema),
  })
  .strict();

type VerifiedRestoreInput = Readonly<{
  sourceFingerprint: string;
  identityRequirements: readonly unknown[];
}>;

type RestoreAttempt =
  | Readonly<{ outcome: "not_found" }>
  | Readonly<{ outcome: "stale" }>
  | Readonly<{ outcome: "restored"; draft: unknown }>;

/** Internal persistence boundary. It is intentionally not exported from the package root. */
export interface DefinitionHistoryRepository {
  list(
    context: SessionContext,
    command: DefinitionReleaseHistoryCommand,
  ): Promise<unknown | undefined>;
  readMetadata(
    context: SessionContext,
    command: DefinitionReleaseMetadataCommand,
  ): Promise<unknown | undefined>;
  restore(
    context: SessionContext,
    command: RestoreDefinitionDraftCommand,
    verify: (evidence: unknown) => Promise<VerifiedRestoreInput>,
  ): Promise<RestoreAttempt>;
}

const asCandidate = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const withoutOptionalNulls = (candidate: unknown): unknown => {
  const record = asCandidate(candidate);
  if (record === undefined) return candidate;
  return Object.fromEntries(
    Object.entries(record).filter(
      ([key, value]) =>
        value !== null ||
        ![
          "currentReleaseRevision",
          "nextBeforeReleaseRevision",
          "publishedRevision",
          "restoredFromReleaseRevision",
          "restoredFromSourceFingerprint",
          "restoredBy",
          "restoredAt",
          "restoreCorrelationId",
        ].includes(key),
    ),
  );
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const selectApplicationRestoreContract = (candidate: unknown): void => {
  const record = asCandidate(candidate);
  if (record?.kind !== "application") return;
  const source = asCandidate(record.authoredSource);
  const sourceContractVersion = asString(record.sourceContractVersion);
  const validationContractVersion = asString(record.validationContractVersion);
  const intrinsicSourceContractVersion = asString(source?.source_contract_version);
  if (
    sourceContractVersion === undefined ||
    validationContractVersion === undefined ||
    intrinsicSourceContractVersion === undefined
  )
    throw new DefinitionHistoryError("DEFINITION_RELEASE_INTEGRITY_FAILED");
  try {
    selectStoredApplicationSourceContract(sourceContractVersion, intrinsicSourceContractVersion);
    selectApplicationContractPair(sourceContractVersion, validationContractVersion);
  } catch {
    throw new DefinitionHistoryError("DEFINITION_RELEASE_INTEGRITY_FAILED");
  }
};

const selectStoredApplicationDraftContract = (candidate: unknown): void => {
  const record = asCandidate(candidate);
  if (record?.kind !== "application") return;
  const source = asCandidate(record.source);
  const sourceContractVersion = asString(record.sourceContractVersion);
  const intrinsicSourceContractVersion = asString(source?.source_contract_version);
  if (sourceContractVersion === undefined || intrinsicSourceContractVersion === undefined)
    throw new DefinitionHistoryError("INVALID_DEFINITION_HISTORY_RESULT");
  try {
    selectStoredApplicationSourceContract(sourceContractVersion, intrinsicSourceContractVersion);
  } catch {
    throw new DefinitionHistoryError("INVALID_DEFINITION_HISTORY_RESULT");
  }
};

const parseHistory = (
  candidate: unknown,
  context: SessionContext,
  command: DefinitionReleaseHistoryCommand,
): DefinitionReleaseHistoryResult | undefined => {
  if (candidate === undefined) return undefined;
  const parsed = definitionReleaseHistoryResultSchema.safeParse({
    ...asCandidate(withoutOptionalNulls(candidate)),
    correlationId: context.correlationId,
  });
  if (!parsed.success) throw new DefinitionHistoryError("INVALID_DEFINITION_HISTORY_RESULT");
  if (
    parsed.data.organizationId !== context.organizationId ||
    parsed.data.kind !== command.kind ||
    parsed.data.rootId !== command.rootId
  )
    throw new DefinitionHistoryError("INVALID_DEFINITION_HISTORY_RESULT");
  return parsed.data;
};

const parseMetadata = (
  candidate: unknown,
  context: SessionContext,
  command: DefinitionReleaseMetadataCommand,
): DefinitionReleaseMetadataResult | undefined => {
  if (candidate === undefined) return undefined;
  const record = asCandidate(withoutOptionalNulls(candidate));
  const { entry, ...metadataResult } = record ?? {};
  const parsed = definitionReleaseMetadataResultSchema.safeParse({
    ...metadataResult,
    metadata: entry,
    correlationId: context.correlationId,
  });
  if (!parsed.success) throw new DefinitionHistoryError("INVALID_DEFINITION_HISTORY_RESULT");
  if (
    parsed.data.organizationId !== context.organizationId ||
    parsed.data.kind !== command.kind ||
    parsed.data.rootId !== command.rootId ||
    parsed.data.metadata.releaseRevision !== command.releaseRevision
  )
    throw new DefinitionHistoryError("INVALID_DEFINITION_HISTORY_RESULT");
  return parsed.data;
};

const identifierKey = (identity: {
  definitionKey: string;
  scope: string;
  kind: string;
  componentOwner: string;
  alias: string;
}): string =>
  JSON.stringify([
    identity.definitionKey,
    identity.scope,
    identity.kind,
    identity.componentOwner,
    identity.alias,
  ]);

const ownerIdentifierKey = (identity: {
  definitionKey: string;
  ownerScope: string;
  scope: string;
  kind: string;
  componentOwner: string;
  alias: string;
}): string =>
  JSON.stringify([
    identity.definitionKey,
    identity.ownerScope,
    identity.scope,
    identity.kind,
    identity.componentOwner,
    identity.alias,
  ]);

const identitiesMatchSource = (release: RestoreEvidence): boolean => {
  const requirements = extractSourceIdentityRequirements(release.authoredSource);
  const expected = requirements.flatMap((requirement) =>
    requirement.aliases.map((alias) => ({
      plain: identifierKey({
        definitionKey: requirement.definitionKey,
        scope: requirement.scope,
        kind: requirement.kind,
        componentOwner: requirement.componentOwner,
        alias,
      }),
      owner: ownerIdentifierKey({
        definitionKey: requirement.definitionKey,
        ownerScope: requirement.ownerScope,
        scope: requirement.scope,
        kind: requirement.kind,
        componentOwner: requirement.componentOwner,
        alias,
      }),
    })),
  );
  if (
    new Set(expected.map((entry) => entry.plain)).size !== expected.length ||
    new Set(expected.map((entry) => entry.owner)).size !== expected.length
  )
    return false;

  const snapshot = new Map<string, string>();
  for (const identity of release.resolutionSnapshot.identities) {
    const key = identifierKey(identity);
    if (snapshot.has(key)) return false;
    snapshot.set(key, String(identity.identifier));
  }
  const current = new Map<string, string>();
  for (const identity of release.identityEvidence) {
    const key = ownerIdentifierKey(identity);
    if (current.has(key)) return false;
    current.set(key, String(identity.identifier));
  }
  return expected.every((entry) => {
    const snapshotIdentifier = snapshot.get(entry.plain);
    const currentIdentifier = current.get(entry.owner);
    return (
      snapshotIdentifier !== undefined &&
      currentIdentifier !== undefined &&
      snapshotIdentifier === currentIdentifier
    );
  });
};

const parseRestoreEvidence = (candidate: unknown): RestoreEvidence => {
  // Select the Application source/canonical pair before either V1 payload is decoded.
  selectApplicationRestoreContract(candidate);
  const parsed = restoreEvidenceSchema.safeParse(candidate);
  if (!parsed.success) throw new DefinitionHistoryError("INVALID_DEFINITION_HISTORY_RESULT");
  return parsed.data;
};

const verifyRestoreEvidence = async (
  candidate: unknown,
  context: SessionContext,
  command: RestoreDefinitionDraftCommand,
  catalogue: DefinitionPublicationCatalogue,
): Promise<VerifiedRestoreInput> => {
  const release = parseRestoreEvidence(candidate);
  const source = release.authoredSource;
  if (
    release.organizationId !== context.organizationId ||
    release.kind !== command.kind ||
    release.rootId !== command.rootId ||
    release.releaseRevision !== command.targetReleaseRevision ||
    source.kind !== release.kind ||
    source.key !== release.key ||
    source.source_contract_version !== release.sourceContractVersion ||
    release.sourceContractVersion !== "1.0.0" ||
    fingerprintCanonicalValue(source) !== release.sourceFingerprint ||
    !validateDefinitionSource(source).valid ||
    release.compilationOutput.kind === "connection_type" ||
    !hasAuthenticStoredCustomerDefinitionRelease({
      organizationId: release.organizationId,
      kind: release.kind,
      key: release.key,
      rootId: release.rootId,
      releaseVersion: release.releaseVersion,
      contentFingerprint: release.contentFingerprint,
      resolutionFingerprint: release.resolutionFingerprint,
      compilationOutput: release.compilationOutput,
      resolutionSnapshot: release.resolutionSnapshot,
    }) ||
    !definitionReleaseManifestMatchesCanonicalContent(release) ||
    !definitionReleaseModuleTargetsMatch(release) ||
    !identitiesMatchSource(release)
  )
    throw new DefinitionHistoryError("DEFINITION_RELEASE_INTEGRITY_FAILED");

  let catalogueResult: Awaited<ReturnType<typeof verifyDefinitionCatalogueDependencies>>;
  try {
    catalogueResult = await verifyDefinitionCatalogueDependencies(
      release.dependencyManifest,
      catalogue,
    );
  } catch {
    throw new DefinitionHistoryError("DEFINITION_RESTORE_FAILED");
  }
  if (catalogueResult !== "valid")
    throw new DefinitionHistoryError("DEFINITION_RELEASE_INTEGRITY_FAILED");

  return {
    sourceFingerprint: release.sourceFingerprint,
    identityRequirements: extractSourceIdentityRequirements(source),
  };
};

const parseRestoredDraft = (
  candidate: unknown,
  context: SessionContext,
  command: RestoreDefinitionDraftCommand,
  verified: VerifiedRestoreInput,
): StoredDefinitionDraft => {
  const withoutNulls = withoutOptionalNulls(candidate);
  selectStoredApplicationDraftContract(withoutNulls);
  const parsed = storedDefinitionDraftSchema.safeParse(withoutNulls);
  if (!parsed.success) throw new DefinitionHistoryError("INVALID_DEFINITION_HISTORY_RESULT");
  const draft = parsed.data;
  const systemActorId = context.callerKind === "system" ? context.systemActorId : undefined;
  if (
    command.expectedDraftRevision >= Number.MAX_SAFE_INTEGER ||
    draft.organizationId !== context.organizationId ||
    draft.kind !== command.kind ||
    draft.rootId !== command.rootId ||
    draft.draftRevision !== command.expectedDraftRevision + 1 ||
    draft.restoredFromReleaseRevision !== command.targetReleaseRevision ||
    draft.restoredFromSourceFingerprint !== verified.sourceFingerprint ||
    draft.restoredBy !== systemActorId ||
    draft.restoreCorrelationId !== context.correlationId ||
    draft.source.kind !== draft.kind ||
    draft.source.key !== draft.key ||
    draft.source.source_contract_version !== draft.sourceContractVersion ||
    fingerprintCanonicalValue(draft.source) !== draft.sourceFingerprint ||
    draft.sourceFingerprint !== verified.sourceFingerprint
  )
    throw new DefinitionHistoryError("INVALID_DEFINITION_HISTORY_RESULT");
  return draft;
};

const mapRepositoryFailure = (
  error: unknown,
  fallback: "DEFINITION_HISTORY_FAILED" | "DEFINITION_RESTORE_FAILED",
): DefinitionHistoryError => {
  if (error instanceof DefinitionHistoryError) return error;
  if (isDefinitionContextFailure(error))
    return new DefinitionHistoryError("DEFINITION_CONTEXT_REFUSED");
  const databaseCode =
    error !== null && typeof error === "object" && "code" in error ? String(error.code) : undefined;
  if (databaseCode === "40001")
    return new DefinitionHistoryError("DEFINITION_DRAFT_STALE_OR_MISSING");
  return new DefinitionHistoryError(fallback);
};

export const createDefinitionHistoryService = (
  repository: DefinitionHistoryRepository,
  catalogue: DefinitionPublicationCatalogue,
) => ({
  async list(
    contextCandidate: SessionContext,
    commandCandidate: unknown,
  ): Promise<DefinitionReleaseHistoryResult> {
    const command = definitionReleaseHistoryCommandSchema.safeParse(commandCandidate);
    if (!command.success) throw new DefinitionHistoryError("INVALID_DEFINITION_HISTORY_COMMAND");
    const context = sessionContextSchema.safeParse(contextCandidate);
    if (!context.success || !isLiveDefinitionSystemContext(context.data))
      throw new DefinitionHistoryError("DEFINITION_CONTEXT_REFUSED");
    try {
      const result = parseHistory(
        await repository.list(context.data, command.data),
        context.data,
        command.data,
      );
      if (result === undefined) throw new DefinitionHistoryError("DEFINITION_HISTORY_NOT_FOUND");
      return result;
    } catch (error) {
      throw mapRepositoryFailure(error, "DEFINITION_HISTORY_FAILED");
    }
  },

  async readMetadata(
    contextCandidate: SessionContext,
    commandCandidate: unknown,
  ): Promise<DefinitionReleaseMetadataResult> {
    const command = definitionReleaseMetadataCommandSchema.safeParse(commandCandidate);
    if (!command.success) throw new DefinitionHistoryError("INVALID_DEFINITION_HISTORY_COMMAND");
    const context = sessionContextSchema.safeParse(contextCandidate);
    if (!context.success || !isLiveDefinitionSystemContext(context.data))
      throw new DefinitionHistoryError("DEFINITION_CONTEXT_REFUSED");
    try {
      const result = parseMetadata(
        await repository.readMetadata(context.data, command.data),
        context.data,
        command.data,
      );
      if (result === undefined) throw new DefinitionHistoryError("DEFINITION_RELEASE_NOT_FOUND");
      return result;
    } catch (error) {
      throw mapRepositoryFailure(error, "DEFINITION_HISTORY_FAILED");
    }
  },

  async restoreDraft(
    contextCandidate: SessionContext,
    commandCandidate: unknown,
  ): Promise<StoredDefinitionDraft> {
    const command = restoreDefinitionDraftCommandSchema.safeParse(commandCandidate);
    if (!command.success) throw new DefinitionHistoryError("INVALID_DEFINITION_RESTORE_COMMAND");
    const context = sessionContextSchema.safeParse(contextCandidate);
    if (!context.success || !isLiveDefinitionSystemContext(context.data))
      throw new DefinitionHistoryError("DEFINITION_CONTEXT_REFUSED");
    try {
      let verifiedRestore: VerifiedRestoreInput | undefined;
      const attempt = await repository.restore(context.data, command.data, async (evidence) => {
        const verified = await verifyRestoreEvidence(
          evidence,
          context.data,
          command.data,
          catalogue,
        );
        verifiedRestore = verified;
        return verified;
      });
      if (attempt.outcome === "not_found")
        throw new DefinitionHistoryError("DEFINITION_RELEASE_NOT_FOUND");
      if (attempt.outcome === "stale")
        throw new DefinitionHistoryError("DEFINITION_DRAFT_STALE_OR_MISSING");
      if (verifiedRestore === undefined)
        throw new DefinitionHistoryError("INVALID_DEFINITION_HISTORY_RESULT");
      return parseRestoredDraft(attempt.draft, context.data, command.data, verifiedRestore);
    } catch (error) {
      throw mapRepositoryFailure(error, "DEFINITION_RESTORE_FAILED");
    }
  },
});
