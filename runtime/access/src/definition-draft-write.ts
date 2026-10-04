import "server-only";

import { z } from "zod";
import {
  applicationSourceDocumentV2Schema,
  applicationRootIdSchema,
  canonicalJson,
  correlationIdSchema,
  createDefinitionRootCommandSchema,
  databaseRevision,
  databaseTimestamp,
  organizationAccessDeclarationSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  organizationPermissionEligibilitySchema,
  revisionSchema,
  sameId,
  saveDefinitionDraftCommandSchema,
  storedDefinitionDraftSchema,
  tenantIdSchema,
  timestampSchema,
  type ApplicationSourceDocumentV2,
  type IdentitySession,
  type SelectedOrganizationScope,
  type StoredDefinitionDraft,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  BuilderAuthorityError,
  createDefinitionStore,
  DefinitionStoreError,
  fingerprintCanonicalValue,
  readApplicationDefinitionDraft,
  validateDefinitionSource,
  type StoredApplicationDefinitionDraft,
} from "@vortex/definition";
import { platformPermissionDeclarations, platformPermissionOwnerId } from "@vortex/modules";
import { createBuilderAuthority, type BuilderTargetFactsReader } from "./builder-authority";
import { createHumanOrganizationRequestService } from "./human-organization-request";

export type HumanApplicationDraftWriteResult =
  | Readonly<{ kind: "available"; draft: StoredApplicationDefinitionDraft }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

export type HumanApplicationDraftWriterDependencies = Readonly<{
  requests: ReturnType<typeof createHumanOrganizationRequestService>;
}>;

function invalidResult(): never {
  throw new DefinitionStoreError("INVALID_DEFINITION_STORAGE_RESULT");
}

type ClassificationRow = DatabaseRow & { outcome: unknown; application_origin_kind: unknown };

/** Unknown, missing, foreign and wrong-kind roots share one neutral conflict. */
const targetFacts: BuilderTargetFactsReader = async (transaction, _scope, rootId) => {
  if (rootId === undefined) return { isSystemApplication: false };
  const rows = await transaction.query<ClassificationRow>`
    select outcome, application_origin_kind
    from vortex_definition.read_builder_application_root_classification(${rootId}::uuid)
  `;
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) invalidResult();
  if (row.outcome === "unavailable" && row.application_origin_kind === null)
    throw new DefinitionStoreError("DEFINITION_DRAFT_STALE_OR_MISSING");
  if (
    row.outcome !== "available" ||
    (row.application_origin_kind !== "ordinary" &&
      row.application_origin_kind !== "platform_system_application")
  )
    invalidResult();
  return { isSystemApplication: row.application_origin_kind === "platform_system_application" };
};

const liveContextSchema = z
  .object({
    callerKind: z.literal("human"),
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    accessVersion: revisionSchema,
    correlationId: correlationIdSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    // Unpublished drafts use organization-only selection, never installed Application scope.
    applicationRootId: z.never().optional(),
  })
  .strip();

type CompletionRow = DatabaseRow & {
  request_context: unknown;
  outcome: unknown;
  operation_key: unknown;
  target_kind: unknown;
  target_application_root_id: unknown;
  organization_id: unknown;
  organization_account_id: unknown;
  access_version: unknown;
  checked_at: unknown;
  valid_until: unknown;
  correlation_id: unknown;
  reason_code: unknown;
  completed_at: unknown;
};

const databaseClock = async (transaction: RequestDatabaseTransaction): Promise<number> => {
  const rows = await transaction.query<DatabaseRow>`
    select pg_catalog.clock_timestamp() as completed_at
  `;
  const completedAt = timestampSchema.safeParse(databaseTimestamp(rows[0]?.completed_at));
  if (rows.length !== 1 || !completedAt.success) invalidResult();
  const instant = Date.parse(completedAt.data);
  if (!Number.isFinite(instant)) invalidResult();
  return instant;
};

/** Re-evaluate after result validation; a saved row alone is never permission evidence. */
const assertLiveCompletion = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  draft: StoredApplicationDefinitionDraft,
): Promise<void> => {
  const facts = await targetFacts(transaction, scope, draft.rootId);
  const keys = [
    "platform.organization.definition_drafts.manage",
    ...(facts.isSystemApplication ? ["platform.organization.system_applications.manage"] : []),
  ];
  let deadline = Number.POSITIVE_INFINITY;
  for (const key of keys) {
    const permission = platformPermissionDeclarations.find((entry) => entry.key === key);
    if (permission === undefined) throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
    const declaration = organizationAccessDeclarationSchema.parse({
      operationKey: permission.key,
      action: { actionKind: permission.actionKind },
      target: { kind: "organization" },
      requiredPermission: {
        ownerKind: "platform",
        ownerId: platformPermissionOwnerId,
        permissionId: permission.permissionId,
      },
      recentAuthentication: { kind: "none" },
      authority: { kind: "permission" },
    });
    const rows = await transaction.query<CompletionRow>`
      select vortex_access.validated_human_request_context() as request_context,
        eligibility.*, pg_catalog.clock_timestamp() as completed_at
      from vortex_access.evaluate_organization_permission_eligibility(
        ${JSON.stringify(declaration)}::text::jsonb
      ) as eligibility
    `;
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) invalidResult();
    const context = liveContextSchema.safeParse(row.request_context);
    const eligibility = organizationPermissionEligibilitySchema.safeParse({
      outcome: row.outcome,
      operationKey: row.operation_key,
      target: { kind: row.target_kind },
      organizationId: row.organization_id,
      organizationAccountId: row.organization_account_id,
      accessVersion: databaseRevision(row.access_version),
      checkedAt: databaseTimestamp(row.checked_at),
      correlationId: row.correlation_id,
      ...(row.outcome === "eligible"
        ? { validUntil: databaseTimestamp(row.valid_until) }
        : { reasonCode: row.reason_code }),
    });
    const completedAt = timestampSchema.safeParse(databaseTimestamp(row.completed_at));
    if (!context.success || !eligibility.success || !completedAt.success)
      throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
    const current = context.data;
    const decision = eligibility.data;
    const now = Date.parse(completedAt.data);
    if (
      decision.outcome !== "eligible" ||
      decision.operationKey !== key ||
      decision.target.kind !== "organization" ||
      row.target_application_root_id !== null ||
      row.reason_code !== null ||
      !sameId(current.tenantId, scope.tenantId) ||
      !sameId(current.organizationId, scope.organizationId) ||
      !sameId(current.organizationAccountId, scope.organizationAccountId) ||
      current.accessVersion !== scope.accessVersion ||
      !sameId(decision.organizationId, current.organizationId) ||
      !sameId(decision.organizationAccountId, current.organizationAccountId) ||
      decision.accessVersion !== current.accessVersion ||
      !sameId(decision.correlationId, current.correlationId) ||
      Date.parse(decision.checkedAt) > now ||
      Date.parse(decision.validUntil) <= now ||
      Date.parse(current.issuedAt) > now ||
      Date.parse(current.expiresAt) <= now ||
      Date.parse(draft.updatedAt) > now
    )
      throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
    deadline = Math.min(deadline, Date.parse(decision.validUntil), Date.parse(current.expiresAt));
  }
  // A first permission must still be live after a second permission's evaluation completes.
  if ((await databaseClock(transaction)) >= deadline)
    throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
};

const verifySavedDraft = (
  candidate: StoredDefinitionDraft,
  source: ApplicationSourceDocumentV2,
  scope: SelectedOrganizationScope,
  writeStartedAt: number,
  previous?: StoredApplicationDefinitionDraft,
): StoredApplicationDefinitionDraft => {
  const parsed = storedDefinitionDraftSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.kind !== "application") invalidResult();
  const draft = parsed.data;
  if (
    draft.source.kind !== "application" ||
    !sameId(draft.organizationId, scope.organizationId) ||
    draft.key !== source.key ||
    draft.sourceContractVersion !== source.source_contract_version ||
    draft.sourceFingerprint !== fingerprintCanonicalValue(source) ||
    canonicalJson(draft.source) !== canonicalJson(source) ||
    !sameId(draft.updatedBy, scope.organizationAccountId) ||
    draft.draftRevision !== (previous === undefined ? 1 : previous.draftRevision + 1) ||
    Date.parse(draft.updatedAt) < writeStartedAt ||
    Date.parse(draft.updatedAt) < Date.parse(draft.createdAt) ||
    draft.restoredFromReleaseRevision !== undefined ||
    draft.restoredFromSourceFingerprint !== undefined ||
    draft.restoredAt !== undefined ||
    draft.restoredBy !== undefined ||
    draft.restoreCorrelationId !== undefined
  )
    invalidResult();
  if (previous === undefined) {
    if (
      !sameId(draft.createdBy, scope.organizationAccountId) ||
      draft.createdAt !== draft.updatedAt ||
      draft.publishedRevision !== undefined
    )
      invalidResult();
  } else if (
    !sameId(draft.rootId, previous.rootId) ||
    draft.key !== previous.key ||
    Date.parse(draft.createdAt) !== Date.parse(previous.createdAt) ||
    !sameId(draft.createdBy, previous.createdBy) ||
    draft.publishedRevision !== previous.publishedRevision ||
    Date.parse(draft.updatedAt) < Date.parse(previous.updatedAt)
  )
    invalidResult();
  return draft;
};

const safeFailure = (error: unknown): HumanApplicationDraftWriteResult => {
  if (error instanceof BuilderAuthorityError) return { kind: "refused" };
  if (error instanceof DefinitionStoreError) {
    if (
      error.code === "DEFINITION_DRAFT_STALE_OR_MISSING" ||
      error.code === "DEFINITION_ROOT_MISSING" ||
      error.code === "DEFINITION_ROOT_ALREADY_EXISTS" ||
      error.code === "DEFINITION_IDENTITY_ALIAS_CONFLICT"
    )
      return { kind: "conflict" };
    if (
      error.code === "INVALID_DEFINITION_COMMAND" ||
      error.code === "INVALID_DEFINITION_SOURCE" ||
      error.code === "DEFINITION_CONTEXT_REFUSED" ||
      error.code === "DEFINITION_STORAGE_VALIDATION_FAILED"
    )
      return { kind: "refused" };
  }
  return { kind: "temporarily_unavailable" };
};

/** SAME store operations and one resolved human change transaction, with no System identity. */
export const createHumanApplicationDraftWriter = (
  dependencies: HumanApplicationDraftWriterDependencies,
) => {
  const write = async (
    session: IdentitySession,
    organizationId: string,
    candidate: unknown,
    mode: "create" | "save",
  ): Promise<HumanApplicationDraftWriteResult> => {
    const organization = organizationIdSchema.safeParse(organizationId);
    const createCommand =
      mode === "create" ? createDefinitionRootCommandSchema.safeParse(candidate) : undefined;
    const saveCommandResult =
      mode === "save" ? saveDefinitionDraftCommandSchema.safeParse(candidate) : undefined;
    const command = createCommand ?? saveCommandResult;
    if (!organization.success || command === undefined || !command.success)
      return { kind: "refused" };
    const source = applicationSourceDocumentV2Schema.safeParse(command.data.source);
    if (!source.success || !validateDefinitionSource(source.data).valid) return { kind: "refused" };
    const saveCommand = saveCommandResult?.success ? saveCommandResult.data : undefined;
    // Detached validated source is reused for hashing, identities, storage and result comparison.
    let failure: HumanApplicationDraftWriteResult | undefined;
    const result = await dependencies.requests.runChange(
      session,
      { organizationId: organization.data },
      async (transaction, scope): Promise<StoredApplicationDefinitionDraft> => {
        try {
          if (!sameId(scope.organizationId, organization.data) || scope.applicationRootId !== undefined)
            throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
          const authority = createBuilderAuthority({ transaction, scope, targetFacts });
          const store = createDefinitionStore(transaction, authority);
          let saved: StoredDefinitionDraft;
          let previous: StoredApplicationDefinitionDraft | undefined;
          let writeStartedAt: number;
          if (mode === "create") {
            writeStartedAt = await databaseClock(transaction);
            saved = await store.createRoot({ source: source.data });
          } else {
            if (saveCommand === undefined)
              throw new DefinitionStoreError("INVALID_DEFINITION_COMMAND");
            await targetFacts(transaction, scope, saveCommand.rootId);
            previous = await readApplicationDefinitionDraft(transaction, scope, {
              rootId: applicationRootIdSchema.parse(saveCommand.rootId),
              expectedDraftRevision: saveCommand.expectedDraftRevision,
            });
            if (previous.key !== source.data.key)
              throw new DefinitionStoreError("INVALID_DEFINITION_COMMAND");
            writeStartedAt = await databaseClock(transaction);
            saved = await store.saveDraft({ ...saveCommand, source: source.data });
          }
          const returned = verifySavedDraft(saved, source.data, scope, writeStartedAt, previous);
          const stored = await readApplicationDefinitionDraft(transaction, scope, {
            rootId: returned.rootId,
            expectedDraftRevision: returned.draftRevision,
          });
          const draft = verifySavedDraft(stored, source.data, scope, writeStartedAt, previous);
          if (
            !sameId(draft.rootId, returned.rootId) ||
            Date.parse(draft.createdAt) !== Date.parse(returned.createdAt) ||
            Date.parse(draft.updatedAt) !== Date.parse(returned.updatedAt) ||
            !sameId(draft.createdBy, returned.createdBy) ||
            draft.publishedRevision !== returned.publishedRevision ||
            (previous !== undefined && draft.createdAt !== previous.createdAt)
          )
            invalidResult();
          await assertLiveCompletion(transaction, scope, draft);
          return draft;
        } catch (error) {
          failure = safeFailure(error);
          // Throw through runChange so every partial write is rolled back before safe mapping.
          throw error;
        }
      },
    );
    if (result.kind === "available") return { kind: "available", draft: result.value };
    if (failure !== undefined) return failure;
    return result.kind === "unavailable"
      ? { kind: "refused" }
      : { kind: "temporarily_unavailable" };
  };
  return Object.freeze({
    createRoot: (session: IdentitySession, organizationId: string, candidate: unknown) =>
      write(session, organizationId, candidate, "create"),
    saveDraft: (session: IdentitySession, organizationId: string, candidate: unknown) =>
      write(session, organizationId, candidate, "save"),
  });
};
