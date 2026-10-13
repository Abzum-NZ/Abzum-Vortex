import "server-only";

import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import type { PlatformPermissionSource } from "../access/platform-permissions";
import {
  organizationAccessDeclarationSchema,
  storedDefinitionDraftSchema,
  type OrganizationAccessDeclaration,
  type SessionContext,
  type StoredDefinitionDraft,
} from "../schema";
import { canonicalJson } from "./canonical-json-definition";
import type { DefinitionHistoryRepository } from "./definition-history";
import { DefinitionError, unexpectedDefinitionFailure } from "./definition-error";

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

const asCandidate = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

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

const isHumanOrganizationOnlyContext = (
  context: SessionContext,
): context is Extract<SessionContext, { callerKind: "human" }> =>
  context.callerKind === "human" &&
  !Object.hasOwn(context, "applicationRootId") &&
  !Object.hasOwn(context, "delegatedContext") &&
  !Object.hasOwn(context, "supportContext");

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
 * All restore reads and the conditional mutation share one request transaction.
 * The verification callback receives evidence only inside that transaction and
 * returns service-derived data that the database checks against its release row.
 */
export const createDatabaseDefinitionHistoryRepository = (
  transaction: RequestDatabaseTransaction,
  permissions: PlatformPermissionSource,
): DefinitionHistoryRepository => ({
  async list(_context, command) {
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

  async readMetadata(_context, command) {
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

  async restore(context, command, verify, verifyRestored) {
    const evidenceRows = await transaction.query<RestoreEvidenceRow>`
      select vortex_definition.read_restore_release_evidence(
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
    if (!isHumanOrganizationOnlyContext(context)) throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");

    const verifiedDraft = await verifyRestored(restored);
    const currentEvidenceRows = await transaction.query<RestoreEvidenceRow>`
      select vortex_definition.read_restore_release_evidence(
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
