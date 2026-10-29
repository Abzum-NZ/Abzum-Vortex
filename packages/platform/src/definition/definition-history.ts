import "server-only";

import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import type { PlatformPermissionSource } from "../access/platform-permissions";
import {
  organizationAccessDeclarationSchema,
  type OrganizationAccessDeclaration,
} from "../access/organization-access-decision";
import {
  createImmutableDefinitionPublicationCatalogue,
  type ImmutableDefinitionPublicationCatalogueDefinition,
} from "./publication/read";
import { sessionContextSchema, type SessionContext } from "../access/identity-access";
import {
  applicationRootIdSchema,
  fingerprintSchema,
  revisionSchema,
} from "../catalogue/identifiers";
import {
  selectApplicationContractPair,
  selectStoredApplicationSourceContract,
} from "./application-contract-versions";
import { sourceIdentityAssignmentSchema } from "./definition-compilation-contracts";
import {
  definitionReleaseHistoryCommandSchema,
  definitionReleaseHistoryResultSchema,
  definitionReleaseMetadataCommandSchema,
  definitionReleaseMetadataResultSchema,
  restoreDefinitionDraftCommandSchema,
  type DefinitionReleaseHistoryCommand,
  type DefinitionReleaseHistoryResult,
  type DefinitionReleaseMetadataCommand,
  type DefinitionReleaseMetadataResult,
  type RestoreDefinitionDraftCommand,
} from "./definition-history-contracts";
import { assertModuleContractPair } from "./definition-source";
import {
  storedDefinitionSourceSchema,
  storedDefinitionDraftSchema,
  type StoredDefinitionDraft,
} from "./definition-store-contracts";
import { z } from "zod";
import { applicationSourceContractVersion } from "./application-contract-versions";
import { requireBuilderAuthority, type BuilderAuthority } from "./builder-authority";
import { canonicalJson, fingerprintCanonicalValue } from "./canonical-json-definition";
import {
  definitionReleaseManifestMatchesCanonicalContent,
  definitionReleaseModuleTargetsMatch,
  isDefinitionContextFailure,
  isLiveDefinitionSystemContext,
  storedConsumerReleaseEvidenceSchema,
  verifyDefinitionCatalogueDependencies,
  type StoredConsumerReleaseEvidence,
} from "./definition-consumer-read-definition";
import { hasAuthenticStoredCustomerDefinitionRelease } from "./definition-release-integrity";
import type { DefinitionPublicationCatalogue } from "./definition-publication-contracts";
import { extractStoredSourceIdentityRequirements } from "./source-identities";
import { validateDefinitionSource } from "./validation";
import {
  DefinitionError,
  classifyDatabaseError,
  unexpectedDefinitionFailure,
} from "./definition-error";

const definitionHistoryErrorCodes = [
  "INVALID_DEFINITION_HISTORY_COMMAND",
  "INVALID_DEFINITION_RESTORE_COMMAND",
  "INVALID_DEFINITION_HISTORY_RESULT",
  "DEFINITION_HISTORY_NOT_FOUND",
  "DEFINITION_RELEASE_NOT_FOUND",
  "DEFINITION_DRAFT_STALE_OR_MISSING",
  "DEFINITION_CONTEXT_REFUSED",
  "DEFINITION_STORED_DATA_INVALID",
  "DEFINITION_RELEASE_INTEGRITY_FAILED",
  "DEFINITION_DEPENDENCY_SUPERSEDED",
  "RELEASE_CONTRACT_SUPERSEDED",
  "DEFINITION_HISTORY_FAILED",
  "DEFINITION_RESTORE_FAILED",
] as const;

type DefinitionHistoryErrorCode = (typeof definitionHistoryErrorCodes)[number];

const currentIdentityEvidenceSchema = sourceIdentityAssignmentSchema
  .extend({ ownerScope: z.string().min(1).max(500) })
  .strict();

type RestoreEvidence = StoredConsumerReleaseEvidence & {
  authoredSource: z.infer<typeof storedDefinitionSourceSchema>;
  sourceFingerprint: z.infer<typeof fingerprintSchema>;
  sourceContractVersion: typeof applicationSourceContractVersion;
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

type HumanRestoreDefinitionDraftCommand = z.infer<typeof humanRestoreDefinitionDraftCommandSchema>;

const restoreEvidenceSchema = storedConsumerReleaseEvidenceSchema
  .extend({
    authoredSource: storedDefinitionSourceSchema,
    sourceFingerprint: fingerprintSchema,
    sourceContractVersion: z.literal(applicationSourceContractVersion),
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
    throw new DefinitionError("DEFINITION_RELEASE_INTEGRITY_FAILED");
  // A release published under an earlier definition contract stays as history; it is never
  // restored into a draft, which holds only the current contract.
  if (
    sourceContractVersion === intrinsicSourceContractVersion &&
    sourceContractVersion !== applicationSourceContractVersion
  )
    throw new DefinitionError("RELEASE_CONTRACT_SUPERSEDED");
  try {
    if (sourceContractVersion !== intrinsicSourceContractVersion)
      throw new TypeError("Stored source version mismatch");
    if (record.kind === "application") {
      selectStoredApplicationSourceContract(sourceContractVersion, intrinsicSourceContractVersion);
      selectApplicationContractPair(sourceContractVersion, validationContractVersion);
    } else assertModuleContractPair(sourceContractVersion, validationContractVersion);
  } catch (cause) {
    throw new DefinitionError("DEFINITION_RELEASE_INTEGRITY_FAILED", { cause });
  }
};

const selectStoredDraftContract = (candidate: unknown): void => {
  const record = asCandidate(candidate);
  if (record?.kind !== "application" && record?.kind !== "module") return;
  const source = asCandidate(record.source);
  const sourceContractVersion = asString(record.sourceContractVersion);
  const intrinsicSourceContractVersion = asString(source?.source_contract_version);
  if (sourceContractVersion === undefined || intrinsicSourceContractVersion === undefined)
    throw new DefinitionError("INVALID_DEFINITION_HISTORY_RESULT");
  try {
    if (record.kind === "application")
      selectStoredApplicationSourceContract(sourceContractVersion, intrinsicSourceContractVersion);
    else {
      if (sourceContractVersion !== intrinsicSourceContractVersion)
        throw new TypeError("Stored source version mismatch");
      assertModuleContractPair(sourceContractVersion, sourceContractVersion);
    }
  } catch (cause) {
    throw new DefinitionError("INVALID_DEFINITION_HISTORY_RESULT", { cause });
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
  if (!parsed.success) throw new DefinitionError("INVALID_DEFINITION_HISTORY_RESULT");
  if (
    parsed.data.organizationId !== context.organizationId ||
    parsed.data.kind !== command.kind ||
    parsed.data.rootId !== command.rootId
  )
    throw new DefinitionError("INVALID_DEFINITION_HISTORY_RESULT");
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
  if (!parsed.success) throw new DefinitionError("INVALID_DEFINITION_HISTORY_RESULT");
  if (
    parsed.data.organizationId !== context.organizationId ||
    parsed.data.kind !== command.kind ||
    parsed.data.rootId !== command.rootId ||
    parsed.data.metadata.releaseRevision !== command.releaseRevision
  )
    throw new DefinitionError("INVALID_DEFINITION_HISTORY_RESULT");
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
  if (!parsed.success) throw new DefinitionError("INVALID_DEFINITION_HISTORY_RESULT");
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
      throw new DefinitionError("INVALID_DEFINITION_HISTORY_RESULT");
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
      throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");
    humanDraftBefore = currentDraft;
  } else if (release.humanDraftSnapshot !== undefined || release.humanCurrentDraft !== undefined) {
    throw new DefinitionError("INVALID_DEFINITION_HISTORY_RESULT");
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
    !validateDefinitionSource(source, catalogue.permissions).valid ||
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
    throw new DefinitionError("DEFINITION_RELEASE_INTEGRITY_FAILED");

  let catalogueResult: Awaited<ReturnType<typeof verifyDefinitionCatalogueDependencies>>;
  try {
    catalogueResult = await verifyDefinitionCatalogueDependencies(
      release.dependencyManifest,
      catalogue,
      release.validationContractVersion,
    );
  } catch (cause) {
    throw new DefinitionError("DEFINITION_RESTORE_FAILED", { cause });
  }
  if (catalogueResult === "superseded")
    throw new DefinitionError("DEFINITION_DEPENDENCY_SUPERSEDED", {
      sentence:
        "Republish required: this release uses superseded platform definitions. Publish the current draft instead of restoring this release.",
    });
  if (catalogueResult !== "valid") throw new DefinitionError("DEFINITION_RELEASE_INTEGRITY_FAILED");

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
  if (!parsed.success) throw new DefinitionError("INVALID_DEFINITION_HISTORY_RESULT");
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
    throw new DefinitionError("INVALID_DEFINITION_HISTORY_RESULT");
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
  if (!parsed.success) throw new DefinitionError("INVALID_DEFINITION_HISTORY_RESULT");
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
    throw new DefinitionError("INVALID_DEFINITION_HISTORY_RESULT");
  return draft;
};

const mapRepositoryFailure = (
  error: unknown,
  fallback: "DEFINITION_HISTORY_FAILED" | "DEFINITION_RESTORE_FAILED",
): DefinitionError<DefinitionHistoryErrorCode> => {
  if (
    error instanceof DefinitionError &&
    (definitionHistoryErrorCodes as readonly string[]).includes(error.code)
  )
    return error;
  if (isDefinitionContextFailure(error))
    return new DefinitionError("DEFINITION_CONTEXT_REFUSED", { cause: error });
  if (classifyDatabaseError(error) === "conflict")
    return new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING", { cause: error });
  return unexpectedDefinitionFailure(fallback, error, "definition history");
};

type HistoryRow = DatabaseRow & { release_history: unknown };
type MetadataRow = DatabaseRow & { release_history_entry: unknown };
type RestoreEvidenceRow = DatabaseRow & { restore_evidence: unknown };
type RestoredDraftRow = DatabaseRow & { restored_draft: unknown };
type PermissionDecisionRow = DatabaseRow & {
  outcome: string;
  operation_key: string;
  target_kind: string;
  target_application_root_id: string | null;
  organization_id: string;
  organization_account_id: string;
  access_version: number | string;
  checked_at: string;
  valid_until: string;
  correlation_id: string;
  reason_code: string | null;
};
type HumanRestoreFenceRow = DatabaseRow & {
  context_is_current: boolean | null;
  evaluator_checked_at_is_current: boolean | null;
  permission_is_current: boolean | null;
  session_issued: boolean | null;
  session_unexpired: boolean | null;
  update_not_future: boolean | null;
  restoration_not_future: boolean | null;
};

const humanPermissionDeclaration = (
  permissions: PlatformPermissionSource,
): OrganizationAccessDeclaration => {
  const operationKey = "platform.organization.definition_drafts.manage";
  const permission = permissions.forKey(operationKey);
  if (permission === undefined) throw new Error("DEFINITION_DRAFTS_MANAGE_PERMISSION_UNAVAILABLE");
  return organizationAccessDeclarationSchema.parse({
    operationKey,
    action: {
      actionKind: permission.actionKind,
      ...(permission.namedAction === undefined ? {} : { namedAction: permission.namedAction }),
    },
    target: { kind: "organization" },
    requiredPermission: {
      ownerKind: "platform",
      ownerId: permissions.ownerId,
      permissionId: permission.permissionId,
    },
    recentAuthentication: { kind: "none" },
    authority: { kind: "permission" },
  });
};

const humanContextBindings = (
  context: Extract<SessionContext, { callerKind: "human" }>,
): readonly unknown[] => [
  context.callerKind,
  context.tenantId,
  context.organizationId,
  context.organizationAccountId,
  context.identityAuthorityId,
  context.identityId,
  context.sessionId,
  context.issuedAt,
  context.expiresAt,
  context.accessVersion,
  context.correlationId,
  context.authenticationStrength,
  context.accessTokenIssuedAt ?? null,
  context.primaryAuthenticatedAt ?? null,
  context.multiFactorAuthenticatedAt ?? null,
];

const parseHumanCurrentDraft = (candidate: unknown): StoredDefinitionDraft => {
  const parsed = storedDefinitionDraftSchema.safeParse(candidate);
  if (!parsed.success)
    throw unexpectedDefinitionFailure(
      "DEFINITION_STORED_DATA_INVALID",
      parsed.error,
      "stored human current draft",
    );
  return parsed.data;
};

const assertHumanRestoreCompletion = async (
  permissions: PlatformPermissionSource,
  transaction: RequestDatabaseTransaction,
  context: Extract<SessionContext, { callerKind: "human" }>,
  restored: StoredDefinitionDraft,
): Promise<void> => {
  if (restored.restoredAt === undefined)
    throw unexpectedDefinitionFailure(
      "DEFINITION_STORED_DATA_INVALID",
      new Error("restored draft has no restoredAt"),
      "restored draft",
    );
  const restoredAt = restored.restoredAt;
  const declaration = humanPermissionDeclaration(permissions);
  const decisions = await transaction.query<PermissionDecisionRow>`
    select decision.*
    from vortex_access.evaluate_organization_permission_eligibility(
      ${JSON.stringify(declaration)}::text::jsonb
    ) as decision
  `;
  const decision = one(decisions, "DEFINITION_RESTORE_AUTHORITY_UNAVAILABLE");
  if (
    decision.outcome !== "eligible" ||
    decision.operation_key !== declaration.operationKey ||
    decision.target_kind !== "organization" ||
    decision.target_application_root_id !== null ||
    decision.organization_id.toLowerCase() !== context.organizationId.toLowerCase() ||
    decision.organization_account_id.toLowerCase() !==
      context.organizationAccountId.toLowerCase() ||
    Number(decision.access_version) !== context.accessVersion ||
    decision.correlation_id.toLowerCase() !== context.correlationId.toLowerCase() ||
    decision.reason_code !== null
  )
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");

  const expectedBindings = JSON.stringify(humanContextBindings(context));
  const completionRows = await transaction.query<HumanRestoreFenceRow>`
    with final_context as materialized (
      select vortex_access.validated_human_request_context() as request_context
    ),
    final_binding as materialized (
      select
        final_context.request_context,
        (
          final_context.request_context ->> 'channel' = 'web'
          and not (final_context.request_context ? 'applicationRootId')
          and not (final_context.request_context ? 'delegatedContext')
          and not (final_context.request_context ? 'supportContext')
          and final_context.request_context - array[
            'callerKind',
            'tenantId',
            'organizationId',
            'applicationRootId',
            'sessionId',
            'issuedAt',
            'expiresAt',
            'accessVersion',
            'correlationId',
            'identityAuthorityId',
            'identityId',
            'organizationAccountId',
            'authenticationStrength',
            'accessTokenIssuedAt',
            'primaryAuthenticatedAt',
            'multiFactorAuthenticatedAt',
            'delegatedContext',
            'supportContext',
            'channel'
          ] = '{}'::jsonb
          and pg_catalog.jsonb_build_array(
            final_context.request_context -> 'callerKind',
            final_context.request_context -> 'tenantId',
            final_context.request_context -> 'organizationId',
            final_context.request_context -> 'organizationAccountId',
            final_context.request_context -> 'identityAuthorityId',
            final_context.request_context -> 'identityId',
            final_context.request_context -> 'sessionId',
            final_context.request_context -> 'issuedAt',
            final_context.request_context -> 'expiresAt',
            final_context.request_context -> 'accessVersion',
            final_context.request_context -> 'correlationId',
            final_context.request_context -> 'authenticationStrength',
            coalesce(final_context.request_context -> 'accessTokenIssuedAt', 'null'::jsonb),
            coalesce(final_context.request_context -> 'primaryAuthenticatedAt', 'null'::jsonb),
            coalesce(final_context.request_context -> 'multiFactorAuthenticatedAt', 'null'::jsonb)
          ) is not distinct from ${expectedBindings}::text::jsonb
        ) as context_is_current
      from final_context
    ),
    final_clock as materialized (
      select pg_catalog.clock_timestamp() as checked_at
      from final_binding
    )
    select
      final_binding.context_is_current,
      ${decision.checked_at}::timestamptz <= final_clock.checked_at
        as evaluator_checked_at_is_current,
      ${decision.valid_until}::timestamptz > final_clock.checked_at
        as permission_is_current,
      (final_binding.request_context ->> 'issuedAt')::timestamptz <= final_clock.checked_at
        as session_issued,
      (final_binding.request_context ->> 'expiresAt')::timestamptz > final_clock.checked_at
        as session_unexpired,
      ${restored.updatedAt}::timestamptz <= final_clock.checked_at as update_not_future,
      ${restoredAt}::timestamptz <= final_clock.checked_at as restoration_not_future
    from final_binding
    cross join final_clock
  `;
  const completion = one(completionRows, "DEFINITION_RESTORE_CONTEXT_UNAVAILABLE");
  if (
    completion.context_is_current !== true ||
    completion.evaluator_checked_at_is_current !== true ||
    completion.permission_is_current !== true ||
    completion.session_issued !== true ||
    completion.session_unexpired !== true ||
    completion.update_not_future !== true ||
    completion.restoration_not_future !== true
  )
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
};

const one = <Row extends DatabaseRow>(rows: readonly Row[], message: string): Row => {
  if (rows.length !== 1) throw new Error(message);
  return rows[0]!;
};

/**
 * The history's storage, in the request transaction. All restore reads and the conditional
 * mutation share it: the verification callback receives evidence only inside that transaction and
 * returns service-derived data that the database checks against its release row.
 */
const historyStorage = (
  transaction: RequestDatabaseTransaction,
  permissions: PlatformPermissionSource,
) => ({
  async list(command: DefinitionReleaseHistoryCommand): Promise<unknown | undefined> {
    const rows = await transaction.query<HistoryRow>`
      select vortex_definition.list_release_history(
        ${command.kind},
        ${command.rootId},
        ${command.pageSize},
        ${command.beforeReleaseRevision ?? null}
      ) as release_history
    `;
    const row = one(rows, "DEFINITION_HISTORY_STORAGE_INVALID");
    return row.release_history === null ? undefined : row.release_history;
  },

  async readMetadata(command: DefinitionReleaseMetadataCommand): Promise<unknown | undefined> {
    const rows = await transaction.query<MetadataRow>`
      select vortex_definition.read_release_history_entry(
        ${command.kind},
        ${command.rootId},
        ${command.releaseRevision}
      ) as release_history_entry
    `;
    const row = one(rows, "DEFINITION_HISTORY_STORAGE_INVALID");
    return row.release_history_entry === null ? undefined : row.release_history_entry;
  },

  async restore(
    context: SessionContext,
    command: RestoreDefinitionDraftCommand,
    verify: (evidence: unknown) => Promise<VerifiedRestoreInput>,
    verifyRestored?: (draft: unknown) => Promise<StoredDefinitionDraft>,
  ): Promise<RestoreAttempt> {
    const evidenceRows = await transaction.query<RestoreEvidenceRow>`
      select vortex_definition.read_release_for_restore(
        ${command.kind},
        ${command.rootId},
        ${command.targetReleaseRevision}
      ) as restore_evidence
    `;
    const evidence = one(evidenceRows, "DEFINITION_RESTORE_STORAGE_INVALID").restore_evidence;
    if (evidence === null) return { outcome: "not_found" } as const;
    const verified = await verify(evidence);
    const restoredRows = await transaction.query<RestoredDraftRow>`
      select vortex_definition.restore_release_draft(
        ${command.kind},
        ${command.rootId},
        ${command.targetReleaseRevision},
        ${command.expectedDraftRevision},
        ${verified.sourceFingerprint},
        ${JSON.stringify(verified.identityRequirements)}::text::jsonb
      ) as restored_draft
    `;
    const restored = one(restoredRows, "DEFINITION_RESTORE_STORAGE_INVALID").restored_draft;
    if (restored === null) return { outcome: "stale" } as const;
    if (verifyRestored === undefined) return { outcome: "restored", draft: restored } as const;
    if (!isOrganizationOnlyHumanContext(context))
      throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");

    const verifiedDraft = await verifyRestored(restored);
    const currentEvidenceRows = await transaction.query<RestoreEvidenceRow>`
      select vortex_definition.read_release_for_restore(
        ${command.kind},
        ${command.rootId},
        ${command.targetReleaseRevision}
      ) as restore_evidence
    `;
    const currentEvidence = one(
      currentEvidenceRows,
      "DEFINITION_RESTORE_STORAGE_INVALID",
    ).restore_evidence;
    const currentEvidenceRecord = asCandidate(currentEvidence);
    if (
      currentEvidenceRecord === undefined ||
      currentEvidenceRecord.humanDraftSnapshot === undefined ||
      currentEvidenceRecord.humanCurrentDraft === undefined
    )
      throw unexpectedDefinitionFailure(
        "DEFINITION_STORED_DATA_INVALID",
        new Error("restore evidence lacks the human draft snapshot or current draft"),
        "restore release evidence",
      );
    const currentDraft = parseHumanCurrentDraft(currentEvidenceRecord.humanCurrentDraft);
    if (
      canonicalJson(currentDraft) !== canonicalJson(verifiedDraft) ||
      currentEvidenceRecord.humanDraftSnapshot === null
    )
      throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");
    const snapshot = asCandidate(currentEvidenceRecord.humanDraftSnapshot);
    if (
      snapshot === undefined ||
      snapshot.draftRevision !== verifiedDraft.draftRevision ||
      snapshot.sourceFingerprint !== verifiedDraft.sourceFingerprint ||
      snapshot.anchorReleaseRevision !== verifiedDraft.publishedRevision
    )
      throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");

    await assertHumanRestoreCompletion(permissions, transaction, context, verifiedDraft);
    return { outcome: "restored", draft: verifiedDraft } as const;
  },
});

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
  catalogueDefinition: ImmutableDefinitionPublicationCatalogueDefinition,
  transaction: RequestDatabaseTransaction,
  authority: BuilderAuthority,
) => {
  const repository = historyStorage(transaction, catalogueDefinition.permissions);
  const catalogue: DefinitionPublicationCatalogue =
    createImmutableDefinitionPublicationCatalogue(catalogueDefinition);
  return {
    async list(
      contextCandidate: SessionContext,
      commandCandidate: unknown,
    ): Promise<DefinitionReleaseHistoryResult> {
      const command = definitionReleaseHistoryCommandSchema.safeParse(commandCandidate);
      if (!command.success) throw new DefinitionError("INVALID_DEFINITION_HISTORY_COMMAND");
      const context = sessionContextSchema.safeParse(contextCandidate);
      if (!context.success || !isLiveDefinitionSystemContext(context.data))
        throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
      try {
        const result = parseHistory(
          await repository.list(command.data),
          context.data,
          command.data,
        );
        if (result === undefined) throw new DefinitionError("DEFINITION_HISTORY_NOT_FOUND");
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
      if (!command.success) throw new DefinitionError("INVALID_DEFINITION_HISTORY_COMMAND");
      const context = sessionContextSchema.safeParse(contextCandidate);
      if (!context.success || !isLiveDefinitionSystemContext(context.data))
        throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
      try {
        const result = parseMetadata(
          await repository.readMetadata(command.data),
          context.data,
          command.data,
        );
        if (result === undefined) throw new DefinitionError("DEFINITION_RELEASE_NOT_FOUND");
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
          throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
        const humanContext = context.data;
        const humanCommand = humanRestoreDefinitionDraftCommandSchema.safeParse(commandCandidate);
        if (!humanCommand.success) throw new DefinitionError("INVALID_DEFINITION_RESTORE_COMMAND");
        if (humanContext.organizationId.toLowerCase() !== authority.organizationId.toLowerCase())
          throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
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
                throw new DefinitionError("INVALID_DEFINITION_HISTORY_RESULT");
              verifiedRestore = verified;
              return verified;
            },
            async (draftCandidate) => {
              verificationCallbackCount += 1;
              if (
                verificationCallbackCount !== 1 ||
                verifiedRestore?.humanDraftBefore === undefined
              )
                throw new DefinitionError("INVALID_DEFINITION_HISTORY_RESULT");
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
            throw new DefinitionError("DEFINITION_RELEASE_NOT_FOUND");
          if (attempt.outcome === "stale")
            throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");
          if (
            verificationCallbackCount !== 1 ||
            retainedDraft === undefined ||
            attempt.draft !== retainedDraft
          )
            throw new DefinitionError("INVALID_DEFINITION_HISTORY_RESULT");
          return retainedDraft;
        } catch (error) {
          throw mapRepositoryFailure(error, "DEFINITION_RESTORE_FAILED");
        }
      }

      const command = restoreDefinitionDraftCommandSchema.safeParse(commandCandidate);
      if (!command.success) throw new DefinitionError("INVALID_DEFINITION_RESTORE_COMMAND");
      const context = sessionContextSchema.safeParse(contextCandidate);
      if (!context.success || !isLiveDefinitionSystemContext(context.data))
        throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
      // The authority decides for exactly one organisation; any other context is refused first.
      if (context.data.organizationId.toLowerCase() !== authority.organizationId.toLowerCase())
        throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
      await requireBuilderAuthority(authority, {
        kind: "draft_change",
        rootId: command.data.rootId,
      });
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
          throw new DefinitionError("DEFINITION_RELEASE_NOT_FOUND");
        if (attempt.outcome === "stale")
          throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");
        if (verifiedRestore === undefined)
          throw new DefinitionError("INVALID_DEFINITION_HISTORY_RESULT");
        return parseRestoredDraft(attempt.draft, context.data, command.data, verifiedRestore);
      } catch (error) {
        throw mapRepositoryFailure(error, "DEFINITION_RESTORE_FAILED");
      }
    },
  };
};
