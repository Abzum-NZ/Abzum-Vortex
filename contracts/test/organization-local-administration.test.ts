import { describe, expect, it } from "vitest";
import {
  closeOrganizationAccountCommandSchema,
  createOrganizationInvitationForAdministrationCommandSchema,
  createOrganizationInvitationForAdministrationResultSchema,
  listOrganizationAccountsCommandSchema,
  listOrganizationAccountsResultSchema,
  listOrganizationInvitationsCommandSchema,
  readOrganizationAccountCommandSchema,
  readOrganizationInvitationCommandSchema,
  readOrganizationRuntimeSettingsCommandSchema,
  reactivateOrganizationAccountCommandSchema,
  revokeOrganizationInvitationForAdministrationCommandSchema,
  suspendOrganizationAccountCommandSchema,
} from "../src/organization-local-administration";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const nilId = "00000000-0000-0000-0000-000000000000";

describe("organisation-local administration contracts", () => {
  it("accepts only bounded local-ID account pages", () => {
    expect(
      listOrganizationAccountsCommandSchema.parse({
        pageSize: 100,
        afterOrganizationAccountId: id(1),
      }),
    ).toEqual({ pageSize: 100, afterOrganizationAccountId: id(1) });
    for (const candidate of [
      { pageSize: 0 },
      { pageSize: 101 },
      { pageSize: 1.5 },
      { pageSize: 10, afterOrganizationAccountId: nilId },
      { pageSize: 10, tenantId: id(2) },
      { pageSize: 10, sort: "displayName" },
    ])
      expect(listOrganizationAccountsCommandSchema.safeParse(candidate).success).toBe(false);
  });

  it("accepts only bounded local-ID invitation pages", () => {
    expect(
      listOrganizationInvitationsCommandSchema.parse({
        pageSize: 1,
        afterInvitationId: id(3),
      }),
    ).toEqual({ pageSize: 1, afterInvitationId: id(3) });
    for (const candidate of [
      { pageSize: -1 },
      { pageSize: 101 },
      { pageSize: 10, afterInvitationId: nilId },
      { pageSize: 10, filter: "pending" },
    ])
      expect(listOrganizationInvitationsCommandSchema.safeParse(candidate).success).toBe(false);
  });

  it("keeps detail and settings inputs exact and non-nil", () => {
    expect(readOrganizationAccountCommandSchema.parse({ organizationAccountId: id(4) })).toEqual({
      organizationAccountId: id(4),
    });
    expect(readOrganizationInvitationCommandSchema.parse({ invitationId: id(5) })).toEqual({
      invitationId: id(5),
    });
    expect(readOrganizationRuntimeSettingsCommandSchema.parse({})).toEqual({});
    expect(
      readOrganizationAccountCommandSchema.safeParse({ organizationAccountId: nilId }).success,
    ).toBe(false);
    expect(readOrganizationInvitationCommandSchema.safeParse({ invitationId: nilId }).success).toBe(
      false,
    );
    expect(readOrganizationRuntimeSettingsCommandSchema.safeParse({ clock: "now" }).success).toBe(
      false,
    );
  });

  it("rejects account projection fields outside the safe local summary", () => {
    const safeAccount = {
      organizationAccountId: id(6),
      displayName: "Local account",
      state: "active" as const,
      language: "en-NZ",
      timeZone: "Pacific/Auckland",
      revision: 2,
    };
    expect(
      listOrganizationAccountsResultSchema.parse({ accounts: [safeAccount], accessVersion: 7 }),
    ).toEqual({ accounts: [safeAccount], accessVersion: 7 });
    for (const leaked of [
      { identityId: id(7) },
      { email: "person@example.test" },
      { invitationId: id(8) },
      { permissions: [] },
      { activatedAt: "2026-09-14T00:00:00.000Z" },
    ])
      expect(
        listOrganizationAccountsResultSchema.safeParse({
          accounts: [{ ...safeAccount, ...leaked }],
          accessVersion: 7,
        }).success,
      ).toBe(false);
  });

  it("keeps each account lifecycle command exact, local and revision checked", () => {
    const command = {
      duplicateKey: id(20),
      organizationAccountId: id(21),
      expectedRevision: 3,
    };
    for (const schema of [
      suspendOrganizationAccountCommandSchema,
      reactivateOrganizationAccountCommandSchema,
      closeOrganizationAccountCommandSchema,
    ]) {
      expect(schema.parse(command)).toEqual(command);
      expect(schema.safeParse({ ...command, permission: "accounts.manage" }).success).toBe(false);
      expect(schema.safeParse({ ...command, expectedRevision: 0 }).success).toBe(false);
      expect(schema.safeParse({ ...command, organizationAccountId: nilId }).success).toBe(false);
    }
  });

  it("normalizes invitation email and forbids intent or injected authority", () => {
    expect(
      createOrganizationInvitationForAdministrationCommandSchema.parse({
        duplicateKey: id(22),
        invitedEmail: "  PERSON@Example.TEST ",
        expiresAt: "2026-09-16T00:00:00.000Z",
      }),
    ).toEqual({
      duplicateKey: id(22),
      invitedEmail: "person@example.test",
      expiresAt: "2026-09-16T00:00:00.000Z",
    });
    expect(
      createOrganizationInvitationForAdministrationCommandSchema.safeParse({
        duplicateKey: id(22),
        invitedEmail: "person@example.test",
        expiresAt: "2026-09-16T00:00:00.000Z",
        roleIntent: id(23),
      }).success,
    ).toBe(false);
    expect(
      revokeOrganizationInvitationForAdministrationCommandSchema.safeParse({
        duplicateKey: id(24),
        invitationId: id(25),
        expectedRevision: 1,
        actorId: id(26),
      }).success,
    ).toBe(false);
  });

  it("makes an invitation secret structurally impossible on replay", () => {
    const evidence = {
      operation: "create_organization_invitation" as const,
      organizationId: id(30),
      invitationId: id(31),
      revision: 1,
      correlationId: id(32),
      acceptedAt: "2026-09-14T01:00:00.000Z",
      accessVersion: 7,
    };
    expect(
      createOrganizationInvitationForAdministrationResultSchema.parse({
        outcome: "accepted",
        ...evidence,
        invitationSecret: "s".repeat(32),
      }),
    ).toMatchObject({ outcome: "accepted", invitationSecret: "s".repeat(32) });
    expect(
      createOrganizationInvitationForAdministrationResultSchema.parse({
        outcome: "replayed",
        ...evidence,
      }),
    ).toEqual({ outcome: "replayed", ...evidence });
    expect(
      createOrganizationInvitationForAdministrationResultSchema.safeParse({
        outcome: "replayed",
        ...evidence,
        invitationSecret: "s".repeat(32),
      }).success,
    ).toBe(false);
  });
});
