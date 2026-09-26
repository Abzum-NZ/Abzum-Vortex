import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  activityIdSchema,
  closeOrganizationAccountCommandSchema,
  closeOrganizationAccountResultSchema,
  createOrganizationInvitationForAdministrationCommandSchema,
  createOrganizationInvitationForAdministrationResultSchema,
  listOrganizationAccountsCommandSchema,
  listOrganizationAccountsResultSchema,
  listOrganizationInvitationsCommandSchema,
  listOrganizationInvitationsResultSchema,
  organizationRuntimeSettingsSchema,
  reactivateOrganizationAccountCommandSchema,
  reactivateOrganizationAccountResultSchema,
  readOrganizationAccountCommandSchema,
  readOrganizationAccountResultSchema,
  readOrganizationInvitationCommandSchema,
  readOrganizationInvitationResultSchema,
  readOrganizationRuntimeSettingsCommandSchema,
  readOrganizationRuntimeSettingsResultSchema,
  revokeOrganizationInvitationForAdministrationCommandSchema,
  revokeOrganizationInvitationForAdministrationResultSchema,
  suspendOrganizationAccountCommandSchema,
  suspendOrganizationAccountResultSchema,
  updateOwnProfileCommandSchema,
  updateOwnProfileResultSchema,
  type CloseOrganizationAccountCommand,
  type CloseOrganizationAccountResult,
  type CreateOrganizationInvitationForAdministrationCommand,
  type CreateOrganizationInvitationForAdministrationResult,
  type IdentitySession,
  type ListOrganizationAccountsCommand,
  type ListOrganizationAccountsResult,
  type ListOrganizationInvitationsCommand,
  type ListOrganizationInvitationsResult,
  type OrganizationSelectionCandidate,
  type ReactivateOrganizationAccountCommand,
  type ReactivateOrganizationAccountResult,
  type ReadOrganizationAccountCommand,
  type ReadOrganizationAccountResult,
  type ReadOrganizationInvitationCommand,
  type ReadOrganizationInvitationResult,
  type ReadOrganizationRuntimeSettingsCommand,
  type ReadOrganizationRuntimeSettingsResult,
  type RevokeOrganizationInvitationForAdministrationCommand,
  type RevokeOrganizationInvitationForAdministrationResult,
  type SuspendOrganizationAccountCommand,
  type SuspendOrganizationAccountResult,
  type UpdateOwnProfileCommand,
  type UpdateOwnProfileResult,
} from "@vortex/contracts";
import type { DatabaseRow } from "@vortex/db";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "./human-organization-request";

type AccountPageRow = DatabaseRow & {
  organization_id: unknown;
  accounts: unknown;
  next_after_organization_account_id: unknown;
  access_version: unknown;
};

type AccountDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  account_summary: unknown;
  access_version: unknown;
};

type InvitationPageRow = DatabaseRow & {
  organization_id: unknown;
  invitations: unknown;
  next_after_invitation_id: unknown;
  access_version: unknown;
};

type InvitationDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  invitation: unknown;
  access_version: unknown;
};

type RuntimeSettingsRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  settings: unknown;
  access_version: unknown;
};

type AccountChangeRow = DatabaseRow & {
  outcome: unknown;
  operation: unknown;
  organization_id: unknown;
  organization_account_id: unknown;
  revision: unknown;
  correlation_id: unknown;
  accepted_at: unknown;
  access_version: unknown;
};

type InvitationChangeRow = DatabaseRow & {
  outcome: unknown;
  operation: unknown;
  organization_id: unknown;
  invitation_id: unknown;
  revision: unknown;
  correlation_id: unknown;
  accepted_at: unknown;
  access_version: unknown;
};

type ProfileChangeRow = DatabaseRow & {
  outcome: unknown;
  operation: unknown;
  organization_id: unknown;
  organization_account_id: unknown;
  account_summary: unknown;
  correlation_id: unknown;
  accepted_at: unknown;
  access_version: unknown;
};

export type OrganizationLocalAdministrationDependencies = HumanOrganizationRequestDependencies &
  Readonly<{ generateInvitationSecret?: () => string; activityId?: () => string }>;

const unavailable = (): Error => new Error("ORGANIZATION_LOCAL_ADMINISTRATION_UNAVAILABLE");

const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};

const timestamp = (value: unknown): unknown =>
  value instanceof Date && Number.isFinite(value.valueOf()) ? value.toISOString() : value;

const normalizeRevision = (value: unknown): unknown =>
  typeof value === "object" && value !== null
    ? { ...value, revision: revision((value as { revision?: unknown }).revision) }
    : value;

const normalizeInvitation = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value;
  const invitation = value as Record<string, unknown>;
  return {
    ...invitation,
    createdAt: timestamp(invitation.createdAt),
    invitedAt: timestamp(invitation.invitedAt),
    expiresAt: timestamp(invitation.expiresAt),
    ...(invitation.revokedAt === undefined ? {} : { revokedAt: timestamp(invitation.revokedAt) }),
    ...(invitation.acceptedAt === undefined
      ? {}
      : { acceptedAt: timestamp(invitation.acceptedAt) }),
    changedAt: timestamp(invitation.changedAt),
    revision: revision(invitation.revision),
  };
};

const requireOne = <Row>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined) throw unavailable();
  return rows[0];
};

const fingerprintSecret = (secret: string): string =>
  `sha256:${createHash("sha256").update(secret, "utf8").digest("hex")}`;

const matchesScope = (
  row: { organization_id: unknown; access_version: unknown },
  organizationId: string,
  accessVersion: number,
): boolean =>
  typeof row.organization_id === "string" &&
  sameUuid(row.organization_id, organizationId) &&
  revision(row.access_version) === accessVersion;

export const createOrganizationLocalAdministrationService = (
  dependencies: OrganizationLocalAdministrationDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const generateInvitationSecret =
    dependencies.generateInvitationSecret ?? (() => randomBytes(32).toString("base64url"));
  const newActivityId = dependencies.activityId ?? randomUUID;

  const accountChange = <Result>(
    row: AccountChangeRow,
    scope: { organizationId: string; accessVersion: number },
    expected: {
      operation:
        | "suspend_organization_account"
        | "reactivate_organization_account"
        | "close_organization_account";
      organizationAccountId: string;
      revision: number;
    },
    schema: { parse(candidate: unknown): Result },
  ): Result => {
    const result = schema.parse({
      outcome: row.outcome,
      operation: row.operation,
      organizationId: row.organization_id,
      organizationAccountId: row.organization_account_id,
      revision: revision(row.revision),
      correlationId: row.correlation_id,
      acceptedAt: timestamp(row.accepted_at),
      accessVersion: revision(row.access_version),
    });
    const checked = result as {
      outcome: "accepted" | "replayed";
      operation: string;
      organizationId: string;
      organizationAccountId: string;
      revision: number;
      accessVersion: number;
    };
    if (
      !sameUuid(checked.organizationId, scope.organizationId) ||
      !sameUuid(checked.organizationAccountId, expected.organizationAccountId) ||
      checked.operation !== expected.operation ||
      checked.revision !== expected.revision ||
      (checked.outcome === "accepted" && checked.accessVersion !== scope.accessVersion + 1)
    )
      throw unavailable();
    return result;
  };

  const invitationChange = <Result>(
    row: InvitationChangeRow,
    scope: { organizationId: string; accessVersion: number },
    expected: {
      operation: "create_organization_invitation" | "revoke_organization_invitation";
      invitationId?: string;
      revision: number;
    },
    schema: { parse(candidate: unknown): Result },
    invitationSecret?: string,
  ): Result => {
    const result = schema.parse({
      outcome: row.outcome,
      operation: row.operation,
      organizationId: row.organization_id,
      invitationId: row.invitation_id,
      revision: revision(row.revision),
      correlationId: row.correlation_id,
      acceptedAt: timestamp(row.accepted_at),
      accessVersion: revision(row.access_version),
      ...(row.outcome === "accepted" && invitationSecret !== undefined ? { invitationSecret } : {}),
    });
    const checked = result as {
      outcome: "accepted" | "replayed";
      operation: string;
      organizationId: string;
      invitationId: string;
      revision: number;
      accessVersion: number;
    };
    if (
      !sameUuid(checked.organizationId, scope.organizationId) ||
      (expected.invitationId !== undefined &&
        !sameUuid(checked.invitationId, expected.invitationId)) ||
      checked.operation !== expected.operation ||
      checked.revision !== expected.revision ||
      (checked.outcome === "accepted" && checked.accessVersion !== scope.accessVersion)
    )
      throw unavailable();
    return result;
  };

  return Object.freeze({
    async listOrganizationAccounts(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: ListOrganizationAccountsCommand,
    ): Promise<HumanOrganizationRequestResult<ListOrganizationAccountsResult>> {
      const command = listOrganizationAccountsCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, selection, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<AccountPageRow>`
            select organization_id, accounts,
              next_after_organization_account_id, access_version
            from vortex_access.list_organization_accounts_for_administration(
              ${command.data.afterOrganizationAccountId ?? null}::uuid,
              ${command.data.pageSize}::integer
            )
          `,
        );
        if (
          !matchesScope(row, scope.organizationId, scope.accessVersion) ||
          !Array.isArray(row.accounts)
        )
          throw unavailable();
        return listOrganizationAccountsResultSchema.parse({
          accounts: row.accounts.map(normalizeRevision),
          ...(row.next_after_organization_account_id === null ||
          row.next_after_organization_account_id === undefined
            ? {}
            : { nextAfterOrganizationAccountId: row.next_after_organization_account_id }),
          accessVersion: revision(row.access_version),
        });
      });
    },

    async readOrganizationAccount(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: ReadOrganizationAccountCommand,
    ): Promise<HumanOrganizationRequestResult<ReadOrganizationAccountResult>> {
      const command = readOrganizationAccountCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, selection, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<AccountDetailRow>`
            select organization_id, outcome, account_summary, access_version
            from vortex_access.read_organization_account_for_administration(
              ${command.data.organizationAccountId}::uuid
            )
          `,
        );
        if (!matchesScope(row, scope.organizationId, scope.accessVersion)) throw unavailable();
        const result = readOrganizationAccountResultSchema.parse({
          outcome: row.outcome,
          ...(row.account_summary === null || row.account_summary === undefined
            ? {}
            : { account: normalizeRevision(row.account_summary) }),
          accessVersion: revision(row.access_version),
        });
        if (
          result.outcome === "available" &&
          !sameUuid(result.account.organizationAccountId, command.data.organizationAccountId)
        )
          throw unavailable();
        return result;
      });
    },

    async listOrganizationInvitations(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: ListOrganizationInvitationsCommand,
    ): Promise<HumanOrganizationRequestResult<ListOrganizationInvitationsResult>> {
      const command = listOrganizationInvitationsCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, selection, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<InvitationPageRow>`
            select organization_id, invitations, next_after_invitation_id,
              access_version
            from vortex_access.list_organization_invitations_for_administration(
              ${command.data.afterInvitationId ?? null}::uuid,
              ${command.data.pageSize}::integer
            )
          `,
        );
        if (
          !matchesScope(row, scope.organizationId, scope.accessVersion) ||
          !Array.isArray(row.invitations)
        )
          throw unavailable();
        const result = listOrganizationInvitationsResultSchema.parse({
          invitations: row.invitations.map(normalizeInvitation),
          ...(row.next_after_invitation_id === null || row.next_after_invitation_id === undefined
            ? {}
            : { nextAfterInvitationId: row.next_after_invitation_id }),
          accessVersion: revision(row.access_version),
        });
        if (
          result.invitations.some(
            (invitation) => !sameUuid(invitation.organizationId, scope.organizationId),
          )
        )
          throw unavailable();
        return result;
      });
    },

    async readOrganizationInvitation(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: ReadOrganizationInvitationCommand,
    ): Promise<HumanOrganizationRequestResult<ReadOrganizationInvitationResult>> {
      const command = readOrganizationInvitationCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, selection, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<InvitationDetailRow>`
            select organization_id, outcome, invitation, access_version
            from vortex_access.read_organization_invitation_for_administration(
              ${command.data.invitationId}::uuid
            )
          `,
        );
        if (!matchesScope(row, scope.organizationId, scope.accessVersion)) throw unavailable();
        const result = readOrganizationInvitationResultSchema.parse({
          outcome: row.outcome,
          ...(row.invitation === null || row.invitation === undefined
            ? {}
            : { invitation: normalizeInvitation(row.invitation) }),
          accessVersion: revision(row.access_version),
        });
        if (
          result.outcome === "available" &&
          (!sameUuid(result.invitation.organizationId, scope.organizationId) ||
            !sameUuid(result.invitation.invitationId, command.data.invitationId))
        )
          throw unavailable();
        return result;
      });
    },

    async readOrganizationRuntimeSettings(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: ReadOrganizationRuntimeSettingsCommand,
    ): Promise<HumanOrganizationRequestResult<ReadOrganizationRuntimeSettingsResult>> {
      const command = readOrganizationRuntimeSettingsCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, selection, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<RuntimeSettingsRow>`
            select organization_id, outcome, settings, access_version
            from vortex_access.read_organization_runtime_settings_for_administration()
          `,
        );
        if (!matchesScope(row, scope.organizationId, scope.accessVersion)) throw unavailable();
        if (row.outcome === "unavailable")
          return readOrganizationRuntimeSettingsResultSchema.parse({
            outcome: "unavailable",
            accessVersion: revision(row.access_version),
          });
        if (typeof row.settings !== "object" || row.settings === null) throw unavailable();
        const settings = organizationRuntimeSettingsSchema.parse({
          ...row.settings,
          revision: revision((row.settings as { revision?: unknown }).revision),
        });
        if (!sameUuid(settings.organizationId, scope.organizationId)) throw unavailable();
        return readOrganizationRuntimeSettingsResultSchema.parse({
          outcome: row.outcome,
          settings,
          accessVersion: revision(row.access_version),
        });
      });
    },

    async suspendOrganizationAccount(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: SuspendOrganizationAccountCommand,
    ): Promise<HumanOrganizationRequestResult<SuspendOrganizationAccountResult>> {
      const command = suspendOrganizationAccountCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };
      return requests.runChange(session, selection, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<AccountChangeRow>`
            select * from vortex_access.suspend_organization_account_for_administration(
              ${command.data.duplicateKey}::uuid,
              ${command.data.organizationAccountId}::uuid,
              ${command.data.expectedRevision}::bigint
            )
          `,
        );
        return accountChange(
          row,
          scope,
          {
            operation: "suspend_organization_account",
            organizationAccountId: command.data.organizationAccountId,
            revision: command.data.expectedRevision + 1,
          },
          suspendOrganizationAccountResultSchema,
        );
      });
    },

    async reactivateOrganizationAccount(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: ReactivateOrganizationAccountCommand,
    ): Promise<HumanOrganizationRequestResult<ReactivateOrganizationAccountResult>> {
      const command = reactivateOrganizationAccountCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };
      return requests.runChange(session, selection, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<AccountChangeRow>`
            select * from vortex_access.reactivate_organization_account_for_administration(
              ${command.data.duplicateKey}::uuid,
              ${command.data.organizationAccountId}::uuid,
              ${command.data.expectedRevision}::bigint
            )
          `,
        );
        return accountChange(
          row,
          scope,
          {
            operation: "reactivate_organization_account",
            organizationAccountId: command.data.organizationAccountId,
            revision: command.data.expectedRevision + 1,
          },
          reactivateOrganizationAccountResultSchema,
        );
      });
    },

    async closeOrganizationAccount(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: CloseOrganizationAccountCommand,
    ): Promise<HumanOrganizationRequestResult<CloseOrganizationAccountResult>> {
      const command = closeOrganizationAccountCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };
      return requests.runChange(session, selection, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<AccountChangeRow>`
            select * from vortex_access.close_organization_account_for_administration(
              ${command.data.duplicateKey}::uuid,
              ${command.data.organizationAccountId}::uuid,
              ${command.data.expectedRevision}::bigint
            )
          `,
        );
        return accountChange(
          row,
          scope,
          {
            operation: "close_organization_account",
            organizationAccountId: command.data.organizationAccountId,
            revision: command.data.expectedRevision + 1,
          },
          closeOrganizationAccountResultSchema,
        );
      });
    },

    async updateOwnProfile(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: UpdateOwnProfileCommand,
    ): Promise<HumanOrganizationRequestResult<UpdateOwnProfileResult>> {
      const command = updateOwnProfileCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch {
        return { kind: "temporarily_unavailable" };
      }
      return requests.runChange(session, selection, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<ProfileChangeRow>`
            select outcome, operation, organization_id, organization_account_id,
              account_summary, correlation_id, accepted_at, access_version
            from vortex_access.update_own_profile(
              ${command.data.organizationAccountId}::uuid,
              ${command.data.expectedRevision}::bigint,
              ${command.data.displayName}::text,
              ${command.data.language ?? null}::text,
              ${command.data.timeZone ?? null}::text,
              ${activityId}::uuid
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          typeof row.organization_account_id !== "string" ||
          !sameUuid(row.organization_account_id, command.data.organizationAccountId) ||
          revision(row.access_version) !== scope.accessVersion
        )
          throw unavailable();
        const result = updateOwnProfileResultSchema.parse({
          outcome: row.outcome,
          operation: row.operation,
          organizationId: row.organization_id,
          organizationAccountId: row.organization_account_id,
          correlationId: row.correlation_id,
          acceptedAt: timestamp(row.accepted_at),
          accessVersion: revision(row.access_version),
          ...(row.outcome === "accepted" &&
          row.account_summary !== null &&
          row.account_summary !== undefined
            ? { account: normalizeRevision(row.account_summary) }
            : {}),
        });
        if (
          result.outcome === "accepted" &&
          (!sameUuid(result.account.organizationAccountId, command.data.organizationAccountId) ||
            result.account.revision !== command.data.expectedRevision + 1)
        )
          throw unavailable();
        return result;
      });
    },

    async createOrganizationInvitation(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: CreateOrganizationInvitationForAdministrationCommand,
    ): Promise<
      HumanOrganizationRequestResult<CreateOrganizationInvitationForAdministrationResult>
    > {
      const command =
        createOrganizationInvitationForAdministrationCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };
      return requests.runChange(session, selection, async (transaction, scope) => {
        const invitationSecret = generateInvitationSecret();
        if (Buffer.byteLength(invitationSecret, "utf8") < 32 || invitationSecret.length > 2_000)
          throw unavailable();
        const row = requireOne(
          await transaction.query<InvitationChangeRow>`
            select * from vortex_access.create_organization_invitation_for_administration(
              ${command.data.duplicateKey}::uuid,
              ${command.data.invitedEmail}::text,
              ${fingerprintSecret(invitationSecret)}::text,
              ${command.data.expiresAt}::timestamptz
            )
          `,
        );
        return invitationChange(
          row,
          scope,
          { operation: "create_organization_invitation", revision: 1 },
          createOrganizationInvitationForAdministrationResultSchema,
          invitationSecret,
        );
      });
    },

    async revokeOrganizationInvitation(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: RevokeOrganizationInvitationForAdministrationCommand,
    ): Promise<
      HumanOrganizationRequestResult<RevokeOrganizationInvitationForAdministrationResult>
    > {
      const command =
        revokeOrganizationInvitationForAdministrationCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };
      return requests.runChange(session, selection, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<InvitationChangeRow>`
            select * from vortex_access.revoke_organization_invitation_for_administration(
              ${command.data.duplicateKey}::uuid,
              ${command.data.invitationId}::uuid,
              ${command.data.expectedRevision}::bigint
            )
          `,
        );
        return invitationChange(
          row,
          scope,
          {
            operation: "revoke_organization_invitation",
            invitationId: command.data.invitationId,
            revision: command.data.expectedRevision + 1,
          },
          revokeOrganizationInvitationForAdministrationResultSchema,
        );
      });
    },
  });
};
