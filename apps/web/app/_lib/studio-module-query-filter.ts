import "server-only";

import { createBuilderAuthority, type BuilderTargetFactsReader } from "@vortex/access";
import {
  canonicalJson,
  conditionNodeSchema,
  databaseRevision,
  databaseTimestamp,
  fingerprintSchema,
  moduleRootIdSchema,
  organizationAccessDeclarationSchema,
  organizationIdSchema,
  organizationPermissionEligibilitySchema,
  platformIdSchema,
  revisionSchema,
  sameId,
  sessionContextSchema,
  storedModuleDefinitionDraftSchema,
  timestampSchema,
  type DefinitionValidationResult,
  type IdentitySession,
  type ModuleSourceDocument,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  BuilderAuthorityError,
  createDatabaseDefinitionPublicationService,
  createDefinitionStore,
  DefinitionPublicationError,
  DefinitionStoreError,
  fingerprintModuleQueryFilterOperandBinding,
  fingerprintCanonicalValue,
  readModuleDefinitionDraft,
  requireBuilderAuthority,
  type ModuleQueryFilterDraftContext,
  type ModuleQueryFilterQueryChoice,
  type StoredModuleDefinitionDraft,
} from "@vortex/definition";
import { platformPermissionDeclarations, platformPermissionOwnerId } from "@vortex/modules";
import { z } from "zod";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { humanOrganizationRequests } from "./server-composition";
import { encodeModuleQueryFilter } from "../studio/_lib/module-query-filter-commands";

export type StudioModuleQueryFilterSnapshot = Readonly<{
  organizationId: string;
  rootId: string;
  key: string;
  draftRevision: number;
  publishedRevision: number | null;
  sourceFingerprint: string;
}>;

export type StudioModuleQueryFilterResult =
  | Readonly<{
      kind: "available";
      snapshot: StudioModuleQueryFilterSnapshot;
      queryChoices: readonly ModuleQueryFilterQueryChoice[];
      selected?: ModuleQueryFilterDraftContext;
    }>
  | Readonly<{
      kind: "readonly";
      queryChoices: readonly ModuleQueryFilterQueryChoice[];
      selectedAlias?: string;
      reason: "query_target_unsupported" | "operand_context_unsupported" | "retained_filter_unsupported";
    }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

export type StudioModuleQueryFilterSaveResult =
  | Readonly<{
      kind: "saved" | "unchanged";
      snapshot: StudioModuleQueryFilterSnapshot;
      selected: ModuleQueryFilterDraftContext;
    }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
  | Readonly<{
      kind: "readonly";
      reason: "query_target_unsupported" | "operand_context_unsupported" | "retained_filter_unsupported";
    }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

export type StudioModuleQueryFilterValidationResult =
  | Readonly<{ kind: "valid" }>
  | Readonly<{ kind: "validation_failed"; validation: DefinitionValidationResult }>
  | Readonly<{
      kind: "readonly";
      reason: "query_target_unsupported" | "operand_context_unsupported" | "retained_filter_unsupported";
    }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

const loadRequestSchema = z.object({
  rootId: moduleRootIdSchema,
  queryAlias: z.string().min(1).max(160).optional(),
}).strict();

const filterRequestSchema = z.object({
  rootId: moduleRootIdSchema,
  queryAlias: z.string().min(1).max(160),
  expectedDraftRevision: revisionSchema,
  expectedSavedSourceFingerprint: fingerprintSchema,
  expectedResolutionFingerprint: fingerprintSchema,
  expectedOperandBindingFingerprint: fingerprintSchema,
  condition: conditionNodeSchema.nullable(),
}).strict();

const sameUuid = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const invalidResult = (): never => {
  throw new DefinitionStoreError("INVALID_DEFINITION_STORAGE_RESULT");
};

const safeFailure = (error: unknown):
  | Extract<StudioModuleQueryFilterResult, { kind: "conflict" | "refused" | "temporarily_unavailable" }>
  | Extract<StudioModuleQueryFilterSaveResult, { kind: "conflict" | "refused" | "temporarily_unavailable" }> => {
  if (error instanceof BuilderAuthorityError) return { kind: "refused" };
  if (error instanceof DefinitionStoreError) {
    if (error.code === "DEFINITION_DRAFT_STALE_OR_MISSING" || error.code === "DEFINITION_ROOT_MISSING" ||
        error.code === "DEFINITION_IDENTITY_ALIAS_CONFLICT") return { kind: "conflict" };
    if (error.code === "INVALID_DEFINITION_COMMAND" || error.code === "INVALID_DEFINITION_SOURCE" ||
        error.code === "DEFINITION_CONTEXT_REFUSED" || error.code === "DEFINITION_STORAGE_VALIDATION_FAILED")
      return { kind: "refused" };
    return { kind: "temporarily_unavailable" };
  }
  if (error instanceof DefinitionPublicationError) {
    if (error.code === "DEFINITION_DRAFT_STALE_OR_MISSING" || error.code === "DEFINITION_ORGANIZATION_MISMATCH" ||
        error.code === "DEFINITION_SOURCE_EVIDENCE_MISMATCH" || error.code === "DEFINITION_HISTORY_INVALID")
      return { kind: "conflict" };
    if (error.code === "INVALID_DEFINITION_PUBLICATION_COMMAND") return { kind: "refused" };
  }
  return { kind: "temporarily_unavailable" };
};

const moduleTargetFacts: BuilderTargetFactsReader = async (transaction, scope, candidateRootId) => {
  const root = moduleRootIdSchema.safeParse(candidateRootId);
  if (!root.success) throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
  const draft = await readModuleDefinitionDraft(transaction, scope, { rootId: root.data });
  if (draft.kind !== "module" || !sameId(draft.rootId, root.data) || !sameId(draft.organizationId, scope.organizationId))
    throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
  return { isSystemApplication: false };
};

const databaseClock = async (transaction: RequestDatabaseTransaction): Promise<number> => {
  const rows = await transaction.query<DatabaseRow>`select pg_catalog.clock_timestamp() as completed_at`;
  const parsed = timestampSchema.safeParse(databaseTimestamp(rows[0]?.completed_at));
  if (rows.length !== 1 || !parsed.success) return invalidResult();
  return Date.parse(parsed.data);
};

type HumanContext = Extract<ReturnType<typeof sessionContextSchema.parse>, { callerKind: "human" }>;

const readLiveContext = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
): Promise<HumanContext> => {
  const rows = await transaction.query<DatabaseRow>`
    select vortex_access.validated_human_request_context() as context
  `;
  const transport = rows[0]?.context;
  if (rows.length !== 1 || transport === null || typeof transport !== "object" || Array.isArray(transport) ||
      !("channel" in transport) || transport.channel !== "web")
    throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
  const parsed = sessionContextSchema.safeParse(
    Object.fromEntries(Object.entries(transport).filter(([key]) => key !== "channel")),
  );
  const now = await databaseClock(transaction);
  if (!parsed.success || parsed.data.callerKind !== "human")
    throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
  const context = parsed.data;
  if (Object.hasOwn(scope, "applicationRootId") || Object.hasOwn(context, "applicationRootId") ||
      context.delegatedContext !== undefined || context.supportContext !== undefined ||
      !sameUuid(context.tenantId, scope.tenantId) || !sameUuid(context.organizationId, scope.organizationId) ||
      !sameUuid(context.organizationAccountId, scope.organizationAccountId) || context.accessVersion !== scope.accessVersion ||
      !sameUuid(context.identityId, session.identityId) || !sameUuid(context.sessionId, session.sessionId) ||
      context.authenticationStrength !== session.authenticationStrength || context.issuedAt !== issuedAt ||
      context.expiresAt !== session.accessTokenExpiresAt ||
      context.accessTokenIssuedAt !==
        (session.primaryAuthenticatedAt !== undefined || session.multiFactorAuthenticatedAt !== undefined
          ? session.accessTokenIssuedAt : undefined) ||
      context.primaryAuthenticatedAt !== session.primaryAuthenticatedAt ||
      context.multiFactorAuthenticatedAt !== session.multiFactorAuthenticatedAt ||
      Date.parse(context.issuedAt) > now || Date.parse(context.expiresAt) <= now ||
      Date.parse(context.issuedAt) >= Date.parse(context.expiresAt))
    throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
  return context;
};

const evaluateDraftPermission = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  originalContext: HumanContext,
  draft: StoredModuleDefinitionDraft,
  originalValidUntil?: string,
): Promise<string> => {
  await moduleTargetFacts(transaction, scope, draft.rootId);
  const permission = platformPermissionDeclarations.find(
    (entry) => entry.key === "platform.organization.definition_drafts.manage",
  );
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
  const rows = await transaction.query<DatabaseRow>`
    select eligibility.*, pg_catalog.clock_timestamp() as completed_at
    from vortex_access.evaluate_organization_permission_eligibility(
      ${JSON.stringify(declaration)}::text::jsonb
    ) as eligibility
  `;
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) return invalidResult();
  const decision = organizationPermissionEligibilitySchema.safeParse({
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
  const completed = timestampSchema.safeParse(databaseTimestamp(row.completed_at));
  const current = await readLiveContext(transaction, scope, session, issuedAt);
  if (!decision.success || decision.data.outcome !== "eligible" || !completed.success ||
      canonicalJson(current) !== canonicalJson(originalContext))
    throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
  const eligible = decision.data;
  const now = Date.parse(completed.data);
  const previousDeadline = originalValidUntil === undefined ? Number.POSITIVE_INFINITY : Date.parse(originalValidUntil);
  if (eligible.operationKey !== permission.key || eligible.target.kind !== "organization" ||
      row.target_application_root_id !== null || row.reason_code !== null ||
      !sameUuid(eligible.organizationId, scope.organizationId) ||
      !sameUuid(eligible.organizationAccountId, scope.organizationAccountId) ||
      eligible.accessVersion !== scope.accessVersion || !sameUuid(eligible.correlationId, current.correlationId) ||
      Date.parse(eligible.checkedAt) > now || Date.parse(eligible.validUntil) <= now ||
      previousDeadline <= now ||
      Date.parse(draft.updatedAt) > now ||
      (await databaseClock(transaction)) >= Math.min(previousDeadline, Date.parse(eligible.validUntil), Date.parse(current.expiresAt)))
    throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
  const deadline = Math.min(previousDeadline, Date.parse(eligible.validUntil), Date.parse(current.expiresAt));
  return new Date(deadline).toISOString();
};

const snapshotFor = (draft: StoredModuleDefinitionDraft): StudioModuleQueryFilterSnapshot => ({
  organizationId: draft.organizationId,
  rootId: draft.rootId,
  key: draft.key,
  draftRevision: draft.draftRevision,
  publishedRevision: draft.publishedRevision ?? null,
  sourceFingerprint: draft.sourceFingerprint,
});

const verifySavedDraft = (
  candidate: unknown,
  source: ModuleSourceDocument,
  previous: StoredModuleDefinitionDraft,
  scope: SelectedOrganizationScope,
  startedAt: number,
): StoredModuleDefinitionDraft => {
  const parsed = storedModuleDefinitionDraftSchema.safeParse(candidate);
  if (!parsed.success) return invalidResult();
  const draft = parsed.data;
  if (!sameId(draft.organizationId, scope.organizationId) || !sameId(draft.rootId, previous.rootId) ||
      draft.key !== previous.key || draft.source.kind !== "module" || draft.source.key !== source.key ||
      draft.source.root_alias !== previous.source.root_alias || draft.draftRevision !== previous.draftRevision + 1 ||
      draft.sourceFingerprint !== fingerprintCanonicalValue(source) || canonicalJson(draft.source) !== canonicalJson(source) ||
      !sameId(draft.updatedBy, scope.organizationAccountId) ||
      Date.parse(draft.createdAt) !== Date.parse(previous.createdAt) || !sameId(draft.createdBy, previous.createdBy) ||
      draft.publishedRevision !== previous.publishedRevision || Date.parse(draft.updatedAt) < startedAt ||
      Date.parse(draft.updatedAt) < Date.parse(previous.updatedAt) || Date.parse(draft.updatedAt) < Date.parse(draft.createdAt) ||
      draft.restoredFromReleaseRevision !== undefined || draft.restoredFromSourceFingerprint !== undefined ||
      draft.restoredAt !== undefined || draft.restoredBy !== undefined || draft.restoreCorrelationId !== undefined)
    return invalidResult();
  return draft;
};

const queryFilterService = (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
) => createDatabaseDefinitionPublicationService(
  installedReleaseCatalogue,
  transaction,
  createBuilderAuthority({ transaction, scope, targetFacts: moduleTargetFacts }),
);

const sameDraft = (left: StoredModuleDefinitionDraft, right: StoredModuleDefinitionDraft): boolean =>
  canonicalJson(left) === canonicalJson(right);

const sameSavedReceipt = (left: StoredModuleDefinitionDraft, right: StoredModuleDefinitionDraft): boolean =>
  sameId(left.organizationId, right.organizationId) && sameId(left.rootId, right.rootId) &&
  left.kind === right.kind && left.key === right.key && left.draftRevision === right.draftRevision &&
  left.publishedRevision === right.publishedRevision && left.sourceFingerprint === right.sourceFingerprint &&
  canonicalJson(left.source) === canonicalJson(right.source) && sameId(left.createdBy, right.createdBy) &&
  sameId(left.updatedBy, right.updatedBy) && Date.parse(left.createdAt) === Date.parse(right.createdAt) &&
  Date.parse(left.updatedAt) === Date.parse(right.updatedAt);

const sameOperandBindingIdentity = (
  left: ModuleQueryFilterDraftContext,
  right: ModuleQueryFilterDraftContext,
): boolean => canonicalJson({
  organizationId: left.organizationId,
  rootId: left.rootId,
  definitionKey: left.definitionKey,
  resolutionFingerprint: left.resolutionFingerprint,
  query: left.query,
  fields: left.fields,
  parameters: left.parameters,
}) === canonicalJson({
  organizationId: right.organizationId,
  rootId: right.rootId,
  definitionKey: right.definitionKey,
  resolutionFingerprint: right.resolutionFingerprint,
  query: right.query,
  fields: right.fields,
  parameters: right.parameters,
});

const changesOnlySelectedQueryFilter = (
  previous: ModuleSourceDocument,
  candidate: ModuleSourceDocument,
  queryAlias: string,
): boolean => {
  const matches = previous.body.queries.filter((query) => query.id === queryAlias);
  if (matches.length !== 1) return false;
  const expected = structuredClone(previous);
  const expectedQueries = expected.body.queries.filter((query) => query.id === queryAlias);
  const nextQueries = candidate.body.queries.filter((query) => query.id === queryAlias);
  if (expectedQueries.length !== 1 || nextQueries.length !== 1 ||
      expectedQueries[0]!.key !== nextQueries[0]!.key) return false;
  if (nextQueries[0]!.filter === undefined) delete expectedQueries[0]!.filter;
  else expectedQueries[0]!.filter = nextQueries[0]!.filter;
  return canonicalJson(expected) === canonicalJson(candidate);
};

const loadInTransaction = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  organizationId: string,
  request: z.infer<typeof loadRequestSchema>,
): Promise<StudioModuleQueryFilterResult> => {
  if (!sameUuid(scope.organizationId, organizationId)) return { kind: "refused" };
  const liveContext = await readLiveContext(transaction, scope, session, issuedAt);
  const authority = createBuilderAuthority({ transaction, scope, targetFacts: moduleTargetFacts });
  await requireBuilderAuthority(authority, {
    kind: "draft_change",
    rootId: platformIdSchema.parse(request.rootId),
  });
  const draft = await readModuleDefinitionDraft(transaction, scope, { rootId: request.rootId });
  if (!sameId(draft.organizationId, organizationId)) return { kind: "conflict" };
  const service = queryFilterService(transaction, scope);
  const loaded = await service.readModuleQueryFilterDraft(liveContext, {
    rootId: platformIdSchema.parse(draft.rootId),
    expectedDraftRevision: draft.draftRevision,
    expectedSavedSourceFingerprint: draft.sourceFingerprint,
    ...(request.queryAlias === undefined ? {} : { queryAlias: request.queryAlias }),
  });
  if (loaded.kind === "validation_failed") return loaded;
  if (loaded.kind === "unsupported_context")
    return { kind: "readonly", queryChoices: [], selectedAlias: request.queryAlias, reason: loaded.reason };
  const current = await readModuleDefinitionDraft(transaction, scope, {
    rootId: draft.rootId,
    expectedDraftRevision: draft.draftRevision,
  });
  if (!sameDraft(current, draft)) return { kind: "conflict" };
  await evaluateDraftPermission(
    transaction,
    scope,
    session,
    issuedAt,
    liveContext,
    current,
  );
  if (request.queryAlias !== undefined && loaded.selected === undefined) {
    const selectedChoice = loaded.queryChoices.find((choice) => choice.alias === request.queryAlias);
    if (selectedChoice !== undefined)
      return {
        kind: "readonly",
        queryChoices: loaded.queryChoices,
        selectedAlias: request.queryAlias,
        reason: selectedChoice.reason ?? "operand_context_unsupported",
      };
    return { kind: "conflict" };
  }
  return {
    kind: "available",
    snapshot: snapshotFor(current),
    queryChoices: loaded.queryChoices,
    ...(loaded.selected === undefined ? {} : { selected: loaded.selected }),
  };
};

export const loadStudioModuleQueryFilter = async (
  candidateOrganizationId: string,
  candidateRootId: string,
  queryAlias?: string,
): Promise<StudioModuleQueryFilterResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const root = moduleRootIdSchema.safeParse(candidateRootId);
  const request = loadRequestSchema.safeParse({ rootId: candidateRootId, ...(queryAlias === undefined ? {} : { queryAlias }) });
  if (!organization.success || !root.success || !request.success) return { kind: "refused" };
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active") return resolved.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" } : { kind: "refused" };
    let failure: ReturnType<typeof safeFailure> | undefined;
    const result = await humanOrganizationRequests().run(resolved.session, { organizationId: organization.data },
      async (transaction, scope, issuedAt) => {
        try {
          return await loadInTransaction(
            transaction, scope, resolved.session, issuedAt, organization.data, request.data,
          );
        } catch (error) {
          failure = safeFailure(error);
          throw error;
        }
      });
    return result.kind === "available" ? result.value : failure ??
      (result.kind === "refused" ? { kind: "refused" } : { kind: "temporarily_unavailable" });
  } catch {
    return { kind: "temporarily_unavailable" };
  }
};

const saveRequestSchema = filterRequestSchema;

class ValidationFailure extends Error {
  constructor(readonly validation: DefinitionValidationResult) {
    super("STUDIO_MODULE_QUERY_FILTER_VALIDATION_FAILED");
  }
}

class ReadonlyContext extends Error {
  constructor(readonly reason: "query_target_unsupported" | "operand_context_unsupported" | "retained_filter_unsupported") {
    super("STUDIO_MODULE_QUERY_FILTER_READONLY");
  }
}

const currentFilter = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  organizationId: string,
  request: z.infer<typeof saveRequestSchema>,
): Promise<Readonly<{
  draft: StoredModuleDefinitionDraft;
  context: ModuleQueryFilterDraftContext;
  source: StoredModuleDefinitionDraft["source"];
  sourceFingerprint: string;
  noChange: boolean;
  liveContext: HumanContext;
}>> => {
  if (!sameUuid(scope.organizationId, organizationId)) throw new DefinitionStoreError("DEFINITION_CONTEXT_REFUSED");
  const liveContext = await readLiveContext(transaction, scope, session, issuedAt);
  const authority = createBuilderAuthority({ transaction, scope, targetFacts: moduleTargetFacts });
  await requireBuilderAuthority(authority, {
    kind: "draft_change",
    rootId: platformIdSchema.parse(request.rootId),
  });
  const draft = await readModuleDefinitionDraft(transaction, scope, {
    rootId: request.rootId,
    expectedDraftRevision: request.expectedDraftRevision,
  });
  if (!sameId(draft.organizationId, organizationId) || draft.sourceFingerprint !== request.expectedSavedSourceFingerprint)
    throw new DefinitionStoreError("DEFINITION_DRAFT_STALE_OR_MISSING");
  const service = queryFilterService(transaction, scope);
  const current = await service.readModuleQueryFilterDraft(liveContext, {
    rootId: platformIdSchema.parse(draft.rootId),
    expectedDraftRevision: draft.draftRevision,
    expectedSavedSourceFingerprint: draft.sourceFingerprint,
    queryAlias: request.queryAlias,
  });
  if (current.kind === "validation_failed") throw new ValidationFailure(current.validation);
  if (current.kind === "unsupported_context") throw new ReadonlyContext(current.reason);
  if (current.selected === undefined) {
    const choice = current.queryChoices.find((entry) => entry.alias === request.queryAlias);
    throw new ReadonlyContext(choice?.reason ?? "query_target_unsupported");
  }
  if (current.selected.resolutionFingerprint !== request.expectedResolutionFingerprint ||
      current.selected.operandBindingFingerprint !== request.expectedOperandBindingFingerprint)
    throw new DefinitionStoreError("DEFINITION_DRAFT_STALE_OR_MISSING");
  const encoded = encodeModuleQueryFilter(request.condition, current.selected);
  if (encoded.kind === "invalid") throw new DefinitionStoreError("INVALID_DEFINITION_COMMAND");
  if (encoded.kind === "unsupported") throw new ReadonlyContext("operand_context_unsupported");
  const validated = await service.validateModuleQueryFilterDraft(liveContext, {
    rootId: platformIdSchema.parse(draft.rootId),
    expectedDraftRevision: draft.draftRevision,
    expectedSavedSourceFingerprint: draft.sourceFingerprint,
    expectedResolutionFingerprint: request.expectedResolutionFingerprint,
    expectedOperandBindingFingerprint: request.expectedOperandBindingFingerprint,
    queryAlias: request.queryAlias,
    filter: encoded.filter,
  });
  if (validated.kind === "validation_failed") throw new ValidationFailure(validated.validation);
  if (validated.kind === "unsupported_context") throw new ReadonlyContext(validated.reason);
  if (!validated.noChange && !changesOnlySelectedQueryFilter(draft.source, validated.source, request.queryAlias))
    throw new DefinitionStoreError("INVALID_DEFINITION_STORAGE_RESULT");
  return {
    draft,
    context: validated.context,
    source: validated.source,
    sourceFingerprint: validated.sourceFingerprint,
    noChange: validated.noChange,
    liveContext,
  };
};

const safeSaveFailure = (error: unknown): StudioModuleQueryFilterSaveResult =>
  error instanceof ValidationFailure
    ? { kind: "validation_failed", validation: error.validation }
    : error instanceof ReadonlyContext
      ? { kind: "readonly", reason: error.reason }
      : safeFailure(error);

const safeValidationFailure = (error: unknown): StudioModuleQueryFilterValidationResult =>
  error instanceof ValidationFailure
    ? { kind: "validation_failed", validation: error.validation }
    : error instanceof ReadonlyContext
      ? { kind: "readonly", reason: error.reason }
      : safeFailure(error);

export const validateStudioModuleQueryFilter = async (
  candidateOrganizationId: string,
  candidate: unknown,
): Promise<StudioModuleQueryFilterValidationResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const request = saveRequestSchema.safeParse(candidate);
  if (!organization.success || !request.success) return { kind: "refused" };
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active") return resolved.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" } : { kind: "refused" };
    let failure: StudioModuleQueryFilterValidationResult | undefined;
    const result = await humanOrganizationRequests().run(resolved.session, { organizationId: organization.data },
      async (transaction, scope, issuedAt) => {
        try {
          const value = await currentFilter(
            transaction, scope, resolved.session, issuedAt, organization.data, request.data,
          );
          const originalDeadline = await evaluateDraftPermission(
            transaction, scope, resolved.session, issuedAt, value.liveContext, value.draft,
          );
          const current = await readModuleDefinitionDraft(transaction, scope, {
            rootId: value.draft.rootId,
            expectedDraftRevision: value.draft.draftRevision,
          });
          if (!sameDraft(current, value.draft)) return { kind: "conflict" } as const;
          await evaluateDraftPermission(
            transaction, scope, resolved.session, issuedAt, value.liveContext, current, originalDeadline,
          );
          return { kind: "valid" } as const;
        } catch (error) {
          failure = safeValidationFailure(error);
          throw error;
        }
      });
    return result.kind === "available" ? result.value : failure ??
      (result.kind === "refused" ? { kind: "refused" } : { kind: "temporarily_unavailable" });
  } catch {
    return { kind: "temporarily_unavailable" };
  }
};

export const saveStudioModuleQueryFilter = async (
  candidateOrganizationId: string,
  candidate: unknown,
): Promise<StudioModuleQueryFilterSaveResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const request = saveRequestSchema.safeParse(candidate);
  if (!organization.success || !request.success) return { kind: "refused" };
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active") return resolved.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" } : { kind: "refused" };
    let failure: StudioModuleQueryFilterSaveResult | undefined;
    const result = await humanOrganizationRequests().runChange(resolved.session, { organizationId: organization.data },
      async (transaction, scope, issuedAt) => {
        try {
          const validated = await currentFilter(
            transaction, scope, resolved.session, issuedAt, organization.data, request.data,
          );
          const originalDeadline = await evaluateDraftPermission(
            transaction, scope, resolved.session, issuedAt, validated.liveContext, validated.draft,
          );
          if (validated.noChange) {
            const current = await readModuleDefinitionDraft(transaction, scope, {
              rootId: validated.draft.rootId,
              expectedDraftRevision: validated.draft.draftRevision,
            });
            if (!sameDraft(current, validated.draft)) return { kind: "conflict" } as const;
            const receipt = await queryFilterService(transaction, scope).readModuleQueryFilterDraft(
              validated.liveContext,
              {
                rootId: platformIdSchema.parse(current.rootId),
                expectedDraftRevision: current.draftRevision,
                expectedSavedSourceFingerprint: current.sourceFingerprint,
                queryAlias: validated.context.query.alias,
              },
            );
            if (receipt.kind === "validation_failed") throw new ValidationFailure(receipt.validation);
            if (receipt.kind !== "available" || receipt.selected === undefined ||
                canonicalJson(receipt.selected) !== canonicalJson(validated.context))
              return { kind: "conflict" } as const;
            await evaluateDraftPermission(
              transaction, scope, resolved.session, issuedAt, validated.liveContext, current,
              originalDeadline,
            );
            return {
              kind: "unchanged", snapshot: snapshotFor(current),
              selected: receipt.selected,
            } as const;
          }
          const authority = createBuilderAuthority({ transaction, scope, targetFacts: moduleTargetFacts });
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: validated.draft.rootId });
          const startedAt = await databaseClock(transaction);
          const returned = verifySavedDraft(
            await createDefinitionStore(transaction, authority).saveDraft({
              rootId: platformIdSchema.parse(validated.draft.rootId),
              expectedDraftRevision: validated.draft.draftRevision,
              source: validated.source,
            }),
            validated.source,
            validated.draft,
            scope,
            startedAt,
          );
          const reread = verifySavedDraft(
            await readModuleDefinitionDraft(transaction, scope, {
              rootId: returned.rootId,
              expectedDraftRevision: returned.draftRevision,
            }),
            validated.source,
            validated.draft,
            scope,
            startedAt,
          );
          if (!sameSavedReceipt(returned, reread)) return invalidResult();
          const receipt = await queryFilterService(transaction, scope).readModuleQueryFilterDraft(
            validated.liveContext,
            {
              rootId: platformIdSchema.parse(reread.rootId),
              expectedDraftRevision: reread.draftRevision,
              expectedSavedSourceFingerprint: reread.sourceFingerprint,
              queryAlias: validated.context.query.alias,
            },
          );
          if (receipt.kind === "validation_failed") throw new ValidationFailure(receipt.validation);
          if (receipt.kind !== "available" || receipt.selected === undefined)
            throw new DefinitionStoreError("INVALID_DEFINITION_STORAGE_RESULT");
          const selectedReceipt = receipt.selected;
          const expectedReceiptBindingFingerprint = fingerprintModuleQueryFilterOperandBinding({
            organizationId: selectedReceipt.organizationId,
            rootId: selectedReceipt.rootId,
            definitionKey: selectedReceipt.definitionKey,
            draftRevision: reread.draftRevision,
            savedSourceFingerprint: reread.sourceFingerprint,
            resolutionFingerprint: selectedReceipt.resolutionFingerprint,
            query: selectedReceipt.query,
            fields: selectedReceipt.fields,
            parameters: selectedReceipt.parameters,
          });
          if (selectedReceipt.organizationId !== reread.organizationId ||
              selectedReceipt.rootId !== reread.rootId ||
              selectedReceipt.definitionKey !== reread.key ||
              selectedReceipt.draftRevision !== reread.draftRevision ||
              selectedReceipt.savedSourceFingerprint !== reread.sourceFingerprint ||
              !sameOperandBindingIdentity(selectedReceipt, validated.context) ||
              selectedReceipt.operandBindingFingerprint !== expectedReceiptBindingFingerprint ||
              canonicalJson(selectedReceipt.filter) !== canonicalJson(validated.context.filter))
            throw new DefinitionStoreError("INVALID_DEFINITION_STORAGE_RESULT");
          await evaluateDraftPermission(
            transaction,
            scope,
            resolved.session,
            issuedAt,
            validated.liveContext,
            reread,
            originalDeadline,
          );
          return {
            kind: "saved",
            snapshot: snapshotFor(reread),
            selected: receipt.selected,
          } as const;
        } catch (error) {
          failure = safeSaveFailure(error);
          throw error;
        }
      });
    return result.kind === "available" ? result.value : failure ??
      (result.kind === "refused" ? { kind: "refused" } : { kind: "temporarily_unavailable" });
  } catch {
    return { kind: "temporarily_unavailable" };
  }
};
