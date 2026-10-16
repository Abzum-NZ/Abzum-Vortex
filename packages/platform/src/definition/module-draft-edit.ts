import "server-only";

import { createBuilderAuthority, type BuilderTargetFactsReader } from "../access/builder-authority";
import type { PlatformPermissionSource } from "../access/platform-permissions";
import type { HumanOrganizationRequestDependencies } from "../access/human-organization-request";
import {
  assertBeforeLiveDeadline,
  assertLivePermission,
  LiveContextRefused,
  organizationPermissionDeclaration,
  readDatabaseClock,
  readLiveHumanContext,
  type LiveHumanContext,
} from "../access/live-context";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import { requireBuilderAuthority } from "./builder-authority";
import { fingerprintCanonicalValue } from "./canonical-json-definition";
import {
  readModuleDefinitionDraft,
  type StoredModuleDefinitionDraft,
} from "./definition-draft-read";
import { DefinitionError } from "./definition-error";
import type { createDatabaseDefinitionPublicationService } from "./publication/publish";
import { createDefinitionStore } from "./definition-store";
import {
  canonicalJson,
  moduleRootIdSchema,
  platformIdSchema,
  sameId,
  storedModuleDefinitionDraftSchema,
  type IdentitySession,
  type ModuleSourceDocument,
  type SelectedOrganizationScope,
} from "../schema";

type ModuleDraftSnapshot = Readonly<{
  organizationId: string;
  rootId: string;
  key: string;
  name: string;
  draftRevision: number;
  publishedRevision: number | null;
  sourceFingerprint: string;
}>;

type ModuleDraftAccess = Readonly<{
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

export const evaluateDraftPermission = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  originalContext: LiveHumanContext,
  draft: StoredModuleDefinitionDraft,
  access: ModuleDraftAccess,
  originalValidUntil?: string,
): Promise<string> => {
  await moduleTargetFacts(transaction, scope, draft.rootId);
  const permission = access.permission;
  if (permission === undefined) throw new LiveContextRefused("permission_undeclared");
  const declaration = organizationPermissionDeclaration(permission, access.ownerId);
  const current = await readLiveHumanContext(transaction, { scope, session, issuedAt });
  if (canonicalJson(current) !== canonicalJson(originalContext))
    throw new LiveContextRefused("session_context_mismatch");
  const decision = await assertLivePermission(transaction, declaration, current);
  const previousDeadline =
    originalValidUntil === undefined ? Number.POSITIVE_INFINITY : Date.parse(originalValidUntil);
  if (previousDeadline <= decision.completedAt || Date.parse(draft.updatedAt) > decision.completedAt)
    throw new LiveContextRefused("request_deadline_passed");
  const deadline = Math.min(previousDeadline, decision.validUntil, Date.parse(current.expiresAt));
  await assertBeforeLiveDeadline(transaction, deadline);
  return new Date(deadline).toISOString();
};

export const snapshotFor = (draft: StoredModuleDefinitionDraft): ModuleDraftSnapshot => ({
  organizationId: draft.organizationId,
  rootId: draft.rootId,
  key: draft.key,
  name: draft.source.body.name,
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

const sameSavedDraft = (
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
  permissions: PlatformPermissionSource,
): Promise<StoredModuleDefinitionDraft> => {
  const authority = createBuilderAuthority({
    transaction,
    scope,
    targetFacts: moduleTargetFacts,
    permissions,
  });
  await requireBuilderAuthority(authority, { kind: "draft_change", rootId: previous.rootId });
  const startedAt = await readDatabaseClock(transaction);
  const returned = verifySavedDraft(
    await createDefinitionStore(transaction, authority, permissions).saveDraft({
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
