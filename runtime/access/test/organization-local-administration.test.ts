import type {
  DatabaseRow,
  DatabaseValue,
  RequestDatabaseTransaction,
  RuntimeDatabaseTransaction,
} from "@vortex/db";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationLocalAdministrationService } from "../src/organization-local-administration";

vi.mock("server-only", () => ({}));

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const selectedScope = {
  tenant_id: id(1),
  organization_id: id(2),
  organization_account_id: id(3),
  access_version: "7",
};
const verifiedSession = {
  identityId: id(4),
  sessionId: id(5),
  authenticationStrength: "multi_factor" as const,
  accessTokenIssuedAt: "2026-09-14T00:00:00.000Z",
  accessTokenExpiresAt: "2026-09-14T02:00:00.000Z",
};

const serviceFor = (rows: readonly DatabaseRow[], invitationSecret = "s".repeat(43)) => {
  const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
  const service = createOrganizationLocalAdministrationService({
    identityAuthorityId: id(6),
    clock: () => new Date("2026-09-14T01:00:00.000Z"),
    correlationId: () => id(7),
    generateInvitationSecret: () => invitationSecret,
    resolvedRequestTransaction: async (resolve, operation) => {
      const resolved = await resolve({
        query: async () => [selectedScope] as never,
      } satisfies RuntimeDatabaseTransaction);
      const transaction: RequestDatabaseTransaction = {
        query: async <Row extends DatabaseRow>(
          strings: TemplateStringsArray,
          ...values: readonly DatabaseValue[]
        ) => {
          calls.push({ text: strings.join("$value"), values });
          return rows as readonly Row[];
        },
      };
      return operation(transaction, resolved.scope);
    },
  });
  return { calls, service };
};

const invitation = (invitationId: string, organizationId = id(2)) => ({
  invitationId,
  organizationId,
  invitedEmail: "person@example.test",
  invitedBy: id(3),
  createdAt: new Date("2026-09-14T00:00:00.000Z"),
  invitedAt: "2026-09-14T00:00:00.000Z",
  expiresAt: "2026-09-15T00:00:00.000Z",
  changedAt: "2026-09-14T00:00:00.000Z",
  revision: "1",
});

describe("organisation-local administration service", () => {
  it("lists a bounded safe account page through the fixed database wrapper", async () => {
    const { calls, service } = serviceFor([
      {
        organization_id: id(2).toUpperCase(),
        accounts: [
          {
            organizationAccountId: id(8).toUpperCase(),
            displayName: "Closed account",
            state: "closed",
            language: "en-NZ",
            timeZone: "Pacific/Auckland",
            revision: "4",
          },
        ],
        next_after_organization_account_id: id(8),
        access_version: 7n,
      },
    ]);

    await expect(
      service.listOrganizationAccounts(
        verifiedSession,
        { organizationId: id(2) },
        { pageSize: 1, afterOrganizationAccountId: id(3) },
      ),
    ).resolves.toEqual({
      kind: "available",
      value: {
        accounts: [
          {
            organizationAccountId: id(8).toUpperCase(),
            displayName: "Closed account",
            state: "closed",
            language: "en-NZ",
            timeZone: "Pacific/Auckland",
            revision: 4,
          },
        ],
        nextAfterOrganizationAccountId: id(8),
        accessVersion: 7,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("list_organization_accounts_for_administration");
    expect(calls[0]?.values).toEqual([id(3), 1]);
  });

  it("returns the same unavailable account result for absent and foreign local IDs", async () => {
    const { service } = serviceFor([
      {
        organization_id: id(2),
        outcome: "unavailable",
        account_summary: null,
        access_version: 7,
      },
    ]);
    await expect(
      service.readOrganizationAccount(
        verifiedSession,
        { organizationId: id(2) },
        { organizationAccountId: id(99) },
      ),
    ).resolves.toEqual({
      kind: "available",
      value: { outcome: "unavailable", accessVersion: 7 },
    });
  });

  it("lists invitation lifecycle facts without accepting private fields", async () => {
    const { calls, service } = serviceFor([
      {
        organization_id: id(2),
        invitations: [invitation(id(10))],
        next_after_invitation_id: null,
        access_version: "7",
      },
    ]);
    await expect(
      service.listOrganizationInvitations(
        verifiedSession,
        { organizationId: id(2) },
        { pageSize: 10 },
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: {
        invitations: [
          {
            invitationId: id(10),
            invitedEmail: "person@example.test",
            createdAt: "2026-09-14T00:00:00.000Z",
            revision: 1,
          },
        ],
        accessVersion: 7,
      },
    });
    expect(calls[0]?.text).toContain("list_organization_invitations_for_administration");

    const leaked = serviceFor([
      {
        organization_id: id(2),
        invitations: [{ ...invitation(id(10)), tokenFingerprint: `sha256:${"a".repeat(64)}` }],
        next_after_invitation_id: null,
        access_version: 7,
      },
    ]).service;
    await expect(
      leaked.listOrganizationInvitations(
        verifiedSession,
        { organizationId: id(2) },
        { pageSize: 10 },
      ),
    ).resolves.toEqual({ kind: "temporarily_unavailable" });
  });

  it("rejects malformed or cross-scope database results", async () => {
    const foreignInvitation = serviceFor([
      {
        organization_id: id(2),
        outcome: "available",
        invitation: invitation(id(10), id(20)),
        access_version: 7,
      },
    ]).service;
    await expect(
      foreignInvitation.readOrganizationInvitation(
        verifiedSession,
        { organizationId: id(2) },
        { invitationId: id(10) },
      ),
    ).resolves.toEqual({ kind: "temporarily_unavailable" });

    const leakedAccount = serviceFor([
      {
        organization_id: id(2),
        outcome: "available",
        account_summary: {
          organizationAccountId: id(8),
          state: "active",
          revision: 1,
          identityId: id(4),
        },
        access_version: 7,
      },
    ]).service;
    await expect(
      leakedAccount.readOrganizationAccount(
        verifiedSession,
        { organizationId: id(2) },
        { organizationAccountId: id(8) },
      ),
    ).resolves.toEqual({ kind: "temporarily_unavailable" });
  });

  it("returns explicit runtime-settings presence and absence", async () => {
    const present = serviceFor([
      {
        organization_id: id(2),
        outcome: "available",
        settings: {
          organizationId: id(2),
          language: "en-NZ",
          timeZone: "Pacific/Auckland",
          currency: "NZD",
          dateFormat: "medium",
          numberFormat: "auto",
          revision: "3",
        },
        access_version: 7,
      },
    ]).service;
    await expect(
      present.readOrganizationRuntimeSettings(verifiedSession, { organizationId: id(2) }, {}),
    ).resolves.toMatchObject({
      kind: "available",
      value: { outcome: "available", settings: { currency: "NZD", revision: 3 } },
    });

    const absent = serviceFor([
      {
        organization_id: id(2),
        outcome: "unavailable",
        settings: null,
        access_version: 7,
      },
    ]).service;
    await expect(
      absent.readOrganizationRuntimeSettings(verifiedSession, { organizationId: id(2) }, {}),
    ).resolves.toEqual({
      kind: "available",
      value: { outcome: "unavailable", accessVersion: 7 },
    });
  });

  it("rejects extra filters and settings authority before opening a transaction", async () => {
    let opened = false;
    const service = createOrganizationLocalAdministrationService({
      identityAuthorityId: id(6),
      resolvedRequestTransaction: async () => {
        opened = true;
        throw new Error("must not run");
      },
    });
    await expect(
      service.listOrganizationAccounts(verifiedSession, { organizationId: id(2) }, {
        pageSize: 10,
        state: "active",
      } as never),
    ).resolves.toEqual({ kind: "unavailable" });
    await expect(
      service.readOrganizationRuntimeSettings(verifiedSession, { organizationId: id(2) }, {
        permission: "runtime_settings.manage",
      } as never),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(opened).toBe(false);
  });

  it("runs each account lifecycle through its one fixed protected wrapper", async () => {
    const operations = [
      ["suspendOrganizationAccount", "suspend_organization_account", 8],
      ["reactivateOrganizationAccount", "reactivate_organization_account", 9],
      ["closeOrganizationAccount", "close_organization_account", 10],
    ] as const;
    for (const [method, operation, target] of operations) {
      const { calls, service } = serviceFor([
        {
          outcome: "accepted",
          operation,
          organization_id: id(2),
          organization_account_id: id(target),
          revision: "3",
          correlation_id: id(40 + target),
          accepted_at: new Date("2026-09-14T01:00:00.000Z"),
          access_version: "8",
        },
      ]);
      await expect(
        service[method](
          verifiedSession,
          { organizationId: id(2) },
          {
            duplicateKey: id(30 + target),
            organizationAccountId: id(target),
            expectedRevision: 2,
          },
        ),
      ).resolves.toMatchObject({
        kind: "available",
        value: {
          outcome: "accepted",
          operation,
          organizationId: id(2),
          organizationAccountId: id(target),
          revision: 3,
          accessVersion: 8,
        },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.text).toContain(`${operation}_for_administration`);
      expect(calls[0]?.values).toEqual([id(30 + target), id(target), 2]);
    }
  });

  it("returns a secret only for the first committed invitation creation result", async () => {
    const evidence = {
      operation: "create_organization_invitation",
      organization_id: id(2),
      invitation_id: id(50),
      revision: 1,
      correlation_id: id(51),
      accepted_at: new Date("2026-09-14T01:00:00.000Z"),
      access_version: 7,
    };
    const command = {
      duplicateKey: id(52),
      invitedEmail: "  PERSON@Example.TEST ",
      expiresAt: "2026-09-15T00:00:00.000Z",
    };
    const accepted = serviceFor([{ outcome: "accepted", ...evidence }], "a".repeat(43));
    await expect(
      accepted.service.createOrganizationInvitation(
        verifiedSession,
        { organizationId: id(2) },
        command,
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: { outcome: "accepted", invitationSecret: "a".repeat(43) },
    });
    expect(accepted.calls[0]?.values[1]).toBe("person@example.test");
    expect(accepted.calls[0]?.values[2]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(accepted.calls[0]?.values).not.toContain("a".repeat(43));

    const replayed = serviceFor([{ outcome: "replayed", ...evidence }], "b".repeat(43));
    await expect(
      replayed.service.createOrganizationInvitation(
        verifiedSession,
        { organizationId: id(2) },
        command,
      ),
    ).resolves.toEqual({
      kind: "available",
      value: {
        outcome: "replayed",
        operation: "create_organization_invitation",
        organizationId: id(2),
        invitationId: id(50),
        revision: 1,
        correlationId: id(51),
        acceptedAt: "2026-09-14T01:00:00.000Z",
        accessVersion: 7,
      },
    });
  });

  it("revokes only through the fixed invitation wrapper and validates stored evidence", async () => {
    const { calls, service } = serviceFor([
      {
        outcome: "accepted",
        operation: "revoke_organization_invitation",
        organization_id: id(2),
        invitation_id: id(60),
        revision: 4n,
        correlation_id: id(61),
        accepted_at: "2026-09-14T01:00:00.000Z",
        access_version: 7n,
      },
    ]);
    await expect(
      service.revokeOrganizationInvitation(
        verifiedSession,
        { organizationId: id(2) },
        { duplicateKey: id(62), invitationId: id(60), expectedRevision: 3 },
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: { outcome: "accepted", invitationId: id(60), revision: 4, accessVersion: 7 },
    });
    expect(calls[0]?.text).toContain("revoke_organization_invitation_for_administration");
    expect(calls[0]?.values).toEqual([id(62), id(60), 3]);

    const malformed = serviceFor([
      {
        outcome: "accepted",
        operation: "revoke_organization_invitation",
        organization_id: id(99),
        invitation_id: id(60),
        revision: 4,
        correlation_id: id(61),
        accepted_at: "2026-09-14T01:00:00.000Z",
        access_version: 7,
      },
    ]).service;
    await expect(
      malformed.revokeOrganizationInvitation(
        verifiedSession,
        { organizationId: id(2) },
        { duplicateKey: id(62), invitationId: id(60), expectedRevision: 3 },
      ),
    ).resolves.toEqual({ kind: "temporarily_unavailable" });
  });
});
