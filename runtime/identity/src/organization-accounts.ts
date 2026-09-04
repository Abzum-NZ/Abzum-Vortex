import "server-only";

import { createHash, randomBytes } from "node:crypto";
import {
  createOrganizationInvitationCommandSchema,
  ensureIdentityProjectionCommandSchema,
  identityProjectionSchema,
  invitationSchema,
  organizationAccountSchema,
  revokeOrganizationInvitationCommandSchema,
  verifiedIdentitySchema,
  type CreateOrganizationInvitationCommand,
  type EnsureIdentityProjectionCommand,
  type IdentityProjection,
  type Invitation,
  type OrganizationAccount,
  type RevokeOrganizationInvitationCommand,
  type SessionContext,
  type VerifiedIdentity,
} from "@vortex/contracts";
import {
  withRequestTransaction,
  withRuntimeTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
  type RuntimeDatabaseTransaction,
} from "@vortex/db";

export const organizationAccountErrorCodes = [
  "INVALID_ORGANIZATION_ACCOUNT_COMMAND",
  "INVALID_ORGANIZATION_ACCOUNT_STORAGE_RESULT",
  "ORGANIZATION_ACCOUNT_CONTEXT_REFUSED",
  "ORGANIZATION_ACCOUNT_STALE_OR_UNAVAILABLE",
  "ORGANIZATION_ACCOUNT_OPERATION_FAILED",
] as const;

export type OrganizationAccountErrorCode = (typeof organizationAccountErrorCodes)[number];

export class OrganizationAccountError extends Error {
  readonly code: OrganizationAccountErrorCode;

  constructor(code: OrganizationAccountErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "OrganizationAccountError";
    this.code = code;
  }
}

export interface CreatedOrganizationInvitation {
  readonly invitation: Invitation;
  readonly invitationSecret: string;
}

type RuntimeTransactionRunner = <Result>(
  operation: (transaction: RuntimeDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;

type RequestTransactionRunner = <Result>(
  context: SessionContext,
  operation: (transaction: RequestDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;

interface OrganizationAccountStoreDependencies {
  readonly runtimeTransaction?: RuntimeTransactionRunner;
  readonly requestTransaction?: RequestTransactionRunner;
  readonly generateInvitationSecret?: () => string;
}

type IdentityProjectionRow = DatabaseRow & {
  identity_id: unknown;
  state: unknown;
  created_at: unknown;
  state_changed_at: unknown;
  state_changed_by: unknown;
  state_change_correlation_id: unknown;
  revision: unknown;
};

type OrganizationAccountRow = DatabaseRow & {
  organization_account_id: unknown;
  organization_id: unknown;
  identity_id: unknown;
  display_name: unknown;
  state: unknown;
  language: unknown;
  time_zone: unknown;
  invitation_id: unknown;
  activated_at: unknown;
  suspended_at: unknown;
  closed_at: unknown;
  changed_at: unknown;
  state_changed_at: unknown;
  state_changed_by: unknown;
  state_change_correlation_id: unknown;
  revision: unknown;
};

type InvitationRow = DatabaseRow & {
  invitation_id: unknown;
  organization_id: unknown;
  invited_email: unknown;
  invited_by: unknown;
  created_at: unknown;
  invited_at: unknown;
  expires_at: unknown;
  revoked_at: unknown;
  revoked_by: unknown;
  accepted_at: unknown;
  accepted_organization_account_id: unknown;
  changed_at: unknown;
  revision: unknown;
};

const timestamp = (value: unknown): unknown =>
  value instanceof Date && Number.isFinite(value.valueOf()) ? value.toISOString() : value;

const optional = <Value>(value: Value | null | undefined): Value | undefined =>
  value === null || value === undefined ? undefined : value;

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};

const parseIdentityProjection = (row: IdentityProjectionRow): IdentityProjection =>
  identityProjectionSchema.parse({
    identityId: row.identity_id,
    state: row.state,
    createdAt: timestamp(row.created_at),
    stateChangedAt: timestamp(row.state_changed_at),
    stateChangedBy: row.state_changed_by,
    stateChangeCorrelationId: row.state_change_correlation_id,
    revision: revision(row.revision),
  });

const accountCandidate = (row: OrganizationAccountRow): unknown => ({
  organizationAccountId: row.organization_account_id,
  organizationId: row.organization_id,
  identityId: row.identity_id,
  displayName: optional(row.display_name),
  state: row.state,
  language: optional(row.language),
  timeZone: optional(row.time_zone),
  invitationId: optional(row.invitation_id),
  activatedAt: timestamp(row.activated_at),
  suspendedAt: optional(timestamp(row.suspended_at)),
  closedAt: optional(timestamp(row.closed_at)),
  changedAt: timestamp(row.changed_at),
  stateChangedAt: timestamp(row.state_changed_at),
  stateChangedBy: row.state_changed_by,
  stateChangeCorrelationId: row.state_change_correlation_id,
  revision: revision(row.revision),
});

const parseOrganizationAccount = (row: OrganizationAccountRow): OrganizationAccount =>
  organizationAccountSchema.parse(accountCandidate(row));

const parseInvitation = (row: InvitationRow): Invitation =>
  invitationSchema.parse({
    invitationId: row.invitation_id,
    organizationId: row.organization_id,
    invitedEmail: row.invited_email,
    invitedBy: row.invited_by,
    createdAt: timestamp(row.created_at),
    invitedAt: timestamp(row.invited_at),
    expiresAt: timestamp(row.expires_at),
    revokedAt: optional(timestamp(row.revoked_at)),
    revokedBy: optional(row.revoked_by),
    acceptedAt: optional(timestamp(row.accepted_at)),
    acceptedOrganizationAccountId: optional(row.accepted_organization_account_id),
    changedAt: timestamp(row.changed_at),
    revision: revision(row.revision),
  });

const mapStorageFailure = (error: unknown): OrganizationAccountError => {
  const databaseCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : undefined;

  if (databaseCode === "22023" || databaseCode === "23514")
    return new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");
  if (databaseCode === "42501")
    return new OrganizationAccountError("ORGANIZATION_ACCOUNT_CONTEXT_REFUSED");
  if (databaseCode === "40001" || databaseCode === "23503" || databaseCode === "23505")
    return new OrganizationAccountError("ORGANIZATION_ACCOUNT_STALE_OR_UNAVAILABLE");
  return new OrganizationAccountError("ORGANIZATION_ACCOUNT_OPERATION_FAILED");
};

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const fingerprintSecret = (secret: string): string =>
  `sha256:${createHash("sha256").update(secret, "utf8").digest("hex")}`;

const requireOne = <Row extends DatabaseRow>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_STORAGE_RESULT");
  return rows[0];
};

export const createOrganizationAccountStore = (
  dependencies: OrganizationAccountStoreDependencies = {},
) => {
  const runtimeTransaction = dependencies.runtimeTransaction ?? withRuntimeTransaction;
  const requestTransaction = dependencies.requestTransaction ?? withRequestTransaction;
  const generateInvitationSecret =
    dependencies.generateInvitationSecret ?? (() => randomBytes(32).toString("base64url"));

  return Object.freeze({
    async ensureIdentityProjection(
      verifiedIdentity: VerifiedIdentity,
      command: EnsureIdentityProjectionCommand,
    ): Promise<IdentityProjection> {
      const verified = verifiedIdentitySchema.safeParse(verifiedIdentity);
      const parsed = ensureIdentityProjectionCommandSchema.safeParse(command);
      if (!verified.success || !parsed.success)
        throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");

      try {
        return await runtimeTransaction(async (transaction) => {
          const rows = await transaction.query<IdentityProjectionRow>`
            select *
            from vortex_identity.ensure_identity_projection(
              ${verified.data.identityId}::uuid,
              ${parsed.data.correlationId}::uuid
            )
          `;
          return parseIdentityProjection(requireOne(rows));
        });
      } catch (error) {
        if (error instanceof OrganizationAccountError) throw error;
        throw mapStorageFailure(error);
      }
    },

    async listOrganizationAccounts(
      verifiedIdentity: VerifiedIdentity,
    ): Promise<readonly OrganizationAccount[]> {
      const verified = verifiedIdentitySchema.safeParse(verifiedIdentity);
      if (!verified.success)
        throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");

      try {
        return await runtimeTransaction(async (transaction) => {
          const rows = await transaction.query<OrganizationAccountRow>`
            select *
            from vortex_identity.list_organization_accounts(${verified.data.identityId}::uuid)
          `;
          return rows.map(parseOrganizationAccount);
        });
      } catch (error) {
        if (error instanceof OrganizationAccountError) throw error;
        throw mapStorageFailure(error);
      }
    },

    async createInvitationAfterAuthorization(
      context: SessionContext,
      command: CreateOrganizationInvitationCommand,
    ): Promise<CreatedOrganizationInvitation> {
      const parsed = createOrganizationInvitationCommandSchema.safeParse(command);
      if (!parsed.success)
        throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");

      const invitationSecret = generateInvitationSecret();
      if (Buffer.byteLength(invitationSecret, "utf8") < 32)
        throw new OrganizationAccountError("ORGANIZATION_ACCOUNT_OPERATION_FAILED");
      const tokenFingerprint = fingerprintSecret(invitationSecret);
      const invitedEmail = normalizeEmail(parsed.data.invitedEmail);

      try {
        const invitation = await requestTransaction(context, async (transaction) => {
          const rows = await transaction.query<InvitationRow>`
            select *
            from vortex_identity.create_organization_invitation(
              ${invitedEmail}::text,
              ${tokenFingerprint}::text,
              ${parsed.data.expiresAt}::timestamptz
            )
          `;
          return parseInvitation(requireOne(rows));
        });
        return { invitation, invitationSecret };
      } catch (error) {
        if (error instanceof OrganizationAccountError) throw error;
        throw mapStorageFailure(error);
      }
    },

    async revokeInvitationAfterAuthorization(
      context: SessionContext,
      command: RevokeOrganizationInvitationCommand,
    ): Promise<Invitation> {
      const parsed = revokeOrganizationInvitationCommandSchema.safeParse(command);
      if (!parsed.success)
        throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");
      try {
        return await requestTransaction(context, async (transaction) => {
          const rows = await transaction.query<InvitationRow>`
            select * from vortex_identity.revoke_organization_invitation(
              ${parsed.data.invitationId}::uuid,
              ${parsed.data.expectedRevision}::bigint
            )
          `;
          return parseInvitation(requireOne(rows));
        });
      } catch (error) {
        if (error instanceof OrganizationAccountError) throw error;
        throw mapStorageFailure(error);
      }
    },
  });
};

const defaultStore = createOrganizationAccountStore();

export const ensureIdentityProjection = defaultStore.ensureIdentityProjection;
export const listOrganizationAccounts = defaultStore.listOrganizationAccounts;
export const createInvitationAfterAuthorization = defaultStore.createInvitationAfterAuthorization;
export const revokeInvitationAfterAuthorization = defaultStore.revokeInvitationAfterAuthorization;
