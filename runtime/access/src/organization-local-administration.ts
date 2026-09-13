import "server-only";

import {
  listOrganizationAccountsCommandSchema,
  listOrganizationAccountsResultSchema,
  listOrganizationInvitationsCommandSchema,
  listOrganizationInvitationsResultSchema,
  organizationRuntimeSettingsSchema,
  readOrganizationAccountCommandSchema,
  readOrganizationAccountResultSchema,
  readOrganizationInvitationCommandSchema,
  readOrganizationInvitationResultSchema,
  readOrganizationRuntimeSettingsCommandSchema,
  readOrganizationRuntimeSettingsResultSchema,
  type IdentitySession,
  type ListOrganizationAccountsCommand,
  type ListOrganizationAccountsResult,
  type ListOrganizationInvitationsCommand,
  type ListOrganizationInvitationsResult,
  type OrganizationSelectionCandidate,
  type ReadOrganizationAccountCommand,
  type ReadOrganizationAccountResult,
  type ReadOrganizationInvitationCommand,
  type ReadOrganizationInvitationResult,
  type ReadOrganizationRuntimeSettingsCommand,
  type ReadOrganizationRuntimeSettingsResult,
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

const matchesScope = (
  row: { organization_id: unknown; access_version: unknown },
  organizationId: string,
  accessVersion: number,
): boolean =>
  typeof row.organization_id === "string" &&
  sameUuid(row.organization_id, organizationId) &&
  revision(row.access_version) === accessVersion;

export const createOrganizationLocalAdministrationService = (
  dependencies: HumanOrganizationRequestDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);

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
  });
};
