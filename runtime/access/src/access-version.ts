import "server-only";

import { createHash } from "node:crypto";
import {
  acceptOrganizationInvitationCommandSchema,
  invitationAcceptanceWithAccessVersionSchema,
  organizationAccountSchema,
  verifiedIdentitySchema,
  type AcceptOrganizationInvitationCommand,
  type InvitationAcceptanceWithAccessVersion,
  type OrganizationAccount,
  type VerifiedIdentity,
} from "@vortex/contracts";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RuntimeDatabaseTransaction,
} from "@vortex/db";

export const accessVersionErrorCodes = [
  "INVALID_ACCESS_VERSION_COMMAND",
  "INVALID_ACCESS_VERSION_STORAGE_RESULT",
  "ACCESS_VERSION_SCOPE_UNAVAILABLE",
  "ACCESS_VERSION_STALE_OR_UNAVAILABLE",
  "ACCESS_VERSION_EXHAUSTED",
  "ACCESS_VERSION_OPERATION_FAILED",
] as const;

export type AccessVersionErrorCode = (typeof accessVersionErrorCodes)[number];

export class AccessVersionError extends Error {
  readonly code: AccessVersionErrorCode;

  constructor(code: AccessVersionErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "AccessVersionError";
    this.code = code;
  }
}

type RuntimeTransactionRunner = <Result>(
  operation: (transaction: RuntimeDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;

interface AccessVersionStoreDependencies {
  readonly runtimeTransaction?: RuntimeTransactionRunner;
}

type AcceptanceRow = DatabaseRow & {
  outcome: unknown;
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
  access_version: unknown;
};

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};

const timestamp = (value: unknown): unknown =>
  value instanceof Date && Number.isFinite(value.valueOf()) ? value.toISOString() : value;

const optional = <Value>(value: Value | null | undefined): Value | undefined =>
  value === null || value === undefined ? undefined : value;

const requireOne = <Row extends DatabaseRow>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new AccessVersionError("INVALID_ACCESS_VERSION_STORAGE_RESULT");
  return rows[0];
};

const parseAccount = (row: AcceptanceRow): OrganizationAccount => {
  const parsed = organizationAccountSchema.safeParse({
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
  if (!parsed.success) throw new AccessVersionError("INVALID_ACCESS_VERSION_STORAGE_RESULT");
  return parsed.data;
};

const parseAcceptance = (row: AcceptanceRow): InvitationAcceptanceWithAccessVersion => {
  const candidate =
    row.outcome === "unavailable" || row.outcome === "identity_inactive"
      ? { outcome: row.outcome }
      : {
          outcome: row.outcome,
          account: parseAccount(row),
          accessVersion: revision(row.access_version),
        };
  const parsed = invitationAcceptanceWithAccessVersionSchema.safeParse(candidate);
  if (!parsed.success) throw new AccessVersionError("INVALID_ACCESS_VERSION_STORAGE_RESULT");
  return parsed.data;
};

const mapStorageFailure = (error: unknown): AccessVersionError => {
  const databaseCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : undefined;

  if (databaseCode === "22023") return new AccessVersionError("INVALID_ACCESS_VERSION_COMMAND");
  if (databaseCode === "42501") return new AccessVersionError("ACCESS_VERSION_SCOPE_UNAVAILABLE");
  if (databaseCode === "22003") return new AccessVersionError("ACCESS_VERSION_EXHAUSTED");
  if (databaseCode === "40001" || databaseCode === "23503" || databaseCode === "23505")
    return new AccessVersionError("ACCESS_VERSION_STALE_OR_UNAVAILABLE");
  return new AccessVersionError("ACCESS_VERSION_OPERATION_FAILED");
};

const fingerprintSecret = (secret: string): string =>
  `sha256:${createHash("sha256").update(secret, "utf8").digest("hex")}`;

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const createAccessVersionStore = (dependencies: AccessVersionStoreDependencies = {}) => {
  const runtimeTransaction = dependencies.runtimeTransaction ?? withRuntimeTransaction;

  return Object.freeze({
    async acceptOrganizationInvitation(
      verifiedIdentity: VerifiedIdentity,
      command: AcceptOrganizationInvitationCommand,
    ): Promise<InvitationAcceptanceWithAccessVersion> {
      const verified = verifiedIdentitySchema.safeParse(verifiedIdentity);
      const parsed = acceptOrganizationInvitationCommandSchema.safeParse(command);
      if (!verified.success || !parsed.success)
        throw new AccessVersionError("INVALID_ACCESS_VERSION_COMMAND");

      const tokenFingerprint = fingerprintSecret(parsed.data.invitationSecret);
      const verifiedEmail = normalizeEmail(verified.data.verifiedPrimaryEmail);

      try {
        return await runtimeTransaction(async (transaction) => {
          const rows = await transaction.query<AcceptanceRow>`
            select *
            from vortex_access.accept_organization_invitation(
              ${tokenFingerprint}::text,
              ${verified.data.identityId}::uuid,
              ${verifiedEmail}::text,
              ${parsed.data.displayName ?? null}::text,
              ${parsed.data.correlationId}::uuid
            )
          `;
          return parseAcceptance(requireOne(rows));
        });
      } catch (error) {
        if (error instanceof AccessVersionError) throw error;
        throw mapStorageFailure(error);
      }
    },
  });
};

const defaultStore = createAccessVersionStore();

export const acceptOrganizationInvitation = defaultStore.acceptOrganizationInvitation;
