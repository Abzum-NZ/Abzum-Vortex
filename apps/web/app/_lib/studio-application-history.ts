import "server-only";

import { z } from "zod";
import { createBuilderAuthority, type BuilderTargetFactsReader } from "@vortex/access";
import {
  applicationRootIdSchema, canonicalJson, correlationIdSchema, databaseRevision,
  databaseTimestamp, definitionReleaseMetadataSchema, fingerprintSchema, namespacedKeySchema,
  organizationAccessDeclarationSchema, organizationIdSchema, organizationPermissionEligibilitySchema,
  publishedApplicationReferenceSchema, revisionSchema, sameId, sessionContextSchema, timestampSchema,
  type DefinitionReleaseMetadata, type IdentitySession, type SelectedOrganizationScope,
  type SessionContext, type StoredDefinitionDraft,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { BuilderAuthorityError, DefinitionStoreError, readApplicationDefinitionDraft,
  requireBuilderAuthority } from "@vortex/definition";
import { platformPermissionDeclarations, platformPermissionOwnerId } from "@vortex/modules";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { humanOrganizationRequests } from "./server-composition";

const pageSize = 20;
const snapshotFields = {
  draftRevision: revisionSchema,
  sourceFingerprint: fingerprintSchema,
  anchorReleaseRevision: revisionSchema.nullable(),
};
const expectedSnapshotSchema = z.object(snapshotFields).strict();
const snapshotSchema = z.object({
  organizationId: organizationIdSchema, rootId: applicationRootIdSchema,
  definitionKey: namespacedKeySchema, ...snapshotFields, correlationId: correlationIdSchema,
}).strict();
const listRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reload"), rootId: applicationRootIdSchema }).strict(),
  z.object({ kind: z.literal("next"), rootId: applicationRootIdSchema,
    expected: expectedSnapshotSchema, afterReleaseRevision: revisionSchema }).strict(),
]);
const inspectRequestSchema = z.object({
  rootId: applicationRootIdSchema, expected: expectedSnapshotSchema, releaseRevision: revisionSchema,
}).strict();
const pageSchema = z.object({
  anchorReleaseRevision: revisionSchema,
  entries: z.array(z.object({
    previousReleaseRevision: revisionSchema.nullable(),
    release: z.object({
      publication: publishedApplicationReferenceSchema,
      releaseNote: z.string(),
      // The protected producer includes compilation evidence. Only this fingerprint is projected.
      evidence: z.object({ authoredSourceFingerprint: fingerprintSchema }).passthrough(),
    }).passthrough(),
  }).strict()).min(1).max(pageSize),
  nextAfterReleaseRevision: revisionSchema.nullable(),
}).strict();

export type StudioApplicationHistorySnapshot = z.infer<typeof snapshotSchema>;
export type StudioApplicationHistoryListRequest = z.infer<typeof listRequestSchema>;
export type StudioApplicationHistoryInspectRequest = z.infer<typeof inspectRequestSchema>;
export type StudioApplicationHistoryFailure = Readonly<{
  kind: "refused" | "conflict" | "temporarily_unavailable";
}>;
export type StudioApplicationHistoryPage = Readonly<{
  snapshot: StudioApplicationHistorySnapshot;
  entries: readonly DefinitionReleaseMetadata[];
  nextAfterReleaseRevision: number | null;
}>;
export type StudioApplicationHistoryListResult = StudioApplicationHistoryFailure |
  Readonly<{ kind: "available"; page: StudioApplicationHistoryPage }>;
export type StudioApplicationHistoryInspectResult = StudioApplicationHistoryFailure |
  Readonly<{ kind: "available"; snapshot: StudioApplicationHistorySnapshot;
    metadata: DefinitionReleaseMetadata }>;
export type StudioApplicationHistoryAccessResult = StudioApplicationHistoryFailure |
  Readonly<{ kind: "available"; snapshot: StudioApplicationHistorySnapshot }>;

type Draft = Extract<StoredDefinitionDraft, { kind: "application" }>;
type HumanContext = Extract<SessionContext, { callerKind: "human" }>;
type ExpectedSnapshot = z.infer<typeof expectedSnapshotSchema>;
class HistoryRefused extends Error { readonly code = "42501"; }
class HistoryConflict extends Error { readonly code = "40001"; }
class HistoryStorageUnavailable extends Error {}

const targetFacts: BuilderTargetFactsReader = async (transaction, _scope, rootId) => {
  if (rootId === undefined) throw new HistoryRefused();
  const rows = await transaction.query<DatabaseRow>`
    select outcome, application_origin_kind
    from vortex_definition.read_builder_application_root_classification(${rootId}::uuid)
  `;
  if (rows.length !== 1 || rows[0]?.outcome !== "available" ||
    rows[0]?.application_origin_kind !== "ordinary") throw new HistoryRefused();
  return { isSystemApplication: false };
};

/** Match the trusted transport context to this request's freshly resolved human and scope. */
const readHumanContext = async (
  transaction: RequestDatabaseTransaction, scope: SelectedOrganizationScope,
  session: IdentitySession, issuedAt: string,
): Promise<HumanContext> => {
  const rows = await transaction.query<DatabaseRow>`
    select vortex_access.validated_human_request_context() as request_context,
      pg_catalog.clock_timestamp() as checked_at
  `;
  const row = rows[0];
  const transport = z.record(z.string(), z.unknown()).safeParse(row?.request_context);
  if (rows.length !== 1 || !transport.success || transport.data.channel !== "web")
    throw new HistoryRefused();
  const parsed = sessionContextSchema.safeParse(Object.fromEntries(
    Object.entries(transport.data).filter(([key]) => key !== "channel"),
  ));
  const clock = timestampSchema.safeParse(databaseTimestamp(row?.checked_at));
  if (!parsed.success || parsed.data.callerKind !== "human" || !clock.success)
    throw new HistoryRefused();
  const context = parsed.data;
  const now = Date.parse(clock.data);
  if (Object.hasOwn(scope, "applicationRootId") || Object.hasOwn(context, "applicationRootId") ||
    context.delegatedContext !== undefined || context.supportContext !== undefined ||
    !sameId(context.tenantId, scope.tenantId) || !sameId(context.organizationId, scope.organizationId) ||
    !sameId(context.organizationAccountId, scope.organizationAccountId) ||
    context.accessVersion !== scope.accessVersion ||
    !sameId(context.identityId, session.identityId) || !sameId(context.sessionId, session.sessionId) ||
    context.authenticationStrength !== session.authenticationStrength || context.issuedAt !== issuedAt ||
    context.expiresAt !== session.accessTokenExpiresAt || context.accessTokenIssuedAt !==
      (session.primaryAuthenticatedAt !== undefined || session.multiFactorAuthenticatedAt !== undefined
        ? session.accessTokenIssuedAt : undefined) ||
    context.primaryAuthenticatedAt !== session.primaryAuthenticatedAt ||
    context.multiFactorAuthenticatedAt !== session.multiFactorAuthenticatedAt ||
    Date.parse(context.issuedAt) > now || Date.parse(context.expiresAt) <= now ||
    Date.parse(context.issuedAt) >= Date.parse(context.expiresAt)) throw new HistoryRefused();
  return context;
};

/** A live draft-management decision and database clock fence the complete safe projection. */
const assertLiveCompletion = async (
  transaction: RequestDatabaseTransaction, context: HumanContext,
  entries: readonly DefinitionReleaseMetadata[],
): Promise<void> => {
  const key = "platform.organization.definition_drafts.manage";
  const permission = platformPermissionDeclarations.find((entry) => entry.key === key);
  if (permission === undefined) throw new HistoryRefused();
  const declaration = organizationAccessDeclarationSchema.parse({
    operationKey: key, action: { actionKind: permission.actionKind }, target: { kind: "organization" },
    requiredPermission: { ownerKind: "platform", ownerId: platformPermissionOwnerId,
      permissionId: permission.permissionId },
    recentAuthentication: { kind: "none" }, authority: { kind: "permission" },
  });
  const rows = await transaction.query<DatabaseRow>`
    select eligibility.*, pg_catalog.clock_timestamp() as completed_at
    from vortex_access.evaluate_organization_permission_eligibility(
      ${JSON.stringify(declaration)}::text::jsonb
    ) as eligibility
  `;
  const row = rows[0];
  const decision = organizationPermissionEligibilitySchema.safeParse({
    outcome: row?.outcome, operationKey: row?.operation_key, target: { kind: row?.target_kind },
    organizationId: row?.organization_id, organizationAccountId: row?.organization_account_id,
    accessVersion: databaseRevision(row?.access_version), checkedAt: databaseTimestamp(row?.checked_at),
    correlationId: row?.correlation_id,
    ...(row?.outcome === "eligible" ? { validUntil: databaseTimestamp(row.valid_until) }
      : { reasonCode: row?.reason_code }),
  });
  const clock = timestampSchema.safeParse(databaseTimestamp(row?.completed_at));
  if (rows.length !== 1 || !decision.success || decision.data.outcome !== "eligible" ||
    !clock.success || decision.data.operationKey !== key || decision.data.target.kind !== "organization" ||
    row?.target_application_root_id !== null || row?.reason_code !== null ||
    !sameId(decision.data.organizationId, context.organizationId) ||
    !sameId(decision.data.organizationAccountId, context.organizationAccountId) ||
    decision.data.accessVersion !== context.accessVersion ||
    !sameId(decision.data.correlationId, context.correlationId) ||
    Date.parse(decision.data.checkedAt) > Date.parse(clock.data) ||
    Date.parse(decision.data.validUntil) <= Date.parse(clock.data)) throw new HistoryRefused();
  const finalRows = await transaction.query<DatabaseRow>`select pg_catalog.clock_timestamp() as completed_at`;
  const finalClock = timestampSchema.safeParse(databaseTimestamp(finalRows[0]?.completed_at));
  if (finalRows.length !== 1 || !finalClock.success || Date.parse(finalClock.data) >=
    Math.min(Date.parse(context.expiresAt), Date.parse(decision.data.validUntil))) throw new HistoryRefused();
  if (entries.some((entry) => Date.parse(entry.publishedAt) > Date.parse(finalClock.data)))
    throw new HistoryStorageUnavailable();
};

const safeFailure = (error: unknown): StudioApplicationHistoryFailure => {
  if (error instanceof HistoryConflict ||
    (typeof error === "object" && error !== null && "code" in error && error.code === "40001") ||
    (error instanceof DefinitionStoreError && error.code === "DEFINITION_DRAFT_STALE_OR_MISSING"))
    return { kind: "conflict" };
  if (error instanceof HistoryRefused || error instanceof BuilderAuthorityError ||
    (typeof error === "object" && error !== null && "code" in error && error.code === "42501") ||
    (error instanceof DefinitionStoreError && ["DEFINITION_CONTEXT_REFUSED", "DEFINITION_ROOT_MISSING",
      "INVALID_DEFINITION_COMMAND"].includes(error.code))) return { kind: "refused" };
  return { kind: "temporarily_unavailable" };
};

/** Returning available waits for the original transaction to complete normally. */
const executeRead = async <Value>(
  candidateOrganizationId: string, candidateRootId: string, expected: ExpectedSnapshot | undefined,
  read: (transaction: RequestDatabaseTransaction, draft: Draft,
    snapshot: StudioApplicationHistorySnapshot) => Promise<Readonly<{
      value: Value; metadata: readonly DefinitionReleaseMetadata[];
    }>>,
): Promise<StudioApplicationHistoryFailure | Readonly<{ kind: "available"; value: Value }>> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const root = applicationRootIdSchema.safeParse(candidateRootId);
  if (!organization.success || !root.success) return { kind: "refused" };
  let failure: StudioApplicationHistoryFailure | undefined;
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active") return resolved.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" } : { kind: "refused" };
    const result = await humanOrganizationRequests().run(resolved.session,
      { organizationId: organization.data }, async (transaction, scope, issuedAt): Promise<Value> => {
        try {
          if (!sameId(scope.organizationId, organization.data)) throw new HistoryRefused();
          const context = await readHumanContext(transaction, scope, resolved.session, issuedAt);
          const authority = createBuilderAuthority({ transaction, scope, targetFacts });
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: root.data });
          const draft = await readApplicationDefinitionDraft(transaction, scope, { rootId: root.data });
          const anchor = draft.publishedRevision ?? null;
          if (expected !== undefined && (draft.draftRevision !== expected.draftRevision ||
            draft.sourceFingerprint !== expected.sourceFingerprint || anchor !== expected.anchorReleaseRevision))
            throw new HistoryConflict();
          const snapshot = snapshotSchema.parse({
            organizationId: scope.organizationId, rootId: draft.rootId, definitionKey: draft.key,
            draftRevision: draft.draftRevision, sourceFingerprint: draft.sourceFingerprint,
            anchorReleaseRevision: anchor, correlationId: context.correlationId,
          });
          const output = await read(transaction, draft, snapshot);
          const final = await readApplicationDefinitionDraft(transaction, scope,
            { rootId: root.data, expectedDraftRevision: draft.draftRevision });
          if (canonicalJson(final) !== canonicalJson(draft)) throw new HistoryConflict();
          await targetFacts(transaction, scope, root.data);
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: root.data });
          const completion = await readHumanContext(transaction, scope, resolved.session, issuedAt);
          if (canonicalJson(completion) !== canonicalJson(context)) throw new HistoryRefused();
          await assertLiveCompletion(transaction, completion, output.metadata);
          return output.value;
        } catch (error) {
          failure = safeFailure(error);
          // Even expected refusals and conflicts leave through the original transaction.
          throw error;
        }
      });
    if (result.kind === "available") return { kind: "available", value: result.value };
    return failure ?? (result.kind === "unavailable" ? { kind: "refused" }
      : { kind: "temporarily_unavailable" });
  } catch (error) { return failure ?? safeFailure(error); }
};

const readPage = async (
  transaction: RequestDatabaseTransaction, rootId: string, anchor: number,
  after: number | null, size: number, exactRevision?: number,
): Promise<Readonly<{ entries: readonly DefinitionReleaseMetadata[]; nextAfterReleaseRevision: number | null }>> => {
  const rows = await transaction.query<DatabaseRow>`
    select vortex_definition.read_publication_history_page(
      ${rootId}::uuid, ${anchor}::bigint, ${after}::bigint, ${size}::integer
    ) as publication_history_page
  `;
  const parsed = pageSchema.safeParse(rows[0]?.publication_history_page);
  if (rows.length !== 1 || !parsed.success || parsed.data.anchorReleaseRevision !== anchor ||
    parsed.data.entries.length > size) throw new HistoryStorageUnavailable();
  const page = parsed.data;
  let previous = after;
  const entries = page.entries.map((entry, index) => {
    const publication = entry.release.publication;
    if (exactRevision === undefined && after !== null && index === 0 &&
      entry.previousReleaseRevision !== after) throw new HistoryRefused();
    if (!sameId(publication.rootId, rootId) || publication.kind !== "application" ||
      publication.revision <= (previous ?? 0) || publication.revision > anchor ||
      (exactRevision === undefined ? entry.previousReleaseRevision !== previous :
        entry.previousReleaseRevision !== null && entry.previousReleaseRevision >= publication.revision))
      throw new HistoryStorageUnavailable();
    if (exactRevision !== undefined && publication.revision !== exactRevision) throw new HistoryRefused();
    const metadata = definitionReleaseMetadataSchema.safeParse({
      releaseRevision: publication.revision, releaseVersion: publication.releaseVersion,
      sourceFingerprint: entry.release.evidence.authoredSourceFingerprint,
      contentFingerprint: publication.contentFingerprint, releaseNote: entry.release.releaseNote,
      publishedAt: publication.publishedAt, publishedBy: publication.publishedBy,
      isCurrent: publication.revision === anchor,
    });
    if (!metadata.success) throw new HistoryStorageUnavailable();
    previous = publication.revision;
    return metadata.data;
  });
  if (page.nextAfterReleaseRevision === null ? previous !== anchor :
    page.nextAfterReleaseRevision !== previous || previous === null || previous >= anchor || entries.length !== size)
    throw new HistoryStorageUnavailable();
  return { entries, nextAfterReleaseRevision: page.nextAfterReleaseRevision };
};

/** Lightweight navigation access: no compilation, release paging or workspace imports. */
export const loadStudioApplicationHistoryAccess = async (
  organizationId: string, rootId: string,
): Promise<StudioApplicationHistoryAccessResult> => {
  const result = await executeRead(organizationId, rootId, undefined,
    async (_transaction, _draft, snapshot) => ({ value: snapshot, metadata: [] }));
  return result.kind === "available" ? { kind: "available", snapshot: result.value } : result;
};

export const listStudioApplicationReleaseHistory = async (
  organizationId: string, candidate: unknown,
): Promise<StudioApplicationHistoryListResult> => {
  const request = listRequestSchema.safeParse(candidate);
  if (!request.success) return { kind: "refused" };
  const command = request.data;
  if (command.kind === "next" && (command.expected.anchorReleaseRevision === null ||
    command.afterReleaseRevision >= command.expected.anchorReleaseRevision)) return { kind: "refused" };
  const result = await executeRead(organizationId, command.rootId,
    command.kind === "next" ? command.expected : undefined, async (transaction, _draft, snapshot) => {
      const page = snapshot.anchorReleaseRevision === null
        ? { entries: [], nextAfterReleaseRevision: null }
        : await readPage(transaction, snapshot.rootId, snapshot.anchorReleaseRevision,
          command.kind === "next" ? command.afterReleaseRevision : null, pageSize);
      return { value: { snapshot, ...page }, metadata: page.entries };
    });
  return result.kind === "available" ? { kind: "available", page: result.value } : result;
};

export const inspectStudioApplicationReleaseHistory = async (
  organizationId: string, candidate: unknown,
): Promise<StudioApplicationHistoryInspectResult> => {
  const request = inspectRequestSchema.safeParse(candidate);
  if (!request.success || request.data.expected.anchorReleaseRevision === null ||
    request.data.releaseRevision > request.data.expected.anchorReleaseRevision) return { kind: "refused" };
  const command = request.data;
  const result = await executeRead(organizationId, command.rootId, command.expected,
    async (transaction, _draft, snapshot) => {
      if (snapshot.anchorReleaseRevision === null) throw new HistoryConflict();
      // This selector can sit in a revision gap. It is never a list continuation cursor.
      const page = await readPage(transaction, snapshot.rootId, snapshot.anchorReleaseRevision,
        command.releaseRevision - 1, 1, command.releaseRevision);
      const metadata = page.entries[0];
      if (metadata === undefined || page.entries.length !== 1) throw new HistoryRefused();
      return { value: { snapshot, metadata }, metadata: [metadata] };
    });
  return result.kind === "available" ? { kind: "available", ...result.value } : result;
};
