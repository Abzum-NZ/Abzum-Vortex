import "server-only";

import { z } from "zod";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import { DefinitionError } from "../definition/definition-error";
import { timestampSchema, type IdentityAuthorityId } from "../catalogue/identifiers";
import {
  databaseRevision,
  databaseTimestamp,
  describeFailure,
  sameId,
} from "../catalogue/runtime-primitives";
import {
  sessionContextSchema,
  type IdentitySession,
  type SelectedOrganizationScope,
  type SessionContext,
} from "./identity-access";
import {
  organizationAccessDeclarationSchema,
  organizationPermissionEligibilitySchema,
} from "./organization-access-decision";
import type { PlatformPermissionSource } from "./platform-permissions";

export type LiveHumanContext = Extract<SessionContext, { callerKind: "human" }>;
export type LiveOrganizationAccessDeclaration = z.infer<typeof organizationAccessDeclarationSchema>;

/** Stable reason codes; the one refusal carries the code and the underlying cause. */
export type LiveContextRefusalReason =
  | "request_context_invalid"
  | "session_context_mismatch"
  | "permission_undeclared"
  | "permission_not_eligible"
  | "request_deadline_passed";

/**
 * The one refusal of the live-context checks. It is a definition context refusal, so every
 * boundary that already maps `DEFINITION_CONTEXT_REFUSED` to a safe refusal keeps doing so, and
 * `reason` names exactly which check failed.
 */
export class LiveContextRefused extends DefinitionError<"DEFINITION_CONTEXT_REFUSED"> {
  readonly reason: LiveContextRefusalReason;

  constructor(reason: LiveContextRefusalReason, options?: ErrorOptions) {
    super("DEFINITION_CONTEXT_REFUSED", { ...options, detail: reason });
    this.name = "LiveContextRefused";
    this.reason = reason;
  }
}

const refuse = (reason: LiveContextRefusalReason, cause?: unknown): LiveContextRefused => {
  console.error(
    `[access] live context refused reason=${reason}${
      cause === undefined ? "" : ` cause=${describeFailure(cause)}`
    }`,
  );
  return new LiveContextRefused(reason, cause === undefined ? undefined : { cause });
};

/** The database transaction's own clock; the one time source of every live check. */
export const readDatabaseClock = async (
  transaction: RequestDatabaseTransaction,
): Promise<number> => {
  const rows =
    await transaction.query<DatabaseRow>`select pg_catalog.clock_timestamp() as completed_at`;
  const parsed = timestampSchema.safeParse(databaseTimestamp(rows[0]?.completed_at));
  if (rows.length !== 1 || !parsed.success)
    throw new DefinitionError("INVALID_DEFINITION_STORAGE_RESULT", { cause: parsed.error });
  return Date.parse(parsed.data);
};

export type LiveHumanContextRequest = Readonly<{
  scope: SelectedOrganizationScope;
  session: IdentitySession;
  issuedAt: string;
  /** When given, the context must also have been issued under this identity authority. */
  identityAuthorityId?: IdentityAuthorityId;
}>;

/**
 * Reads the protected human request context of the open transaction and proves it is the context
 * of this request's freshly resolved session and selected scope (organisation, or the one
 * application the scope names) and is still inside its validity window on the database clock.
 */
export const readLiveHumanContext = async (
  transaction: RequestDatabaseTransaction,
  request: LiveHumanContextRequest,
): Promise<LiveHumanContext> => {
  const { scope, session, issuedAt, identityAuthorityId } = request;
  const rows = await transaction.query<DatabaseRow>`
    select vortex_access.validated_human_request_context() as request_context,
      pg_catalog.clock_timestamp() as checked_at
  `;
  const row = rows[0];
  const transport = z.record(z.string(), z.unknown()).safeParse(row?.request_context);
  if (rows.length !== 1 || !transport.success || transport.data.channel !== "web")
    throw refuse("request_context_invalid");
  const parsed = sessionContextSchema.safeParse(
    Object.fromEntries(Object.entries(transport.data).filter(([key]) => key !== "channel")),
  );
  const clock = timestampSchema.safeParse(databaseTimestamp(row?.checked_at));
  if (!parsed.success || parsed.data.callerKind !== "human" || !clock.success)
    throw refuse(
      "request_context_invalid",
      !parsed.success ? parsed.error : !clock.success ? clock.error : undefined,
    );
  const context = parsed.data;
  const now = Date.parse(clock.data);
  const hasAuthenticationEvidence =
    session.primaryAuthenticatedAt !== undefined ||
    session.multiFactorAuthenticatedAt !== undefined;
  const mismatches = {
    applicationRootId:
      scope.applicationRootId === undefined
        ? Object.hasOwn(context, "applicationRootId")
        : !sameId(context.applicationRootId, scope.applicationRootId),
    delegatedContext: context.delegatedContext !== undefined,
    supportContext: context.supportContext !== undefined,
    identityAuthorityId:
      identityAuthorityId !== undefined &&
      !sameId(context.identityAuthorityId, identityAuthorityId),
    tenantId: !sameId(context.tenantId, scope.tenantId),
    organizationId: !sameId(context.organizationId, scope.organizationId),
    organizationAccountId: !sameId(context.organizationAccountId, scope.organizationAccountId),
    accessVersion: context.accessVersion !== scope.accessVersion,
    identityId: !sameId(context.identityId, session.identityId),
    sessionId: !sameId(context.sessionId, session.sessionId),
    authenticationStrength: context.authenticationStrength !== session.authenticationStrength,
    issuedAt: context.issuedAt !== issuedAt,
    expiresAt: context.expiresAt !== session.accessTokenExpiresAt,
    accessTokenIssuedAt:
      context.accessTokenIssuedAt !==
      (hasAuthenticationEvidence ? session.accessTokenIssuedAt : undefined),
    primaryAuthenticatedAt: context.primaryAuthenticatedAt !== session.primaryAuthenticatedAt,
    multiFactorAuthenticatedAt:
      context.multiFactorAuthenticatedAt !== session.multiFactorAuthenticatedAt,
    invalidClock: !Number.isFinite(now),
    issuedInFuture: Date.parse(context.issuedAt) > now,
    expired: Date.parse(context.expiresAt) <= now,
    invalidWindow: Date.parse(context.issuedAt) >= Date.parse(context.expiresAt),
  };
  const mismatchedFields = Object.entries(mismatches)
    .filter(([, mismatch]) => mismatch)
    .map(([field]) => field);
  if (mismatchedFields.length > 0)
    throw refuse("session_context_mismatch", new Error(JSON.stringify({ mismatchedFields })));
  return context;
};

/** The organisation-target permission declaration for a permission owned by one owner. */
export const organizationPermissionDeclaration = (
  permission: Readonly<{ key: string; actionKind: string; permissionId: string }>,
  ownerId: string,
): LiveOrganizationAccessDeclaration =>
  organizationAccessDeclarationSchema.parse({
    operationKey: permission.key,
    action: { actionKind: permission.actionKind },
    target: { kind: "organization" },
    requiredPermission: { ownerKind: "platform", ownerId, permissionId: permission.permissionId },
    recentAuthentication: { kind: "none" },
    authority: { kind: "permission" },
  });

/** The declaration of a platform permission by key; an undeclared key is refused. */
export const platformOrganizationPermissionDeclaration = (
  source: PlatformPermissionSource,
  key: string,
): LiveOrganizationAccessDeclaration => {
  const permission = source.declarations.find((entry) => entry.key === key);
  if (permission === undefined) throw refuse("permission_undeclared");
  return organizationPermissionDeclaration(permission, source.ownerId);
};

export type LivePermissionDecision = Readonly<{
  /** Epoch milliseconds until which the database says the decision holds. */
  validUntil: number;
  /** The database clock when the evaluation completed, in epoch milliseconds. */
  completedAt: number;
}>;

/**
 * Re-evaluates one organisation-target permission now, on the database, for the live context of
 * this transaction. A row read or written is not completion authority; this is.
 */
export const assertLivePermission = async (
  transaction: RequestDatabaseTransaction,
  declaration: LiveOrganizationAccessDeclaration,
  context: LiveHumanContext,
): Promise<LivePermissionDecision> => {
  const rows = await transaction.query<DatabaseRow>`
    select eligibility.*, pg_catalog.clock_timestamp() as completed_at
    from vortex_access.evaluate_organization_permission_eligibility(
      ${JSON.stringify(declaration)}::text::jsonb
    ) as eligibility
  `;
  const row = rows[0];
  const decision = organizationPermissionEligibilitySchema.safeParse({
    outcome: row?.outcome,
    operationKey: row?.operation_key,
    target: { kind: row?.target_kind },
    organizationId: row?.organization_id,
    organizationAccountId: row?.organization_account_id,
    accessVersion: databaseRevision(row?.access_version),
    checkedAt: databaseTimestamp(row?.checked_at),
    correlationId: row?.correlation_id,
    ...(row?.outcome === "eligible"
      ? { validUntil: databaseTimestamp(row.valid_until) }
      : { reasonCode: row?.reason_code }),
  });
  const clock = timestampSchema.safeParse(databaseTimestamp(row?.completed_at));
  if (
    rows.length !== 1 ||
    !decision.success ||
    decision.data.outcome !== "eligible" ||
    !clock.success ||
    decision.data.operationKey !== declaration.operationKey ||
    decision.data.target.kind !== "organization" ||
    row?.target_application_root_id !== null ||
    row?.reason_code !== null ||
    !sameId(decision.data.organizationId, context.organizationId) ||
    !sameId(decision.data.organizationAccountId, context.organizationAccountId) ||
    decision.data.accessVersion !== context.accessVersion ||
    !sameId(decision.data.correlationId, context.correlationId) ||
    Date.parse(decision.data.checkedAt) > Date.parse(clock.data) ||
    Date.parse(decision.data.validUntil) <= Date.parse(clock.data)
  )
    throw refuse(
      "permission_not_eligible",
      !decision.success
        ? decision.error
        : !clock.success
          ? clock.error
          : // Keep the database's own reason (for example a revoked role) for the operator log.
            new Error(
              `eligibility outcome=${decision.data.outcome} reason=${String(
                ("reasonCode" in decision.data ? decision.data.reasonCode : undefined) ??
                  row?.reason_code ??
                  "none",
              )}`,
            ),
    );
  return { validUntil: Date.parse(decision.data.validUntil), completedAt: Date.parse(clock.data) };
};

/**
 * The final fence of a completion: the database clock must still be before every deadline. It
 * returns that clock reading for the caller's own freshness checks.
 */
export const assertBeforeLiveDeadline = async (
  transaction: RequestDatabaseTransaction,
  deadline: number,
): Promise<number> => {
  const now = await readDatabaseClock(transaction);
  if (now >= deadline) throw refuse("request_deadline_passed");
  return now;
};
