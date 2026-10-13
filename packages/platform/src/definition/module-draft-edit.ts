import "server-only";

import { createBuilderAuthority, type BuilderTargetFactsReader } from "../access/builder-authority";
import type { HumanOrganizationRequestDependencies } from "../access/human-organization-request";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import { requireBuilderAuthority } from "./builder-authority";
import { fingerprintCanonicalValue } from "./canonical-json-definition";
import {
  readModuleDefinitionDraft,
  type StoredModuleDefinitionDraft,
} from "./definition-draft-read";
import { DefinitionError } from "./definition-error";
import type { createDatabaseDefinitionPublicationService } from "./definition-publication-composition";
import { createDefinitionStore } from "./definition-store";
import {
  canonicalJson,
  databaseRevision,
  databaseTimestamp,
  moduleRootIdSchema,
  organizationAccessDeclarationSchema,
  organizationPermissionEligibilitySchema,
  platformIdSchema,
  sameId,
  sessionContextSchema,
  storedModuleDefinitionDraftSchema,
  timestampSchema,
  type IdentitySession,
  type ModuleSourceDocument,
  type SelectedOrganizationScope,
} from "../schema";

export type ModuleDraftSnapshot = Readonly<{
  organizationId: string;
  rootId: string;
  key: string;
  draftRevision: number;
  publishedRevision: number | null;
  sourceFingerprint: string;
}>;

export type ModuleDraftAccess = Readonly<{
  permission: Readonly<{ key: string; actionKind: string; permissionId: string }> | undefined;
  ownerId: string;
}>;

export type ModuleDraftEditDependencies = Readonly<{
  releaseCatalogue: Parameters<typeof createDatabaseDefinitionPublicationService>[0];
  requestDependencies: HumanOrganizationRequestDependencies;
  access: ModuleDraftAccess;
}>;
export const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

export const invalidResult = (): never => {
  throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT");
};

export const moduleTargetFacts: BuilderTargetFactsReader = async (
  transaction,
  scope,
  candidateRootId,
) => {
  const root = moduleRootIdSchema.safeParse(candidateRootId);
  if (!root.success) throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  const draft = await readModuleDefinitionDraft(transaction, scope, { rootId: root.data });
  if (
    draft.kind !== "module" ||
    !sameId(draft.rootId, root.data) ||
    !sameId(draft.organizationId, scope.organizationId)
  )
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  return { isSystemApplication: false };
};

export const databaseClock = async (transaction: RequestDatabaseTransaction): Promise<number> => {
  const rows =
    await transaction.query<DatabaseRow>`select pg_catalog.clock_timestamp() as completed_at`;
  const parsed = timestampSchema.safeParse(databaseTimestamp(rows[0]?.completed_at));
  if (rows.length !== 1 || !parsed.success) return invalidResult();
  return Date.parse(parsed.data);
};

export type HumanContext = Extract<
  ReturnType<typeof sessionContextSchema.parse>,
  { callerKind: "human" }
>;

export const readLiveContext = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
): Promise<HumanContext> => {
  const rows = await transaction.query<DatabaseRow>`
    select vortex_access.validated_human_request_context() as context
  `;
  const transport = rows[0]?.context;
  if (
    rows.length !== 1 ||
    transport === null ||
    typeof transport !== "object" ||
    Array.isArray(transport) ||
    !("channel" in transport) ||
    transport.channel !== "web"
  )
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  const parsed = sessionContextSchema.safeParse(
    Object.fromEntries(Object.entries(transport).filter(([key]) => key !== "channel")),
  );
  const now = await databaseClock(transaction);
  if (!parsed.success || parsed.data.callerKind !== "human")
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  const context = parsed.data;
  if (
    Object.hasOwn(scope, "applicationRootId") ||
    Object.hasOwn(context, "applicationRootId") ||
    context.delegatedContext !== undefined ||
    context.supportContext !== undefined ||
    !sameUuid(context.tenantId, scope.tenantId) ||
    !sameUuid(context.organizationId, scope.organizationId) ||
    !sameUuid(context.organizationAccountId, scope.organizationAccountId) ||
    context.accessVersion !== scope.accessVersion ||
    !sameUuid(context.identityId, session.identityId) ||
    !sameUuid(context.sessionId, session.sessionId) ||
    context.authenticationStrength !== session.authenticationStrength ||
    context.issuedAt !== issuedAt ||
    context.expiresAt !== session.accessTokenExpiresAt ||
    context.accessTokenIssuedAt !==
      (session.primaryAuthenticatedAt !== undefined ||
      session.multiFactorAuthenticatedAt !== undefined
        ? session.accessTokenIssuedAt
        : undefined) ||
    context.primaryAuthenticatedAt !== session.primaryAuthenticatedAt ||
    context.multiFactorAuthenticatedAt !== session.multiFactorAuthenticatedAt ||
    Date.parse(context.issuedAt) > now ||
    Date.parse(context.expiresAt) <= now ||
    Date.parse(context.issuedAt) >= Date.parse(context.expiresAt)
  )
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  return context;
};

export const evaluateDraftPermission = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  originalContext: HumanContext,
  draft: StoredModuleDefinitionDraft,
  access: ModuleDraftAccess,
  originalValidUntil?: string,
): Promise<string> => {
  await moduleTargetFacts(transaction, scope, draft.rootId);
  const permission = access.permission;
  if (permission === undefined) throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  const declaration = organizationAccessDeclarationSchema.parse({
    operationKey: permission.key,
    action: { actionKind: permission.actionKind },
    target: { kind: "organization" },
    requiredPermission: {
      ownerKind: "platform",
      ownerId: access.ownerId,
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
  if (
    !decision.success ||
    decision.data.outcome !== "eligible" ||
    !completed.success ||
    canonicalJson(current) !== canonicalJson(originalContext)
  )
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  const eligible = decision.data;
  const now = Date.parse(completed.data);
  const previousDeadline =
    originalValidUntil === undefined ? Number.POSITIVE_INFINITY : Date.parse(originalValidUntil);
  if (
    eligible.operationKey !== permission.key ||
    eligible.target.kind !== "organization" ||
    row.target_application_root_id !== null ||
    row.reason_code !== null ||
    !sameUuid(eligible.organizationId, scope.organizationId) ||
    !sameUuid(eligible.organizationAccountId, scope.organizationAccountId) ||
    eligible.accessVersion !== scope.accessVersion ||
    !sameUuid(eligible.correlationId, current.correlationId) ||
    Date.parse(eligible.checkedAt) > now ||
    Date.parse(eligible.validUntil) <= now ||
    previousDeadline <= now ||
    Date.parse(draft.updatedAt) > now ||
    (await databaseClock(transaction)) >=
      Math.min(previousDeadline, Date.parse(eligible.validUntil), Date.parse(current.expiresAt))
  )
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  const deadline = Math.min(
    previousDeadline,
    Date.parse(eligible.validUntil),
    Date.parse(current.expiresAt),
  );
  return new Date(deadline).toISOString();
};

export const snapshotFor = (draft: StoredModuleDefinitionDraft): ModuleDraftSnapshot => ({
  organizationId: draft.organizationId,
  rootId: draft.rootId,
  key: draft.key,
  draftRevision: draft.draftRevision,
  publishedRevision: draft.publishedRevision ?? null,
  sourceFingerprint: draft.sourceFingerprint,
});

export const verifySavedDraft = (
  candidate: unknown,
  source: ModuleSourceDocument,
  previous: StoredModuleDefinitionDraft,
  scope: SelectedOrganizationScope,
  startedAt: number,
): StoredModuleDefinitionDraft => {
  const parsed = storedModuleDefinitionDraftSchema.safeParse(candidate);
  if (!parsed.success) return invalidResult();
  const draft = parsed.data;
  if (
    !sameId(draft.organizationId, scope.organizationId) ||
    !sameId(draft.rootId, previous.rootId) ||
    draft.key !== previous.key ||
    draft.source.kind !== "module" ||
    draft.source.key !== source.key ||
    draft.source.root_alias !== previous.source.root_alias ||
    draft.draftRevision !== previous.draftRevision + 1 ||
    draft.sourceFingerprint !== fingerprintCanonicalValue(source) ||
    canonicalJson(draft.source) !== canonicalJson(source) ||
    !sameId(draft.updatedBy, scope.organizationAccountId) ||
    Date.parse(draft.createdAt) !== Date.parse(previous.createdAt) ||
    !sameId(draft.createdBy, previous.createdBy) ||
    draft.publishedRevision !== previous.publishedRevision ||
    Date.parse(draft.updatedAt) < startedAt ||
    Date.parse(draft.updatedAt) < Date.parse(previous.updatedAt) ||
    Date.parse(draft.updatedAt) < Date.parse(draft.createdAt) ||
    draft.restoredFromReleaseRevision !== undefined ||
    draft.restoredFromSourceFingerprint !== undefined ||
    draft.restoredAt !== undefined ||
    draft.restoredBy !== undefined ||
    draft.restoreCorrelationId !== undefined
  )
    return invalidResult();
  return draft;
};

export const sameDraft = (
  left: StoredModuleDefinitionDraft,
  right: StoredModuleDefinitionDraft,
): boolean => canonicalJson(left) === canonicalJson(right);

export const sameSavedDraft = (
  left: StoredModuleDefinitionDraft,
  right: StoredModuleDefinitionDraft,
): boolean =>
  sameId(left.organizationId, right.organizationId) &&
  sameId(left.rootId, right.rootId) &&
  left.kind === right.kind &&
  left.key === right.key &&
  left.draftRevision === right.draftRevision &&
  left.publishedRevision === right.publishedRevision &&
  left.sourceFingerprint === right.sourceFingerprint &&
  canonicalJson(left.source) === canonicalJson(right.source) &&
  sameId(left.createdBy, right.createdBy) &&
  sameId(left.updatedBy, right.updatedBy) &&
  Date.parse(left.createdAt) === Date.parse(right.createdAt) &&
  Date.parse(left.updatedAt) === Date.parse(right.updatedAt);

/** One atomic authority, revision, write, and reread path for every module draft edit. */
export const saveModuleDraftEdit = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  previous: StoredModuleDefinitionDraft,
  source: ModuleSourceDocument,
): Promise<StoredModuleDefinitionDraft> => {
  const authority = createBuilderAuthority({ transaction, scope, targetFacts: moduleTargetFacts });
  await requireBuilderAuthority(authority, { kind: "draft_change", rootId: previous.rootId });
  const startedAt = await databaseClock(transaction);
  const returned = verifySavedDraft(
    await createDefinitionStore(transaction, authority).saveDraft({
      rootId: platformIdSchema.parse(previous.rootId),
      expectedDraftRevision: previous.draftRevision,
      source,
    }),
    source,
    previous,
    scope,
    startedAt,
  );
  const reread = verifySavedDraft(
    await readModuleDefinitionDraft(transaction, scope, {
      rootId: returned.rootId,
      expectedDraftRevision: returned.draftRevision,
    }),
    source,
    previous,
    scope,
    startedAt,
  );
  if (!sameSavedDraft(returned, reread)) return invalidResult();
  return reread;
};
