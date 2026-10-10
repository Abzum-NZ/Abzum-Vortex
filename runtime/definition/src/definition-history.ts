import "server-only";

import {
  definitionReleaseHistoryCommandSchema,
  definitionReleaseHistoryResultSchema,
  definitionReleaseMetadataCommandSchema,
  definitionReleaseMetadataResultSchema,
  applicationRootIdSchema,
  storedDefinitionSourceSchema,
  fingerprintSchema,
  revisionSchema,
  restoreDefinitionDraftCommandSchema,
  assertModuleContractPair,
  selectApplicationContractPair,
  selectStoredApplicationSourceContract,
  sessionContextSchema,
  sourceIdentityAssignmentV3Schema,
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
import { requireBuilderAuthority, type BuilderAuthority } from "./builder-authority";
import { canonicalJson, fingerprintCanonicalValue } from "./canonical-json";
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
import { extractStoredSourceIdentityRequirements } from "./source-identities";
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

const currentIdentityEvidenceSchema = sourceIdentityAssignmentV3Schema
  .extend({ ownerScope: z.string().min(1).max(500) })
  .strict();

type RestoreEvidence = StoredConsumerReleaseEvidence & {
  authoredSource: z.infer<typeof storedDefinitionSourceSchema>;
  sourceFingerprint: z.infer<typeof fingerprintSchema>;
  sourceContractVersion: "2.0.0" | "3.0.0";
  identityEvidence: readonly z.infer<typeof currentIdentityEvidenceSchema>[];
  humanDraftSnapshot?: HumanDraftSnapshot | undefined;
  humanCurrentDraft?: StoredDefinitionDraft | undefined;
};

const humanDraftSnapshotSchema = z
  .object({
    draftRevision: revisionSchema,
    sourceFingerprint: fingerprintSchema,
    anchorReleaseRevision: revisionSchema,
  })
  .strict();

type HumanDraftSnapshot = z.infer<typeof humanDraftSnapshotSchema>;

const humanRestoreDefinitionDraftCommandSchema = z
  .object({
    kind: z.literal("application"),
    rootId: applicationRootIdSchema,
    targetReleaseRevision: revisionSchema,
    expectedDraftRevision: revisionSchema,
    expectedSourceFingerprint: fingerprintSchema,
    expectedPublicationAnchor: revisionSchema,
  })
  .strict()
  .superRefine((command, refinement) => {
    if (command.expectedDraftRevision >= Number.MAX_SAFE_INTEGER)
      refinement.addIssue({
        code: "custom",
        path: ["expectedDraftRevision"],
        message: "Restoring a draft requires a safe next revision",
      });
    if (command.targetReleaseRevision > command.expectedPublicationAnchor)
      refinement.addIssue({
        code: "custom",
        path: ["targetReleaseRevision"],
        message: "A restore target must not exceed the shown publication anchor",
      });
  });

type HumanRestoreDefinitionDraftCommand = z.infer<
  typeof humanRestoreDefinitionDraftCommandSchema
>;

const restoreEvidenceSchema = storedConsumerReleaseEvidenceSchema
  .extend({
    authoredSource: storedDefinitionSourceSchema,
    sourceFingerprint: fingerprintSchema,
    sourceContractVersion: z.enum(["2.0.0", "3.0.0"]),
    identityEvidence: z.array(currentIdentityEvidenceSchema),
    humanDraftSnapshot: humanDraftSnapshotSchema.optional(),
    humanCurrentDraft: storedDefinitionDraftSchema.optional(),
  })
  .strict();

type VerifiedRestoreInput = Readonly<{
  source: z.infer<typeof storedDefinitionSourceSchema>;
  sourceFingerprint: string;
  identityRequirements: readonly unknown[];
  humanDraftBefore?: StoredDefinitionDraft;
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
    verifyRestored?: (draft: unknown) => Promise<StoredDefinitionDraft>,
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

const selectRestoreContract = (candidate: unknown): void => {
  const record = asCandidate(candidate);
  if (record?.kind !== "application" && record?.kind !== "module") return;
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
    if (sourceContractVersion !== intrinsicSourceContractVersion)
      throw new TypeError("Stored source version mismatch");
    if (record.kind === "application") {
      selectStoredApplicationSourceContract(sourceContractVersion, intrinsicSourceContractVersion);
      selectApplicationContractPair(sourceContractVersion, validationContractVersion);
    } else assertModuleContractPair(sourceContractVersion, validationContractVersion);
  } catch {
    throw new DefinitionHistoryError("DEFINITION_RELEASE_INTEGRITY_FAILED");
  }
};

const selectStoredDraftContract = (candidate: unknown): void => {
  const record = asCandidate(candidate);
  if (record?.kind !== "application" && record?.kind !== "module") return;
  const source = asCandidate(record.source);
  const sourceContractVersion = asString(record.sourceContractVersion);
  const intrinsicSourceContractVersion = asString(source?.source_contract_version);
  if (sourceContractVersion === undefined || intrinsicSourceContractVersion === undefined)
    throw new DefinitionHistoryError("INVALID_DEFINITION_HISTORY_RESULT");
  try {
    if (record.kind === "application")
      selectStoredApplicationSourceContract(sourceContractVersion, intrinsicSourceContractVersion);
    else {
      if (sourceContractVersion !== intrinsicSourceContractVersion)
        throw new TypeError("Stored source version mismatch");
      assertModuleContractPair(sourceContractVersion, sourceContractVersion);
    }
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
  const requirements = extractStoredSourceIdentityRequirements(release.authoredSource);
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
  // Select the exact source/canonical pair before either versioned payload is decoded.
  selectRestoreContract(candidate);
  const parsed = restoreEvidenceSchema.safeParse(candidate);
  if (!parsed.success) throw new DefinitionHistoryError("INVALID_DEFINITION_HISTORY_RESULT");
  return parsed.data;
};

const verifyRestoreEvidence = async (
  candidate: unknown,
  context: SessionContext,
  command: RestoreDefinitionDraftCommand,
  catalogue: DefinitionPublicationCatalogue,
  humanCommand?: HumanRestoreDefinitionDraftCommand,
): Promise<VerifiedRestoreInput> => {
  const release = parseRestoreEvidence(candidate);
  let humanDraftBefore: StoredDefinitionDraft | undefined;
  if (humanCommand !== undefined) {
    const snapshot = release.humanDraftSnapshot;
    const currentDraft = release.humanCurrentDraft;
    if (snapshot === undefined || currentDraft === undefined)
      throw new DefinitionHistoryError("INVALID_DEFINITION_HISTORY_RESULT");
    if (
      context.callerKind !== "human" ||
      currentDraft.kind !== "application" ||
      currentDraft.organizationId !== context.organizationId ||
      currentDraft.rootId !== humanCommand.rootId ||
      currentDraft.draftRevision !== humanCommand.expectedDraftRevision ||
      currentDraft.sourceFingerprint !== humanCommand.expectedSourceFingerprint ||
      (currentDraft.publishedRevision ?? undefined) !== humanCommand.expectedPublicationAnchor ||
      snapshot.draftRevision !== humanCommand.expectedDraftRevision ||
      snapshot.sourceFingerprint !== humanCommand.expectedSourceFingerprint ||
      snapshot.anchorReleaseRevision !== humanCommand.expectedPublicationAnchor ||
      release.releaseRevision > humanCommand.expectedPublicationAnchor
    )
      throw new DefinitionHistoryError("DEFINITION_DRAFT_STALE_OR_MISSING");
    humanDraftBefore = currentDraft;
  } else if (release.humanDraftSnapshot !== undefined || release.humanCurrentDraft !== undefined) {
    throw new DefinitionHistoryError("INVALID_DEFINITION_HISTORY_RESULT");
  }
  const source = release.authoredSource;
  if (
    release.organizationId !== context.organizationId ||
    release.kind !== command.kind ||
    release.rootId !== command.rootId ||
    release.releaseRevision !== command.targetReleaseRevision ||
    source.kind !== release.kind ||
    source.key !== release.key ||
    source.source_contract_version !== release.sourceContractVersion ||
    fingerprintCanonicalValue(source) !== release.sourceFingerprint ||
    !validateDefinitionSource(source).valid ||
    release.compilationOutput.kind === "connection_type" ||
    !hasAuthenticStoredCustomerDefinitionRelease({
      organizationId: release.organizationId,
      kind: release.kind,
      key: release.key,
      rootId: release.rootId,
      releaseVersion: release.releaseVersion,
      sourceContractVersion: release.sourceContractVersion,
      validationContractVersion: release.validationContractVersion,
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
      release.validationContractVersion,
    );
  } catch {
    throw new DefinitionHistoryError("DEFINITION_RESTORE_FAILED");
  }
  if (catalogueResult !== "valid")
    throw new DefinitionHistoryError("DEFINITION_RELEASE_INTEGRITY_FAILED");

  return {
    source,
    sourceFingerprint: release.sourceFingerprint,
    identityRequirements: extractStoredSourceIdentityRequirements(source),
    ...(humanDraftBefore === undefined ? {} : { humanDraftBefore }),
  };
};

const parseRestoredDraft = (
  candidate: unknown,
  context: SessionContext,
  command: RestoreDefinitionDraftCommand,
  verified: VerifiedRestoreInput,
): StoredDefinitionDraft => {
  const withoutNulls = withoutOptionalNulls(candidate);
  selectStoredDraftContract(withoutNulls);
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

const parseHumanRestoredDraft = (
  candidate: unknown,
  context: Extract<SessionContext, { callerKind: "human" }>,
  command: HumanRestoreDefinitionDraftCommand,
  verified: VerifiedRestoreInput,
  before: StoredDefinitionDraft,
): StoredDefinitionDraft => {
  const withoutNulls = withoutOptionalNulls(candidate);
  selectStoredDraftContract(withoutNulls);
  const parsed = storedDefinitionDraftSchema.safeParse(withoutNulls);
  if (!parsed.success) throw new DefinitionHistoryError("INVALID_DEFINITION_HISTORY_RESULT");
  const draft = parsed.data;
  if (
    draft.kind !== "application" ||
    before.kind !== "application" ||
    draft.organizationId !== context.organizationId ||
    draft.organizationId !== before.organizationId ||
    draft.rootId !== command.rootId ||
    draft.rootId !== before.rootId ||
    draft.key !== before.key ||
    draft.draftRevision !== command.expectedDraftRevision + 1 ||
    (draft.publishedRevision ?? undefined) !== command.expectedPublicationAnchor ||
    draft.sourceContractVersion !== verified.source.source_contract_version ||
    canonicalJson(draft.source) !== canonicalJson(verified.source) ||
    fingerprintCanonicalValue(draft.source) !== verified.sourceFingerprint ||
    draft.sourceFingerprint !== verified.sourceFingerprint ||
    draft.createdAt !== before.createdAt ||
    draft.createdBy !== before.createdBy ||
    draft.restoredFromReleaseRevision !== command.targetReleaseRevision ||
    draft.restoredFromSourceFingerprint !== verified.sourceFingerprint ||
    draft.restoredBy === undefined ||
    draft.restoredBy.toLowerCase() !== context.organizationAccountId.toLowerCase() ||
    draft.updatedBy.toLowerCase() !== context.organizationAccountId.toLowerCase() ||
    draft.restoreCorrelationId !== context.correlationId ||
    draft.restoredAt === undefined ||
    draft.updatedAt !== draft.restoredAt
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

const isOrganizationOnlyHumanContext = (
  context: SessionContext,
): context is Extract<SessionContext, { callerKind: "human" }> =>
  context.callerKind === "human" &&
  !Object.hasOwn(context, "applicationRootId") &&
  !Object.hasOwn(context, "delegatedContext") &&
  !Object.hasOwn(context, "supportContext");

/**
 * Restoring a release writes a new draft revision, so it is a draft change. The ordinary
 * organization-only HUMAN Application path requires a shown draft/source/publication snapshot;
 * the existing SYSTEM path still uses the required builder authority and its additional
 * `system_applications.manage` permission for a platform system application. Listing history and
 * reading release metadata change nothing and stay ungated.
 */
export const createDefinitionHistoryService = (
  repository: DefinitionHistoryRepository,
  catalogue: DefinitionPublicationCatalogue,
  authority: BuilderAuthority,
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
    if (asCandidate(contextCandidate)?.callerKind === "human") {
      const context = sessionContextSchema.safeParse(contextCandidate);
      if (!context.success || !isOrganizationOnlyHumanContext(context.data))
        throw new DefinitionHistoryError("DEFINITION_CONTEXT_REFUSED");
      const humanContext = context.data;
      const humanCommand = humanRestoreDefinitionDraftCommandSchema.safeParse(commandCandidate);
      if (!humanCommand.success)
        throw new DefinitionHistoryError("INVALID_DEFINITION_RESTORE_COMMAND");
      if (
        humanContext.organizationId.toLowerCase() !== authority.organizationId.toLowerCase()
      )
        throw new DefinitionHistoryError("DEFINITION_CONTEXT_REFUSED");
      await requireBuilderAuthority(authority, {
        kind: "draft_change",
        rootId: humanCommand.data.rootId,
      });

      const command: RestoreDefinitionDraftCommand = {
        kind: "application",
        rootId: humanCommand.data.rootId,
        targetReleaseRevision: humanCommand.data.targetReleaseRevision,
        expectedDraftRevision: humanCommand.data.expectedDraftRevision,
      };
      try {
        let verifiedRestore: VerifiedRestoreInput | undefined;
        let verificationCallbackCount = 0;
        let retainedDraft: StoredDefinitionDraft | undefined;
        const attempt = await repository.restore(
          humanContext,
          command,
          async (evidence) => {
            const verified = await verifyRestoreEvidence(
              evidence,
              humanContext,
              command,
              catalogue,
              humanCommand.data,
            );
            if (verified.humanDraftBefore === undefined)
              throw new DefinitionHistoryError("INVALID_DEFINITION_HISTORY_RESULT");
            verifiedRestore = verified;
            return verified;
          },
          async (draftCandidate) => {
            verificationCallbackCount += 1;
            if (
              verificationCallbackCount !== 1 ||
              verifiedRestore?.humanDraftBefore === undefined
            )
              throw new DefinitionHistoryError("INVALID_DEFINITION_HISTORY_RESULT");
            const draft = parseHumanRestoredDraft(
              draftCandidate,
              humanContext,
              humanCommand.data,
              verifiedRestore,
              verifiedRestore.humanDraftBefore,
            );
            retainedDraft = draft;
            return draft;
          },
        );
        if (attempt.outcome === "not_found")
          throw new DefinitionHistoryError("DEFINITION_RELEASE_NOT_FOUND");
        if (attempt.outcome === "stale")
          throw new DefinitionHistoryError("DEFINITION_DRAFT_STALE_OR_MISSING");
        if (
          verificationCallbackCount !== 1 ||
          retainedDraft === undefined ||
          attempt.draft !== retainedDraft
        )
          throw new DefinitionHistoryError("INVALID_DEFINITION_HISTORY_RESULT");
        return retainedDraft;
      } catch (error) {
        throw mapRepositoryFailure(error, "DEFINITION_RESTORE_FAILED");
      }
    }

    const command = restoreDefinitionDraftCommandSchema.safeParse(commandCandidate);
    if (!command.success) throw new DefinitionHistoryError("INVALID_DEFINITION_RESTORE_COMMAND");
    const context = sessionContextSchema.safeParse(contextCandidate);
    if (!context.success || !isLiveDefinitionSystemContext(context.data))
      throw new DefinitionHistoryError("DEFINITION_CONTEXT_REFUSED");
    // The authority decides for exactly one organisation; any other context is refused first.
    if (context.data.organizationId.toLowerCase() !== authority.organizationId.toLowerCase())
      throw new DefinitionHistoryError("DEFINITION_CONTEXT_REFUSED");
    await requireBuilderAuthority(authority, { kind: "draft_change", rootId: command.data.rootId });
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
