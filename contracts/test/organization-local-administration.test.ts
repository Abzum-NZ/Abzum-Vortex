import { describe, expect, it } from "vitest";
import {
  listOrganizationAccountsCommandSchema,
  listOrganizationAccountsResultSchema,
  listOrganizationInvitationsCommandSchema,
  readOrganizationAccountCommandSchema,
  readOrganizationInvitationCommandSchema,
  readOrganizationRuntimeSettingsCommandSchema,
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
});
